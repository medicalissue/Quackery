import { access } from "node:fs/promises"
import { relative } from "node:path"
import { z } from "zod"
import type { DecompositionDecision, NodeContext, NodePlan, NodeResult, NodeSuccess, SplitDecision } from "./model.js"
import { decompositionDecisionSchema } from "./model.js"
import { addUsage, boundaryCacheSeed, cacheContext, emptyUsage, usageFromResponse, type BoundaryCacheSeed } from "./cache.js"
import type { ExecutionAdapter } from "./runtime.js"
import { GitWorkspaceManager } from "./git.js"
import { assertNodeWorldMatchesWit, ownershipContains, resolveRepositoryPath } from "./validation.js"
import { decompositionPrompt, implementationPrompt } from "./prompts.js"

const implementationResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("implemented"), summary: z.string() }),
  z.object({ kind: z.literal("needs-nurse"), reason: z.string() }),
  z.object({ kind: z.literal("contract-failure"), reason: z.string() }),
])

type Client = {
  session: {
    create(input: unknown): Promise<unknown>
    prompt(input: unknown): Promise<unknown>
  }
}

function dataOf(value: unknown): any {
  if (value && typeof value === "object" && "data" in value) return (value as { data: unknown }).data
  return value
}

function failureMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return String(value)
  const record = value as Record<string, any>
  const name = typeof record.name === "string" ? record.name : undefined
  const message = typeof record.message === "string"
    ? record.message
    : typeof record.data?.message === "string"
      ? record.data.message
      : undefined
  if (name && message) return `${name}: ${message}`
  if (message) return message
  try {
    return JSON.stringify(value).slice(0, 1_000)
  } catch {
    return String(value)
  }
}

export function responseFailure(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const outer = value as Record<string, any>
  if (outer.error !== undefined && outer.error !== null) return failureMessage(outer.error)
  const data = dataOf(value)
  const assistantError = data?.info?.error ?? data?.message?.info?.error ?? data?.message?.error
  return assistantError === undefined || assistantError === null ? undefined : failureMessage(assistantError)
}

function responseText(value: unknown): string {
  if (typeof value === "string") return value
  const data = dataOf(value)
  if (typeof data?.output === "string") return data.output
  if (typeof data?.message?.output === "string") return data.message.output
  const parts = data?.parts ?? data?.info?.parts ?? data?.message?.parts ?? data?.message?.info?.parts ?? []
  return parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
}

export function parseJsonResponse(value: unknown): unknown {
  const failure = responseFailure(value)
  if (failure) throw new Error(`Agent request failed: ${failure}`)
  const data = dataOf(value)
  if (data && typeof data === "object" && typeof data.kind === "string") return data
  if (data?.output && typeof data.output === "object") return data.output
  const text = responseText(value)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const firstBrace = text.indexOf("{")
  const lastBrace = text.lastIndexOf("}")
  const candidate = fenced ?? (firstBrace >= 0 && lastBrace >= firstBrace ? text.slice(firstBrace, lastBrace + 1) : "")
  if (!candidate) {
    const response = value && typeof value === "object" && "response" in value
      ? (value as { response?: { status?: number; statusText?: string } }).response
      : undefined
    const status = response?.status ? ` (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""})` : ""
    throw new Error(`Agent returned no JSON text${status}`)
  }
  try {
    return JSON.parse(candidate)
  } catch (error) {
    throw new Error(`Agent returned invalid JSON: ${candidate.slice(0, 1_000)}`, { cause: error })
  }
}

export interface OpenCodeAdapterOptions {
  client: Client
  git: GitWorkspaceManager
  parentSessionId: string
  authorizeSession(sessionId: string, node: NodeContext, agent: "nurse" | "surgeon"): void
  deauthorizeSession?(sessionId: string): void
  workerEvidence?(nodeId: string): import("./model.js").VerificationEvidence[]
  cache: {
    enabled: boolean
    minFanout: number
  }
  signal?: AbortSignal
  deadlineMs?: number
  timeouts?: {
    promptMs: number
    verificationMs: number
  }
  protocolAttempts?: number
  escalation?: Partial<Record<"nurse" | "surgeon", { model: string; variant?: string }>>
  models?: Partial<Record<"nurse" | "surgeon", { model: string; variant?: string }>>
  maxConcurrency?: number
  maxObservedCost?: number
}

export class OpenCodeExecutionAdapter implements ExecutionAdapter {
  private readonly decompositionSessions = new Map<string, string>()
  private readonly boundaries = new Map<string, { seed: BoundaryCacheSeed; cacheRoles: Set<"nurse" | "surgeon"> }>()
  private readonly usage = new Map<string, ReturnType<typeof emptyUsage>>()
  private readonly activeSessions = new Set<string>()
  private activePrompts = 0
  private readonly promptWaiters: Array<() => void> = []

  constructor(private readonly options: OpenCodeAdapterOptions) {}

  async decompose(node: NodeContext): Promise<DecompositionDecision> {
    this.assertActive()
    if (node.role !== "nurse") throw new Error(`Only a Nurse node may decompose; received ${node.role}`)
    const sessionId = await this.createSession(node, "nurse", `nurse · ${node.scope}`)
    this.decompositionSessions.set(node.id, sessionId)
    return this.promptStructured(node, sessionId, "nurse", decompositionPrompt(node), decompositionDecisionSchema)
  }

  async reviseDecomposition(node: NodeContext, error: Error, attempt: number): Promise<DecompositionDecision> {
    this.assertActive()
    node.repair = { reason: "BOUNDARY_REJECTED", detail: error.message }
    node.attempt = attempt
    this.applyEscalation(node, "nurse")
    const sessionId = this.decompositionSessions.get(node.id)
    if (!sessionId) return this.decompose(node)
    return this.promptStructured(
      node,
      sessionId,
      "nurse",
      `The runtime rejected your previous boundary:\n${error.message.slice(0, 2_000)}\n\nReturn one complete replacement decomposition JSON object in the previously required shape. If returning LEAF for an inherited plan, reuse its exports, imports, complete world object, artifacts, owns, and verify exactly and do not copy contract files. If returning SPLIT, correct only boundary artifacts under ${node.boundaryRoot}. Do not edit product code.`,
      decompositionDecisionSchema,
    )
  }

  async commitBoundary(node: NodeContext, decision: DecompositionDecision): Promise<string> {
    this.assertActive()
    const plans = decision.kind === "leaf"
      ? [decision.leaf]
      : decision.kind === "split"
        ? [...decision.children, ...(decision.join.integration ? [decision.join.integration] : [])]
        : []
    for (const plan of plans) {
      await assertNodeWorldMatchesWit(node.worktree, plan)
      await access(resolveRepositoryPath(node.worktree, plan.world.behaviorPath))
      for (const artifact of plan.artifacts ?? []) {
        await access(resolveRepositoryPath(node.worktree, artifact))
      }
    }
    this.assertBoundaryArtifactPaths(node, decision, plans)
    const commit = await this.options.git.commitAll(node.id, `quackery(${node.id}): freeze abstract worlds`)
    await this.options.git.assertOwned(node.id, node.baseCommit, [{ path: node.boundaryRoot, mode: "prefix" }], commit)
    this.seedBoundary(node, commit, decision)
    const decompositionSession = this.decompositionSessions.get(node.id)
    if (decompositionSession) this.releaseSession(decompositionSession)
    // The separate Surgeon created for a Nurse LEAF handoff must not inherit
    // the Nurse node's cache partition.
    if (decision.kind === "leaf") delete node.cache
    return commit
  }

  seedBoundary(node: NodeContext, commit: string, decision: DecompositionDecision): void {
    const seed = boundaryCacheSeed(node, commit, decision)
    const cacheRoles = new Set<"nurse" | "surgeon">()
    if (this.options.cache.enabled && decision.kind === "split") {
      const nurseCount = decision.children.filter((plan) => plan.kind === "scope").length
      const surgeonCount = decision.children.filter((plan) => plan.kind === "leaf").length
      if (nurseCount >= this.options.cache.minFanout) cacheRoles.add("nurse")
      if (surgeonCount >= this.options.cache.minFanout) cacheRoles.add("surgeon")
    }
    this.boundaries.set(node.id, { seed, cacheRoles })
  }

  async forkChild(parent: NodeContext, boundaryCommit: string, plan: NodePlan): Promise<NodeContext> {
    this.assertActive()
    const id = `${parent.id}/${plan.id}`
    const record = await this.options.git.create(id, boundaryCommit)
    const role = plan.kind === "leaf" ? "surgeon" : "nurse"
    const configuredModel = this.options.models?.[role]
    const modelOverride = configuredModel ? this.modelTarget(configuredModel) : undefined
    const boundary = this.boundaries.get(parent.id)
    const cache = boundary?.cacheRoles.has(role) ? cacheContext(boundary.seed, role) : undefined
    return {
      id,
      ...(parent.runId ? { runId: parent.runId } : {}),
      parentId: parent.id,
      depth: parent.depth + 1,
      role,
      scope: plan.scope,
      plan,
      worktree: record.path,
      baseCommit: boundaryCommit,
      boundaryRoot: this.options.git.boundaryRoot(id),
      ...(parent.intent ? { intent: parent.intent } : {}),
      ...(cache ? { cache } : {}),
      ...(modelOverride ? { modelOverride } : {}),
    }
  }

  async prepareNeedsNurse(node: NodeContext): Promise<string | undefined> {
    const stash = await this.options.git.stashUncommitted(node.id, `quackery(${node.id}): Surgeon attempt before NEEDS_NURSE`)
    const head = await this.options.git.head(node.id)
    if (head !== node.baseCommit) await this.options.git.detachAt(node.id, node.baseCommit)
    const nurseModel = this.options.models?.nurse
    if (nurseModel) node.modelOverride = this.modelTarget(nurseModel)
    else delete node.modelOverride
    return stash ?? (head === node.baseCommit ? undefined : head)
  }

  async prepareRetry(node: NodeContext, _failure: NodeResult, _nextAttempt: number): Promise<void> {
    this.applyEscalation(node, "surgeon")
  }

  telemetry(node: NodeContext): Pick<NodeResult, "usage" | "evidence"> {
    const evidence = this.workerEvidence(node.id)
    return {
      usage: this.nodeUsage(node.id),
      ...(evidence.length ? { evidence } : {}),
    }
  }

  async runLeaf(node: NodeContext, boundaryCommit: string): Promise<NodeResult> {
    this.assertActive()
    if (!node.plan) throw new Error(`Leaf ${node.id} has no plan`)
    await assertNodeWorldMatchesWit(node.worktree, node.plan)
    await access(resolveRepositoryPath(node.worktree, node.plan.world.behaviorPath))

    const sessionId = await this.createSession(node, "surgeon", `surgeon · ${node.scope}`)
    let agentResult: z.infer<typeof implementationResponseSchema>
    try {
      agentResult = await this.promptStructured(
        node,
        sessionId,
        "surgeon",
        implementationPrompt(node),
        implementationResponseSchema,
      )
    } finally {
      this.releaseSession(sessionId)
    }
    if (agentResult.kind !== "implemented") {
      const evidence = this.workerEvidence(node.id)
      return {
        ok: false,
        nodeId: node.id,
        reason: agentResult.kind === "needs-nurse" ? "NEEDS_NURSE" : "CONTRACT_FAILURE",
        detail: agentResult.reason,
        actualDepth: 0,
        ...(evidence.length ? { evidence } : {}),
        usage: this.nodeUsage(node.id),
      }
    }

    const committedHead = await this.options.git.commitAll(node.id, `quackery(${node.id}): fill implementation hole`)
    let changedPaths: string[]
    try {
      changedPaths = await this.options.git.assertOwned(node.id, boundaryCommit, node.plan.owns, committedHead)
    } catch (error) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "OWNERSHIP_VIOLATION",
        detail: error instanceof Error ? error.message : String(error),
        recoverableCommit: committedHead,
        actualDepth: 0,
        ...(this.workerEvidence(node.id).length ? { evidence: this.workerEvidence(node.id) } : {}),
        usage: this.nodeUsage(node.id),
      }
    }
    const evidence = await this.options.git.verify(
      node.id,
      node.plan.verify,
      this.boundedTimeout(this.options.timeouts?.verificationMs ?? 120_000),
    )
    this.assertActive()
    const verificationMutations = await this.options.git.worktreeChanges(node.id)
    if (verificationMutations.length > 0) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "VERIFICATION_MUTATION",
        detail: `Verification changed the worktree: ${verificationMutations.join(", ")}`,
        recoverableCommit: committedHead,
        actualDepth: 0,
        evidence: [...this.workerEvidence(node.id), ...evidence],
        usage: this.nodeUsage(node.id),
      }
    }
    const failedEvidence = evidence.find((item) => item.exitCode !== 0)
    if (failedEvidence) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "VERIFICATION_FAILED",
        detail: `${failedEvidence.command} exited with ${failedEvidence.exitCode}`,
        recoverableCommit: committedHead,
        actualDepth: 0,
        evidence: [...this.workerEvidence(node.id), ...evidence],
        usage: this.nodeUsage(node.id),
      }
    }
    const resultBase = node.depth === 0 ? node.baseCommit : boundaryCommit
    const normalized = await this.options.git.normalizedResultCommit(
      node.id,
      resultBase,
      `quackery(${node.id}): verified node result`,
    )
    return {
      ok: true,
      nodeId: node.id,
      baseCommit: resultBase,
      headCommit: normalized,
      changedPaths,
      evidence: [...this.workerEvidence(node.id), ...evidence],
      actualDepth: 0,
      usage: this.nodeUsage(node.id),
    }
  }

  async prepareJoin(node: NodeContext, children: NodeSuccess[]): Promise<string> {
    this.assertActive()
    if (!this.options.git.has(node.id)) {
      const record = await this.options.git.create(node.id, node.boundaryCommit ?? node.baseCommit)
      node.worktree = record.path
    }
    await this.options.git.cherryPick(node.id, children.map((child) => child.headCommit))
    return this.options.git.head(node.id)
  }

  async join(
    node: NodeContext,
    boundaryCommit: string,
    children: NodeSuccess[],
    decision: SplitDecision,
    integrationResult?: NodeSuccess,
  ): Promise<NodeResult> {
    this.assertActive()
    if (integrationResult) await this.options.git.cherryPick(node.id, [integrationResult.headCommit])
    const committedHead = await this.options.git.head(node.id)
    const evidence = await this.options.git.verify(
      node.id,
      decision.join.verify,
      this.boundedTimeout(this.options.timeouts?.verificationMs ?? 120_000),
      "runtime-join",
    )
    this.assertActive()
    const verificationMutations = await this.options.git.worktreeChanges(node.id)
    if (verificationMutations.length > 0) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "JOIN_VERIFICATION_MUTATION",
        detail: `Verification changed the worktree: ${verificationMutations.join(", ")}`,
        recoverableCommit: committedHead,
        actualDepth: 0,
        evidence: [...this.workerEvidence(node.id), ...evidence],
        usage: this.nodeUsage(node.id),
      }
    }
    const failedEvidence = evidence.find((item) => item.exitCode !== 0)
    if (failedEvidence) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "JOIN_VERIFICATION_FAILED",
        detail: `${failedEvidence.command} exited with ${failedEvidence.exitCode}`,
        recoverableCommit: committedHead,
        actualDepth: 0,
        evidence: [...this.workerEvidence(node.id), ...evidence],
        usage: this.nodeUsage(node.id),
      }
    }
    const normalized = await this.options.git.normalizedResultCommit(
      node.id,
      node.baseCommit,
      `quackery(${node.id}): verified subtree result`,
    )
    const changedPaths = await this.options.git.changedPaths(node.id, node.baseCommit, normalized)
    return {
      ok: true,
      nodeId: node.id,
      baseCommit: node.baseCommit,
      headCommit: normalized,
      changedPaths,
      evidence: [
        ...this.workerEvidence(node.id),
        ...evidence,
      ],
      actualDepth: 0,
      usage: this.nodeUsage(node.id),
    }
  }

  private assertBoundaryArtifactPaths(
    node: NodeContext,
    decision: DecompositionDecision,
    plans: NodePlan[],
  ): void {
    // A Nurse LEAF handoff must reuse its inherited world. Nurse SPLITs create
    // new boundary artifacts only in this node's reserved namespace.
    if (decision.kind === "leaf" && node.plan) return
    const boundary = { path: node.boundaryRoot, mode: "prefix" as const }
    for (const plan of plans) {
      for (const path of [
        plan.world.witPath,
        plan.world.behaviorPath,
        plan.world.projectionPath,
        plan.world.bindingPath,
        ...plan.world.stubs.map((stub) => stub.path),
        ...(plan.artifacts ?? []),
      ]) {
        const candidate = relative(node.worktree, resolveRepositoryPath(node.worktree, path)).replaceAll("\\", "/")
        if (!ownershipContains(boundary, candidate)) {
          throw new Error(`Boundary artifact ${candidate} must be under ${node.boundaryRoot}`)
        }
      }
    }
  }

  private async createSession(
    node: NodeContext,
    agent: "nurse" | "surgeon",
    title: string,
  ): Promise<string> {
    // A Surgeon spawned after this node's Nurse must be a child of that Nurse.
    // A direct leaf has no local decomposition session, so it remains a child
    // of the parent node's decomposer (or the user's originating session).
    const parentID =
      this.decompositionSessions.get(node.id) ??
      (node.parentId
        ? this.decompositionSessions.get(node.parentId) ?? this.options.parentSessionId
        : this.options.parentSessionId)
    const request = this.requestSignal()
    let response: unknown
    try {
      response = await this.options.client.session.create({
        query: { directory: node.worktree },
        body: { parentID, title },
        signal: request.signal,
      })
    } finally {
      request.dispose()
    }
    const failure = responseFailure(response)
    if (failure) throw new Error(`OpenCode session creation failed for ${node.id}: ${failure}`)
    const data = dataOf(response)
    const sessionId = data?.id
    if (typeof sessionId !== "string") throw new Error(`OpenCode did not return a session id for ${node.id}`)
    this.options.authorizeSession(sessionId, node, agent)
    this.activeSessions.add(sessionId)
    return sessionId
  }

  dispose(): void {
    for (const sessionId of this.activeSessions) this.options.deauthorizeSession?.(sessionId)
    this.activeSessions.clear()
  }

  private releaseSession(sessionId: string): void {
    if (!this.activeSessions.delete(sessionId)) return
    this.options.deauthorizeSession?.(sessionId)
  }

  private async prompt(node: NodeContext, sessionId: string, agent: string, text: string): Promise<unknown> {
    await this.acquirePromptSlot()
    try {
      this.assertObservedBudget()
      const request = this.requestSignal()
      let response: unknown
      try {
        response = await this.options.client.session.prompt({
          path: { id: sessionId },
          query: { directory: node.worktree },
          body: {
            agent,
            ...(node.modelOverride
              ? {
                  model: {
                    providerID: node.modelOverride.providerID,
                    modelID: node.modelOverride.modelID,
                  },
                  ...(node.modelOverride.variant ? { variant: node.modelOverride.variant } : {}),
                }
              : {}),
            parts: [{ type: "text", text }],
          },
          signal: request.signal,
        })
      } finally {
        request.dispose()
      }
      this.usage.set(node.id, addUsage(this.nodeUsage(node.id), usageFromResponse(response)))
      return response
    } finally {
      this.releasePromptSlot()
    }
  }

  private async promptStructured<T>(
    node: NodeContext,
    sessionId: string,
    agent: "nurse" | "surgeon",
    text: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const attempts = Math.max(1, this.options.protocolAttempts ?? 2)
    let prompt = text
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await this.prompt(node, sessionId, agent, prompt)
      try {
        return schema.parse(parseJsonResponse(response))
      } catch (error) {
        if (responseFailure(response)) throw error
        lastError = error
        if (attempt === attempts) break
        const detail = error instanceof Error ? error.message : String(error)
        prompt = `Your previous response violated the required structured protocol:\n${detail.slice(0, 1_500)}\n\nDo not explain or call tools. Return exactly one JSON object in one of the shapes from the prior instructions.`
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private nodeUsage(nodeId: string): ReturnType<typeof emptyUsage> {
    return this.usage.get(nodeId) ?? emptyUsage()
  }

  private workerEvidence(nodeId: string): import("./model.js").VerificationEvidence[] {
    return this.options.workerEvidence?.(nodeId) ?? []
  }

  private applyEscalation(node: NodeContext, role: "nurse" | "surgeon"): void {
    const target = this.options.escalation?.[role]
    if (!target) return
    node.modelOverride = this.modelTarget(target)
  }

  private modelTarget(target: { model: string; variant?: string }): NonNullable<NodeContext["modelOverride"]> {
    const separator = target.model.indexOf("/")
    if (separator <= 0 || separator === target.model.length - 1) {
      throw new Error(`Escalation model must use provider/model form: ${target.model}`)
    }
    return {
      providerID: target.model.slice(0, separator),
      modelID: target.model.slice(separator + 1),
      ...(target.variant ? { variant: target.variant } : {}),
    }
  }

  private async acquirePromptSlot(): Promise<void> {
    this.assertActive()
    const limit = Math.max(1, this.options.maxConcurrency ?? Number.POSITIVE_INFINITY)
    if (this.activePrompts >= limit) {
      await new Promise<void>((resolve) => this.promptWaiters.push(resolve))
      try {
        this.assertActive()
      } catch (error) {
        this.releasePromptSlot()
        throw error
      }
      return
    }
    this.activePrompts += 1
  }

  private releasePromptSlot(): void {
    const next = this.promptWaiters.shift()
    if (next) next()
    else this.activePrompts = Math.max(0, this.activePrompts - 1)
  }

  private assertObservedBudget(): void {
    const limit = this.options.maxObservedCost ?? 0
    if (limit <= 0) return
    const observed = [...this.usage.values()].reduce((total, usage) => total + usage.cost, 0)
    if (observed >= limit) {
      throw new Error(`Observed provider cost $${observed.toFixed(4)} reached limit $${limit.toFixed(4)}`)
    }
  }

  private assertActive(): void {
    this.options.signal?.throwIfAborted()
  }

  private requestSignal(): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController()
    const parent = this.options.signal
    const abortFromParent = (): void => controller.abort(parent?.reason)
    if (parent?.aborted) abortFromParent()
    else parent?.addEventListener("abort", abortFromParent, { once: true })
    const configuredMs = this.options.timeouts?.promptMs ?? 600_000
    const remainingMs = this.options.deadlineMs ? this.options.deadlineMs - Date.now() : undefined
    const deadlineLimited = remainingMs !== undefined && remainingMs <= configuredMs
    const timeout = setTimeout(
      () => controller.abort(new Error(deadlineLimited ? "Maximum run time deadline exceeded" : "OpenCode request timeout")),
      this.boundedTimeout(configuredMs),
    )
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timeout)
        parent?.removeEventListener("abort", abortFromParent)
      },
    }
  }

  private boundedTimeout(configuredMs: number): number {
    if (!this.options.deadlineMs) return configuredMs
    return Math.max(1, Math.min(configuredMs, this.options.deadlineMs - Date.now()))
  }
}
