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

function responseText(value: unknown): string {
  const data = dataOf(value)
  const parts = data?.parts ?? data?.info?.parts ?? []
  return parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
}

export function parseJsonResponse(value: unknown): unknown {
  const text = typeof value === "string" ? value : responseText(value)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  if (!candidate) throw new Error(`Agent did not return JSON: ${text.slice(-1_000)}`)
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
  authorizeSession(sessionId: string, node: NodeContext, agent: "pharmacist" | "nurse" | "surgeon"): void
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
}

export class OpenCodeExecutionAdapter implements ExecutionAdapter {
  private readonly decompositionSessions = new Map<string, string>()
  private readonly boundaries = new Map<string, { seed: BoundaryCacheSeed; cacheRoles: Set<"nurse" | "surgeon"> }>()
  private readonly usage = new Map<string, ReturnType<typeof emptyUsage>>()

  constructor(private readonly options: OpenCodeAdapterOptions) {}

  async decompose(node: NodeContext): Promise<DecompositionDecision> {
    this.assertActive()
    const agent = node.depth === 0 ? "pharmacist" : "nurse"
    const sessionId = await this.createSession(node, agent, `${agent} · ${node.scope}`)
    this.decompositionSessions.set(node.id, sessionId)
    const response = await this.prompt(node, sessionId, agent, decompositionPrompt(node))
    return decompositionDecisionSchema.parse(parseJsonResponse(response))
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
    const seed = boundaryCacheSeed(node, commit, decision)
    const cacheRoles = new Set<"nurse" | "surgeon">()
    if (this.options.cache.enabled && decision.kind === "split") {
      const nurseCount = decision.children.filter((plan) => plan.kind === "scope").length
      const surgeonCount = decision.children.filter((plan) => plan.kind === "leaf").length
      if (nurseCount >= this.options.cache.minFanout) cacheRoles.add("nurse")
      if (surgeonCount >= this.options.cache.minFanout) cacheRoles.add("surgeon")
    }
    this.boundaries.set(node.id, { seed, cacheRoles })
    // A locally decomposed leaf changes role from Nurse to Surgeon and must not
    // reuse the Nurse cohort's cache partition.
    if (decision.kind === "leaf") delete node.cache
    return commit
  }

  async forkChild(parent: NodeContext, boundaryCommit: string, plan: NodePlan): Promise<NodeContext> {
    this.assertActive()
    const id = `${parent.id}/${plan.id}`
    const record = await this.options.git.create(id, boundaryCommit)
    const role = plan.kind === "leaf" ? "surgeon" : "nurse"
    const boundary = this.boundaries.get(parent.id)
    const cache = boundary?.cacheRoles.has(role) ? cacheContext(boundary.seed, role) : undefined
    return {
      id,
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
    }
  }

  async prepareNeedsNurse(node: NodeContext): Promise<string | undefined> {
    return this.options.git.stashUncommitted(node.id, `quackery(${node.id}): Surgeon attempt before NEEDS_NURSE`)
  }

  async runLeaf(node: NodeContext, boundaryCommit: string): Promise<NodeResult> {
    this.assertActive()
    if (!node.plan) throw new Error(`Leaf ${node.id} has no plan`)
    await assertNodeWorldMatchesWit(node.worktree, node.plan)
    await access(resolveRepositoryPath(node.worktree, node.plan.world.behaviorPath))

    const sessionId = await this.createSession(node, "surgeon", `surgeon · ${node.scope}`)
    const response = await this.prompt(node, sessionId, "surgeon", implementationPrompt(node))
    const agentResult = implementationResponseSchema.parse(parseJsonResponse(response))
    if (agentResult.kind !== "implemented") {
      return {
        ok: false,
        nodeId: node.id,
        reason: agentResult.kind === "needs-nurse" ? "NEEDS_NURSE" : "CONTRACT_FAILURE",
        detail: agentResult.reason,
        actualDepth: 0,
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
      evidence,
      actualDepth: 0,
      usage: this.nodeUsage(node.id),
    }
  }

  async prepareJoin(node: NodeContext, children: NodeSuccess[]): Promise<string> {
    this.assertActive()
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
        ...children.flatMap((child) => child.evidence),
        ...(integrationResult?.evidence ?? []),
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
    // A non-root LEAF must reuse its inherited world. SPLITs and root LEAFs
    // create new boundary artifacts only in this node's reserved namespace.
    if (decision.kind === "leaf" && node.plan) return
    const boundary = { path: node.boundaryRoot, mode: "prefix" as const }
    for (const plan of plans) {
      for (const path of [plan.world.witPath, plan.world.behaviorPath, ...(plan.artifacts ?? [])]) {
        const candidate = relative(node.worktree, resolveRepositoryPath(node.worktree, path)).replaceAll("\\", "/")
        if (!ownershipContains(boundary, candidate)) {
          throw new Error(`Boundary artifact ${candidate} must be under ${node.boundaryRoot}`)
        }
      }
    }
  }

  private async createSession(
    node: NodeContext,
    agent: "pharmacist" | "nurse" | "surgeon",
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
    const data = dataOf(response)
    const sessionId = data?.id
    if (typeof sessionId !== "string") throw new Error(`OpenCode did not return a session id for ${node.id}`)
    this.options.authorizeSession(sessionId, node, agent)
    return sessionId
  }

  private async prompt(node: NodeContext, sessionId: string, agent: string, text: string): Promise<unknown> {
    const request = this.requestSignal()
    let response: unknown
    try {
      response = await this.options.client.session.prompt({
        path: { id: sessionId },
        query: { directory: node.worktree },
        body: {
          agent,
          parts: [{ type: "text", text }],
        },
        signal: request.signal,
      })
    } finally {
      request.dispose()
    }
    this.usage.set(node.id, addUsage(this.nodeUsage(node.id), usageFromResponse(response)))
    return response
  }

  private nodeUsage(nodeId: string): ReturnType<typeof emptyUsage> {
    return this.usage.get(nodeId) ?? emptyUsage()
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
