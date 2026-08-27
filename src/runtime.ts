import type {
  DecompositionDecision,
  GraphNodeState,
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
  maxNeedsNurseBounces: number
}

export interface RuntimePolicy extends BalancePolicy, RuntimeLimits {}

export function assertSplitContract(
  parentPlan: NodePlan | undefined,
  decision: SplitDecision,
  policy: BalancePolicy,
): void {
  const childIds = decision.children.map((child) => child.id)
  if (new Set(childIds).size !== childIds.length) throw new Error("Split child IDs must be unique")
  if (decision.join.integration && childIds.includes(decision.join.integration.id)) {
    throw new Error("Integration ID must not collide with a child ID")
  }
  assertBalancedSplit(decision, policy)
  assertDisjointOwnership(decision.children, decision.join.integration?.owns ?? [])
  assertWorldWiring(parentPlan, decision.children)
  if (parentPlan) {
    for (const child of decision.children) {
      assertOwnershipWithinParent(parentPlan.owns, child.owns, child.id)
    }
    if (decision.join.integration) {
      assertOwnershipWithinParent(parentPlan.owns, decision.join.integration.owns, decision.join.integration.id)
    }
    const parentExport = parentPlan.exports[0]
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
      ...(parentPlan?.imports ?? []),
    ])
    for (const imported of integration.imports) {
      if (!available.has(imported)) throw new Error(`Integration imports unresolved interface ${imported}`)
    }
  }
}

export interface ExecutionAdapter {
  decompose(node: NodeContext): Promise<DecompositionDecision>
  commitBoundary(node: NodeContext, decision: DecompositionDecision): Promise<string>
  forkChild(parent: NodeContext, boundaryCommit: string, plan: NodePlan): Promise<NodeContext>
  runLeaf(node: NodeContext, boundaryCommit: string): Promise<NodeResult>
  prepareNeedsNurse(node: NodeContext): Promise<void | string>
  prepareJoin?(node: NodeContext, children: NodeSuccess[]): Promise<string>
  join(
    node: NodeContext,
    boundaryCommit: string,
    children: NodeSuccess[],
    decision: SplitDecision,
    integration?: NodeSuccess,
  ): Promise<NodeResult>
}

export class RecursiveRuntime {
  private nodeCount = 1
  private readonly needsNurseBounces = new Map<string, number>()

  constructor(
    readonly graph: RunGraph,
    private readonly adapter: ExecutionAdapter,
    private readonly policy: RuntimePolicy,
  ) {}

  async executeRoot(root: NodeContext, decision: SplitDecision, boundaryCommit: string): Promise<NodeResult> {
    let result: NodeResult
    try {
      assertSplitContract(undefined, decision, this.policy)
      root.boundaryCommit = boundaryCommit
      this.graph.transition(root.id, "boundary", { boundaryCommit })
      result = await this.executeSplit(root, decision, boundaryCommit)
    } catch (error) {
      result = this.failed(root, "Invalid root contract", error)
    }
    if (result.ok) this.graph.finish(result.headCommit)
    else this.graph.fail()
    return result
  }

  private async executeNode(node: NodeContext, forceDecompose = false): Promise<NodeResult> {
    if (node.depth > this.policy.maxDepth) {
      return this.failed(node, `Maximum graph depth ${this.policy.maxDepth} exceeded`)
    }

    if (node.plan?.kind === "leaf" && !forceDecompose) {
      return this.executeLeaf(node, node.baseCommit)
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
      if (decision.kind === "split") assertSplitContract(node.plan, decision, this.policy)
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
      return this.delegateLeaf(node, decision.leaf, boundaryCommit)
    }

    return this.executeSplit(node, decision, boundaryCommit)
  }

  private async executeSplit(
    node: NodeContext,
    decision: SplitDecision,
    boundaryCommit: string,
  ): Promise<NodeResult> {
    const childPromises: Promise<NodeResult>[] = []
    try {
      for (const plan of decision.children) {
        if (this.nodeCount >= this.policy.maxNodes) {
          throw new Error(`Maximum node count ${this.policy.maxNodes} exceeded`)
        }
        this.nodeCount += 1
        const child = await this.adapter.forkChild(node, boundaryCommit, plan)
        this.graph.add(child)
        // Start a child as soon as its worktree is ready. The next worktree may
        // still be created sequentially for Git safety without becoming a
        // decomposition barrier for this child.
        childPromises.push(this.executeNode(child))
      }
    } catch (error) {
      await Promise.allSettled(childPromises)
      return this.failed(node, "Child worktree creation failed", error)
    }

    const childResults = await Promise.all(childPromises)
    const failed = childResults.find((result) => !result.ok)
    if (failed && !failed.ok) {
      return this.failed(node, `Child ${failed.nodeId} failed: ${failed.reason}`, failed.detail)
    }

    this.graph.transition(node.id, "joining")
    let joinBase: string
    try {
      joinBase = this.adapter.prepareJoin
        ? await this.adapter.prepareJoin(node, childResults.filter((result): result is NodeSuccess => result.ok))
        : boundaryCommit
    } catch (error) {
      return this.failed(node, "Child result composition failed", error)
    }
    const integrationPlan = decision.join.integration
    let integrationResult: NodeSuccess | undefined
    let integrationNode: NodeContext | undefined
    if (integrationPlan) {
      if (this.nodeCount >= this.policy.maxNodes) {
        return this.failed(node, `Maximum node count ${this.policy.maxNodes} exceeded before integration`)
      }
      this.nodeCount += 1
      try {
        integrationNode = await this.adapter.forkChild(node, joinBase, { ...integrationPlan, id: "integration" })
      } catch (error) {
        return this.failed(node, "Integration worktree creation failed", error)
      }
      delete integrationNode.cache
      this.graph.add(integrationNode)
      const result = await this.executeNode(integrationNode)
      if (!result.ok) {
        return this.failed(node, `Integration ${integrationNode.id} failed: ${result.reason}`)
      }
      integrationResult = result
    }
    try {
      const result = await this.adapter.join(
        node,
        boundaryCommit,
        childResults.filter((result): result is NodeSuccess => result.ok),
        decision,
        integrationResult,
      )
      const actualDepth = 1 + Math.max(
        0,
        ...childResults.map((result) => result.actualDepth),
        integrationResult?.actualDepth ?? 0,
      )
      result.actualDepth = actualDepth
      this.recordResult(node, result)
      return result
    } catch (error) {
      return this.failed(node, "Recursive join failed", error)
    }
  }

  private async delegateLeaf(node: NodeContext, plan: NodePlan, boundaryCommit: string): Promise<NodeResult> {
    if (this.nodeCount >= this.policy.maxNodes) {
      return this.failed(node, `Maximum node count ${this.policy.maxNodes} exceeded before Surgeon handoff`)
    }
    this.nodeCount += 1
    let surgeon: NodeContext
    try {
      surgeon = await this.adapter.forkChild(node, boundaryCommit, plan)
    } catch (error) {
      return this.failed(node, "Surgeon worktree creation failed", error)
    }
    if (surgeon.role !== "surgeon") {
      return this.failed(node, `Nurse LEAF handoff ${plan.id} did not create a Surgeon`)
    }
    this.graph.add(surgeon)
    const result = await this.executeNode(surgeon)
    if (!result.ok) return this.failed(node, `Surgeon ${result.nodeId} failed: ${result.reason}`, result.detail)
    this.graph.transition(node.id, "joining")
    const delegated: NodeSuccess = {
      ...result,
      nodeId: node.id,
      baseCommit: node.baseCommit,
      actualDepth: 1 + result.actualDepth,
    }
    this.recordResult(node, delegated)
    return delegated
  }

  private async executeLeaf(
    node: NodeContext,
    boundaryCommit: string,
    patch: Partial<GraphNodeState> = {},
  ): Promise<NodeResult> {
    this.graph.transition(node.id, "implementing", {
      ...patch,
    })
    let result: NodeResult
    try {
      result = await this.adapter.runLeaf(node, boundaryCommit)
    } catch (error) {
      return this.failed(node, "Surgeon execution failed", error)
    }
    if (!result.ok && result.reason === "NEEDS_NURSE") {
      const bounces = this.needsNurseBounces.get(node.id) ?? 0
      if (bounces < this.policy.maxNeedsNurseBounces) {
        try {
          const recoverableCommit = await this.adapter.prepareNeedsNurse(node)
          if (recoverableCommit) {
            this.graph.transition(node.id, "implementing", { recoverableCommit })
          }
        } catch (error) {
          return this.failed(node, "Failed to preserve Surgeon attempt before Nurse bounce", error)
        }
        this.needsNurseBounces.set(node.id, bounces + 1)
        node.role = "nurse"
        this.graph.transition(node.id, "decomposing", { role: "nurse" })
        return this.executeNode(node, true)
      }
    }
    this.recordResult(node, result)
    return result
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
      this.graph.transition(node.id, "verified", {
        headCommit: result.headCommit,
        ...(result.usage ? { usage: result.usage } : {}),
      })
    } else {
      this.graph.transition(node.id, "failed", {
        failure: result.reason,
        ...(result.recoverableCommit ? { recoverableCommit: result.recoverableCommit } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      })
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
