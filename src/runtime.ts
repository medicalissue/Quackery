import type {
  DecompositionDecision,
  NodeContext,
  NodePlan,
  NodeResult,
  NodeSuccess,
  SplitDecision,
} from "./model.js"
import { RunGraph } from "./graph.js"
import {
  assertBalancedSplit,
  assertDisjointOwnership,
  assertOwnershipWithinParent,
  assertWorldWiring,
  type BalancePolicy,
} from "./validation.js"

export interface RuntimeLimits {
  maxDepth: number
  maxNodes: number
}

export interface RuntimePolicy extends BalancePolicy, RuntimeLimits {}

export interface ExecutionAdapter {
  decompose(node: NodeContext): Promise<DecompositionDecision>
  commitBoundary(node: NodeContext, decision: DecompositionDecision): Promise<string>
  forkChild(parent: NodeContext, boundaryCommit: string, plan: NodePlan): Promise<NodeContext>
  runLeaf(node: NodeContext, boundaryCommit: string): Promise<NodeResult>
  join(node: NodeContext, boundaryCommit: string, children: NodeSuccess[], decision: SplitDecision): Promise<NodeResult>
}

export class RecursiveRuntime {
  private nodeCount = 1

  constructor(
    readonly graph: RunGraph,
    private readonly adapter: ExecutionAdapter,
    private readonly policy: RuntimePolicy,
  ) {}

  async execute(root: NodeContext): Promise<NodeResult> {
    const result = await this.executeNode(root)
    if (result.ok) this.graph.finish(result.headCommit)
    else this.graph.fail()
    return result
  }

  private async executeNode(node: NodeContext): Promise<NodeResult> {
    if (node.depth > this.policy.maxDepth) {
      return this.failed(node, `Maximum graph depth ${this.policy.maxDepth} exceeded`)
    }

    if (node.plan?.kind === "leaf") {
      this.graph.transition(node.id, "implementing")
      try {
        const result = await this.adapter.runLeaf(node, node.baseCommit)
        this.recordResult(node, result)
        return result
      } catch (error) {
        return this.failed(node, "Surgeon execution failed", error)
      }
    }

    this.graph.transition(node.id, "decomposing")

    let decision: DecompositionDecision
    try {
      decision = await this.adapter.decompose(node)
    } catch (error) {
      return this.failed(node, "Decomposition failed", error)
    }

    if (decision.kind === "refuse") {
      this.graph.transition(node.id, "refused", { failure: decision.reason })
      return {
        ok: false,
        nodeId: node.id,
        reason: decision.reason,
        detail: decision.detail,
        actualDepth: 0,
      }
    }

    try {
      if (decision.kind === "split") this.validateSplit(node, decision)
      else this.validateLeaf(node, decision.leaf)
    } catch (error) {
      return this.failed(node, "Invalid split contract", error)
    }

    let boundaryCommit: string
    try {
      boundaryCommit = await this.adapter.commitBoundary(node, decision)
      node.boundaryCommit = boundaryCommit
      this.graph.transition(node.id, "boundary", { boundaryCommit })
    } catch (error) {
      return this.failed(node, "Boundary commit failed", error)
    }

    if (decision.kind === "leaf") {
      node.plan = decision.leaf
      this.graph.transition(node.id, "implementing", {
        estimatedRemainingDepth: decision.leaf.estimatedRemainingDepth,
        estimatedWork: decision.leaf.estimatedWork,
      })
      try {
        const result = await this.adapter.runLeaf(node, boundaryCommit)
        this.recordResult(node, result)
        return result
      } catch (error) {
        return this.failed(node, "Surgeon execution failed", error)
      }
    }

    const childContexts: NodeContext[] = []
    try {
      for (const plan of decision.children) {
        if (this.nodeCount >= this.policy.maxNodes) {
          throw new Error(`Maximum node count ${this.policy.maxNodes} exceeded`)
        }
        this.nodeCount += 1
        const child = await this.adapter.forkChild(node, boundaryCommit, plan)
        childContexts.push(child)
        this.graph.add(child)
      }
    } catch (error) {
      return this.failed(node, "Child worktree creation failed", error)
    }

    const childResults = await Promise.all(childContexts.map((child) => this.executeNode(child)))
    const failed = childResults.find((result) => !result.ok)
    if (failed && !failed.ok) {
      return this.failed(node, `Child ${failed.nodeId} failed: ${failed.reason}`)
    }

    this.graph.transition(node.id, "joining")
    const integrationPlan = decision.join.integration
    const integrationNode = integrationPlan ? {
      id: `${node.id}/integration`,
      parentId: node.id,
      depth: node.depth + 1,
      role: "integration-surgeon" as const,
      scope: integrationPlan.scope,
      plan: integrationPlan,
      worktree: node.worktree,
      baseCommit: boundaryCommit,
    } : undefined
    if (integrationNode) {
      this.graph.add(integrationNode)
      this.graph.transition(integrationNode.id, "implementing")
    }
    try {
      const result = await this.adapter.join(
        node,
        boundaryCommit,
        childResults.filter((result): result is NodeSuccess => result.ok),
        decision,
      )
      const actualDepth = 1 + Math.max(0, ...childResults.map((result) => result.actualDepth))
      result.actualDepth = actualDepth
      if (integrationNode) {
        this.graph.transition(integrationNode.id, result.ok ? "verified" : "failed", {
          ...(result.ok ? { headCommit: result.headCommit } : { failure: result.reason }),
        })
      }
      this.recordResult(node, result)
      return result
    } catch (error) {
      if (integrationNode) {
        this.graph.transition(integrationNode.id, "failed", {
          failure: error instanceof Error ? error.message : String(error),
        })
      }
      return this.failed(node, "Recursive join failed", error)
    }
  }

  private validateSplit(node: NodeContext, decision: SplitDecision): void {
    assertBalancedSplit(decision, this.policy)
    assertDisjointOwnership(decision.children, decision.join.integration?.owns ?? [])
    assertWorldWiring(node.plan, decision.children)
    if (node.plan) {
      for (const child of decision.children) {
        assertOwnershipWithinParent(node.plan.owns, child.owns, child.id)
      }
      if (decision.join.integration) {
        assertOwnershipWithinParent(node.plan.owns, decision.join.integration.owns, decision.join.integration.id)
      }
      const parentExport = node.plan.exports[0]
      const realizedExport = decision.join.integration?.exports[0]
        ?? decision.children.find((child) => child.exports[0] === parentExport)?.exports[0]
      if (realizedExport !== parentExport) {
        throw new Error(`Split does not realize inherited export ${parentExport}`)
      }
    }
    const integration = decision.join.integration
    if (integration) {
      const available = new Set([
        ...decision.children.map((child) => child.exports[0]).filter(Boolean),
        ...(node.plan?.imports ?? []),
      ])
      for (const imported of integration.imports) {
        if (!available.has(imported)) throw new Error(`Integration imports unresolved interface ${imported}`)
      }
    }
  }

  private validateLeaf(node: NodeContext, leaf: NodePlan): void {
    if (!node.plan) return
    if (
      leaf.exports[0] !== node.plan.exports[0]
      || JSON.stringify([...leaf.imports].sort()) !== JSON.stringify([...node.plan.imports].sort())
      || leaf.world.witPath !== node.plan.world.witPath
      || leaf.world.world !== node.plan.world.world
    ) {
      throw new Error(`Leaf ${leaf.id} changes its inherited abstract world`)
    }
    assertOwnershipWithinParent(node.plan.owns, leaf.owns, leaf.id)
  }

  private recordResult(node: NodeContext, result: NodeResult): void {
    if (result.ok) {
      this.graph.transition(node.id, "verified", { headCommit: result.headCommit })
    } else {
      this.graph.transition(node.id, "failed", { failure: result.reason })
    }
  }

  private failed(node: NodeContext, reason: string, error?: unknown): NodeResult {
    const detail = error instanceof Error ? error.message : error === undefined ? undefined : String(error)
    this.graph.transition(node.id, "failed", { failure: detail ? `${reason}: ${detail}` : reason })
    return {
      ok: false,
      nodeId: node.id,
      reason,
      ...(detail ? { detail } : {}),
      actualDepth: 0,
    }
  }
}
