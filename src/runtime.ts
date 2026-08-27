import type {
  DecompositionDecision,
  GraphNodeState,
  NodeContext,
  NodePlan,
  NodeResult,
  NodeSuccess,
  SplitDecision,
  VerificationEvidence,
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
  maxLeafAttempts?: number
  maxDecompositionAttempts?: number
  maxJoinAttempts?: number
  maxConcurrency?: number
  maxObservedCost?: number
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
  reviseDecomposition?(node: NodeContext, error: Error, attempt: number): Promise<DecompositionDecision>
  commitBoundary(node: NodeContext, decision: DecompositionDecision): Promise<string>
  forkChild(parent: NodeContext, boundaryCommit: string, plan: NodePlan): Promise<NodeContext>
  runLeaf(node: NodeContext, boundaryCommit: string): Promise<NodeResult>
  prepareNeedsNurse(node: NodeContext): Promise<void | string>
  prepareRetry?(node: NodeContext, failure: NodeResult, nextAttempt: number): Promise<void>
  telemetry?(node: NodeContext): Pick<NodeResult, "usage" | "evidence">
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

    const maxAttempts = this.policy.maxDecompositionAttempts ?? 2
    let decision: DecompositionDecision | undefined
    let boundaryCommit: string | undefined
    let correction: Error | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      node.attempt = attempt
      this.graph.transition(node.id, "decomposing", { attempts: attempt })
      try {
        decision = correction && this.adapter.reviseDecomposition
          ? await this.adapter.reviseDecomposition(node, correction, attempt)
          : await this.adapter.decompose(node)
        if (decision.kind === "refuse") {
          const telemetry = this.adapter.telemetry?.(node)
          this.graph.transition(node.id, "refused", {
            failure: decision.reason,
            attempts: attempt,
            ...(telemetry?.usage ? { usage: telemetry.usage } : {}),
            ...(telemetry?.evidence?.length ? { evidence: telemetry.evidence } : {}),
          })
          return {
            ok: false,
            nodeId: node.id,
            reason: decision.reason,
            detail: decision.detail,
            actualDepth: 0,
            ...(telemetry?.usage ? { usage: telemetry.usage } : {}),
            ...(telemetry?.evidence?.length ? { evidence: telemetry.evidence } : {}),
          }
        }
        if (decision.kind === "split") assertSplitContract(node.plan, decision, this.policy)
        else this.validateLeaf(node, decision.leaf)
        boundaryCommit = await this.adapter.commitBoundary(node, decision)
        node.boundaryCommit = boundaryCommit
        this.graph.transition(node.id, "boundary", { boundaryCommit, attempts: attempt })
        break
      } catch (error) {
        correction = error instanceof Error ? error : new Error(String(error))
        if (attempt === maxAttempts || !this.adapter.reviseDecomposition) {
          return this.failed(node, decision ? "Boundary contract failed" : "Decomposition failed", correction)
        }
      }
    }
    if (!decision || !boundaryCommit) return this.failed(node, "Decomposition produced no boundary")

    if (decision.kind === "leaf") {
      return this.delegateLeaf(node, decision.leaf, boundaryCommit)
    }
    if (decision.kind === "split") return this.executeSplit(node, decision, boundaryCommit)
    return this.failed(node, "Decomposition returned a refusal after boundary creation")
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
        integrationNode = await this.adapter.forkChild(node, joinBase, integrationPlan)
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
    const successfulChildren = childResults.filter((result): result is NodeSuccess => result.ok)
    const maxJoinAttempts = this.policy.maxJoinAttempts ?? 2
    const priorEvidence: NonNullable<NodeResult["evidence"]> = []
    let currentIntegration = integrationResult
    let repairDepth = integrationResult?.actualDepth ?? 0
    for (let attempt = 1; attempt <= maxJoinAttempts; attempt += 1) {
      node.attempt = attempt
      this.graph.transition(node.id, "joining", { attempts: attempt })
      let result: NodeResult
      try {
        result = await this.adapter.join(node, boundaryCommit, successfulChildren, decision, currentIntegration)
      } catch (error) {
        return this.failed(node, "Recursive join failed", error)
      }
      result.evidence = [...new Map([
        ...priorEvidence,
        ...successfulChildren.flatMap((child) => child.evidence),
        ...(currentIntegration?.evidence ?? []),
        ...(result.evidence ?? []),
      ].map((item) => [JSON.stringify(item), item])).values()]
      priorEvidence.splice(0, priorEvidence.length, ...result.evidence)
      result.actualDepth = 1 + Math.max(
        0,
        ...successfulChildren.map((child) => child.actualDepth),
        repairDepth,
      )
      if (result.ok || result.reason !== "JOIN_VERIFICATION_FAILED" || !integrationPlan || attempt === maxJoinAttempts) {
        this.recordResult(node, result)
        return result
      }
      if (!result.recoverableCommit) {
        return this.failed(node, "Join repair has no recoverable integration commit", undefined, priorEvidence)
      }
      if (this.nodeCount >= this.policy.maxNodes) {
        return this.failed(node, `Maximum node count ${this.policy.maxNodes} exceeded before join repair`, undefined, priorEvidence)
      }
      this.nodeCount += 1
      let repairId = `integration-repair-${attempt}`
      let suffix = 1
      while (this.graph.snapshot.nodes.some((candidate) => candidate.id === `${node.id}/${repairId}`)) {
        repairId = `integration-repair-${attempt}-${suffix++}`
      }
      const repairPlan: NodePlan = {
        ...integrationPlan,
        id: repairId,
        kind: "scope",
        scope: `Repair ${node.scope} join acceptance without rerunning completed children`,
        estimatedRemainingDepth: Math.max(1, integrationPlan.estimatedRemainingDepth),
      }
      let repairNode: NodeContext
      try {
        repairNode = await this.adapter.forkChild(node, result.recoverableCommit, repairPlan)
      } catch (error) {
        return this.failed(node, "Join repair worktree creation failed", error, priorEvidence)
      }
      delete repairNode.cache
      repairNode.repair = { reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) }
      this.graph.add(repairNode)
      const repaired = await this.executeNode(repairNode)
      if (!repaired.ok) {
        return this.failed(
          node,
          `Join repair ${repairNode.id} failed: ${repaired.reason}`,
          repaired.detail,
          [...priorEvidence, ...(repaired.evidence ?? [])],
        )
      }
      currentIntegration = repaired
      repairDepth = Math.max(repairDepth, repaired.actualDepth)
    }
    return this.failed(node, "Join repair exhausted without a result", undefined, priorEvidence)
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
    const maxAttempts = this.policy.maxLeafAttempts ?? 2
    let result: NodeResult | undefined
    const attemptEvidence: VerificationEvidence[] = []
    const seenEvidence = new Set<string>()
    let recoverableCommit: string | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      node.attempt = attempt
      this.graph.transition(node.id, "implementing", {
        ...patch,
        attempts: attempt,
        ...(node.modelOverride
          ? { model: `${node.modelOverride.providerID}/${node.modelOverride.modelID}${node.modelOverride.variant ? `#${node.modelOverride.variant}` : ""}` }
          : {}),
      })
      try {
        result = await this.adapter.runLeaf(node, boundaryCommit)
      } catch (error) {
        const telemetry = this.adapter.telemetry?.(node)
        result = {
          ok: false,
          nodeId: node.id,
          reason: "SURGEON_EXECUTION_FAILED",
          detail: error instanceof Error ? error.message : String(error),
          actualDepth: 0,
          ...(telemetry?.usage ? { usage: telemetry.usage } : {}),
          ...(telemetry?.evidence?.length ? { evidence: telemetry.evidence } : {}),
        }
      }
      for (const evidence of result.evidence ?? []) {
        const key = JSON.stringify(evidence)
        if (!seenEvidence.has(key)) {
          seenEvidence.add(key)
          attemptEvidence.push(evidence)
        }
      }
      recoverableCommit = result.ok ? recoverableCommit : result.recoverableCommit ?? recoverableCommit
      if (result.ok) break
      const retryable = ["SURGEON_EXECUTION_FAILED", "VERIFICATION_FAILED"].includes(result.reason)
      if (!retryable || attempt === maxAttempts) break
      node.repair = {
        reason: result.reason,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.evidence?.length ? { evidence: result.evidence } : {}),
      }
      try {
        await this.adapter.prepareRetry?.(node, result, attempt + 1)
      } catch (error) {
        return this.failed(node, "Failed to prepare Surgeon retry", error)
      }
    }
    if (!result) return this.failed(node, "Surgeon produced no result")
    result.evidence = attemptEvidence
    if (!result.ok && recoverableCommit && !result.recoverableCommit) result.recoverableCommit = recoverableCommit
    if (!result.ok && (result.reason === "NEEDS_NURSE" || result.reason === "CONTRACT_FAILURE")) {
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
        node.repair = {
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.evidence?.length ? { evidence: result.evidence } : {}),
        }
        node.priorEvidence = [...(node.priorEvidence ?? []), ...(result.evidence ?? [])]
        delete node.cache
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
      || JSON.stringify(leaf.world) !== JSON.stringify(node.plan.world)
      || JSON.stringify([...(leaf.artifacts ?? [])].sort()) !== JSON.stringify([...(node.plan.artifacts ?? [])].sort())
      || JSON.stringify(leaf.verify) !== JSON.stringify(node.plan.verify)
    ) {
      throw new Error(`Leaf ${leaf.id} changes its inherited abstract world`)
    }
    assertOwnershipWithinParent(node.plan.owns, leaf.owns, leaf.id)
  }

  private recordResult(node: NodeContext, result: NodeResult): void {
    const evidence = [...(node.priorEvidence ?? []), ...(result.evidence ?? [])]
    result.evidence = evidence
    if (result.ok) {
      this.graph.transition(node.id, "verified", {
        headCommit: result.headCommit,
        attempts: node.attempt ?? 1,
        actualDepth: result.actualDepth,
        changedPaths: result.changedPaths,
        evidence,
        ...(result.usage ? { usage: result.usage } : {}),
      })
    } else {
      this.graph.transition(node.id, "failed", {
        failure: result.reason,
        attempts: node.attempt ?? 1,
        actualDepth: result.actualDepth,
        ...(result.evidence ? { evidence: result.evidence } : {}),
        ...(result.recoverableCommit ? { recoverableCommit: result.recoverableCommit } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      })
    }
  }

  private failed(node: NodeContext, reason: string, error?: unknown, evidence: VerificationEvidence[] = []): NodeResult {
    const detail = error instanceof Error ? error.message : error === undefined ? undefined : String(error)
    const telemetry = this.adapter.telemetry?.(node)
    const combinedEvidence = [...evidence, ...(telemetry?.evidence ?? [])]
    this.graph.transition(node.id, "failed", {
      failure: detail ? `${reason}: ${detail}` : reason,
      attempts: node.attempt ?? 1,
      ...(telemetry?.usage ? { usage: telemetry.usage } : {}),
      ...(combinedEvidence.length ? { evidence: combinedEvidence } : {}),
    })
    return {
      ok: false,
      nodeId: node.id,
      reason,
      ...(detail ? { detail } : {}),
      actualDepth: 0,
      ...(telemetry?.usage ? { usage: telemetry.usage } : {}),
      ...(combinedEvidence.length ? { evidence: combinedEvidence } : {}),
    }
  }
}
