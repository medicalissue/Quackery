import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  boundaryArtifactSchema,
  rootSplitDecisionSchema,
  type BoundaryArtifact,
  type NodeContext,
  type NodePlan,
  type NodeResult,
  type RootSplitDecision,
  type RunSnapshot,
  type SplitDecision,
} from "./model.js"
import type { ConfirmedIntent } from "./intent.js"
import { RunGraph } from "./graph.js"
import { assertCleanRepository, git, GitWorkspaceManager, repositoryRoot } from "./git.js"
import { OpenCodeExecutionAdapter } from "./opencode-adapter.js"
import { assertSplitContract, RecursiveRuntime, type RuntimePolicy } from "./runtime.js"
import { assertNodeWorldMatchesWit, normalizeOwnedPath, resolveRepositoryPath } from "./validation.js"
import { evaluateSelfHostQualification, type SelfHostQualification } from "./qualification.js"

type Client = ConstructorParameters<typeof OpenCodeExecutionAdapter>[0]["client"]
const leaseHeartbeatMs = 5_000
const leaseStaleMs = 15_000

export interface RunHandle {
  id: string
  sessionId: string
  repository: string
  invocationBase: string
  graph: RunGraph
  git: GitWorkspaceManager
  controller: AbortController
  promise: Promise<NodeResult>
}

export interface StartRunInput {
  directory: string
  sessionId: string
  goal: string
  client: Client
  authorizeSession(sessionId: string, node: NodeContext, agent: "nurse" | "surgeon"): void
  deauthorizeSession?(sessionId: string): void
  workerEvidence?(runId: string, nodeId: string): import("./model.js").VerificationEvidence[]
  releaseWorkerEvidence?(runId: string): void
  intent: ConfirmedIntent
  rootDecision: RootSplitDecision
  artifacts: BoundaryArtifact[]
  policy?: Partial<RuntimePolicy>
  cache?: {
    enabled: boolean
    minFanout: number
  }
  escalation?: Partial<Record<"nurse" | "surgeon", { model: string; variant?: string }>>
  models?: Partial<Record<"nurse" | "surgeon", { model: string; variant?: string }>>
  timeouts?: {
    runMs: number
    promptMs: number
    verificationMs: number
  }
}

function materializeRootInput(
  boundaryRoot: string,
  decision: RootSplitDecision,
  artifacts: BoundaryArtifact[],
): { decision: SplitDecision; artifacts: BoundaryArtifact[] } {
  const normalizedArtifacts = artifacts.map((artifact) => ({
    path: normalizeOwnedPath(artifact.path),
    content: artifact.content,
  }))
  const artifactPaths = new Set(normalizedArtifacts.map((artifact) => artifact.path))
  if (artifactPaths.size !== normalizedArtifacts.length) throw new Error("Root boundary artifact paths must be unique")
  const materializedPath = (path: string): string => `${boundaryRoot}/${normalizeOwnedPath(path)}`
  const requireArtifact = (path: string, label: string): string => {
    const normalized = normalizeOwnedPath(path)
    if (!artifactPaths.has(normalized)) throw new Error(`${label} ${normalized} has no matching root artifact`)
    return materializedPath(normalized)
  }
  const materializePlan = (plan: NodePlan): NodePlan => {
    const planArtifacts = (plan.artifacts ?? []).map((path) => requireArtifact(path, "Plan artifact"))
    return {
      ...plan,
      world: {
        ...plan.world,
        witPath: requireArtifact(plan.world.witPath, "WIT path"),
        behaviorPath: requireArtifact(plan.world.behaviorPath, "Behavior path"),
        projectionPath: requireArtifact(plan.world.projectionPath, "Projection path"),
        bindingPath: requireArtifact(plan.world.bindingPath, "Binding path"),
        stubs: plan.world.stubs.map((stub) => ({
          interface: stub.interface,
          path: requireArtifact(stub.path, `Stub for ${stub.interface}`),
        })),
      },
      reads: plan.reads.map((path) => {
        const normalized = normalizeOwnedPath(path)
        return artifactPaths.has(normalized) ? materializedPath(normalized) : normalized
      }),
      ...(plan.artifacts ? { artifacts: planArtifacts } : {}),
    }
  }
  return {
    decision: {
      ...decision,
      children: decision.children.map(materializePlan),
      join: {
        ...decision.join,
        ...(decision.join.integration ? { integration: materializePlan(decision.join.integration) } : {}),
      },
    },
    artifacts: normalizedArtifacts.map((artifact) => ({
      path: materializedPath(artifact.path),
      content: artifact.content,
    })),
  }
}

async function validateMaterializedBoundary(
  decision: SplitDecision,
  artifacts: BoundaryArtifact[],
): Promise<void> {
  const staging = await mkdtemp(resolve(tmpdir(), "quackery-root-boundary-"))
  try {
    for (const artifact of artifacts) {
      const path = resolveRepositoryPath(staging, artifact.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, artifact.content, "utf8")
    }
    const plans = [...decision.children, ...(decision.join.integration ? [decision.join.integration] : [])]
    for (const plan of plans) {
      await assertNodeWorldMatchesWit(staging, plan)
      await access(resolveRepositoryPath(staging, plan.world.behaviorPath))
      for (const artifact of plan.artifacts ?? []) await access(resolveRepositoryPath(staging, artifact))
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const defaultPolicy: RuntimePolicy = {
  maxDepth: 6,
  maxNodes: 32,
  maxNeedsNurseBounces: 1,
  maxLeafAttempts: 2,
  maxDecompositionAttempts: 2,
  maxJoinAttempts: 2,
  maxConcurrency: 4,
  maxObservedCost: 0,
  maxDepthSkew: 1,
  maxWorkRatio: 2,
  allowJustifiedImbalance: true,
}

function runId(): string {
  return `q-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

function assertRunId(id: string): void {
  if (!/^q-[a-z0-9-]+$/.test(id)) throw new Error(`Invalid Quackery run ID ${id}`)
}

class RunStateStore {
  private readonly writes = new Map<string, Promise<void>>()

  async write(snapshot: RunSnapshot, options: { expectedLeaseId?: string } = {}): Promise<void> {
    const value = structuredClone(snapshot)
    const key = `${value.repository}\0${value.id}`
    const previous = this.writes.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const path = await this.path(value.repository, value.id)
      await this.withFileLock(path, "write", async () => {
        if (options.expectedLeaseId) {
          let current: RunSnapshot | undefined
          try {
            current = JSON.parse(await readFile(path, "utf8")) as RunSnapshot
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
          if (current && current.lease?.id !== options.expectedLeaseId) {
            throw new Error(`Run ${value.id} lease ${options.expectedLeaseId} no longer owns persisted state`)
          }
        }
        const temporary = `${path}.${crypto.randomUUID()}.tmp`
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
        await rename(temporary, path)
      })
    })
    this.writes.set(key, next)
    try {
      await next
    } finally {
      if (this.writes.get(key) === next) this.writes.delete(key)
    }
  }

  async withOperationLock<T>(repository: string, id: string, action: () => Promise<T>): Promise<T> {
    return this.withFileLock(await this.path(repository, id), "operation", action)
  }

  async read(repository: string, id: string): Promise<RunSnapshot> {
    assertRunId(id)
    const path = await this.path(repository, id)
    let source: string
    try {
      source = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown Quackery run ${id}`)
      throw error
    }
    const snapshot = JSON.parse(source) as RunSnapshot
    if (snapshot.id !== id || snapshot.repository !== repository || !Array.isArray(snapshot.nodes)) {
      throw new Error(`Invalid persisted Quackery run ${id}`)
    }
    return snapshot
  }

  async latest(repository: string, sessionId: string): Promise<RunSnapshot> {
    const directory = await this.directory(repository)
    const names = (await readdir(directory)).filter((name) => /^q-[a-z0-9-]+\.json$/.test(name))
    const snapshots = await Promise.all(names.map(async (name) => {
      try {
        return await this.read(repository, name.slice(0, -5))
      } catch {
        return undefined
      }
    }))
    const latest = snapshots
      .filter((snapshot): snapshot is RunSnapshot => snapshot?.sessionId === sessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!latest) throw new Error("No Quackery run exists for this session")
    return latest
  }

  private async path(repository: string, id: string): Promise<string> {
    assertRunId(id)
    return resolve(await this.directory(repository), `${id}.json`)
  }

  private async directory(repository: string): Promise<string> {
    const common = await git(repository, ["rev-parse", "--git-common-dir"])
    const directory = resolve(repository, common, "quackery", "runs")
    await mkdir(directory, { recursive: true })
    return directory
  }

  private async withFileLock<T>(path: string, kind: string, action: () => Promise<T>): Promise<T> {
    const lock = `${path}.${kind}.lock`
    const deadline = Date.now() + 30_000
    while (true) {
      try {
        await mkdir(lock)
        await writeFile(`${lock}/owner.json`, JSON.stringify({ processId: process.pid, createdAt: Date.now() }), "utf8")
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        try {
          let ownerAlive = false
          try {
            const owner = JSON.parse(await readFile(`${lock}/owner.json`, "utf8")) as { processId?: unknown }
            if (typeof owner.processId === "number") {
              try {
                process.kill(owner.processId, 0)
                ownerAlive = true
              } catch (signalError) {
                if ((signalError as NodeJS.ErrnoException).code !== "ESRCH") ownerAlive = true
              }
            }
          } catch (ownerError) {
            if ((ownerError as NodeJS.ErrnoException).code !== "ENOENT") throw ownerError
          }
          const info = await stat(lock)
          if (!ownerAlive && Date.now() - info.mtimeMs > 30_000) {
            await rm(lock, { recursive: true, force: true })
            continue
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue
          throw statError
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for Quackery ${kind} lock for ${path}`)
        await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      }
    }
    try {
      return await action()
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }
}

export class RunRegistry {
  private readonly runs = new Map<string, RunHandle>()
  private readonly latestBySession = new Map<string, string>()
  private readonly store = new RunStateStore()

  async start(input: StartRunInput): Promise<RunHandle> {
    const repository = await repositoryRoot(input.directory)
    const id = runId()
    const manager = new GitWorkspaceManager(repository, id)
    await assertCleanRepository(repository)
    const invocationBase = await git(repository, ["rev-parse", "HEAD"])
    const intentRepository = await repositoryRoot(input.intent.repository)
    if (intentRepository !== repository || input.intent.repositoryBase !== invocationBase) {
      throw new Error("Intent Contract does not match the current repository base")
    }
    const root: NodeContext = {
      id: "root",
      runId: id,
      depth: 0,
      role: "pharmacist",
      scope: input.goal,
      worktree: repository,
      baseCommit: invocationBase,
      boundaryRoot: manager.boundaryRoot("root"),
      intent: input.intent,
    }
    const rootDecision = rootSplitDecisionSchema.parse(input.rootDecision)
    const artifacts = boundaryArtifactSchema.array().min(1).parse(input.artifacts)
    const materialized = materializeRootInput(root.boundaryRoot, rootDecision, artifacts)
    assertSplitContract(undefined, materialized.decision, { ...defaultPolicy, ...input.policy })
    await validateMaterializedBoundary(materialized.decision, materialized.artifacts)
    const initializedBase = await manager.initialize()
    if (initializedBase !== invocationBase) throw new Error("Invocation base moved during root boundary validation")
    const rootBoundary = await manager.createSyntheticBoundary(invocationBase, materialized.artifacts)
    root.boundaryCommit = rootBoundary
    const graph = new RunGraph({ id, sessionId: input.sessionId, repository, root, invocationBase })
    const leaseId = crypto.randomUUID()
    graph.snapshot.lease = {
      id: leaseId,
      processId: process.pid,
      heartbeatAt: Date.now(),
    }
    const controller = new AbortController()
    const runMs = input.timeouts?.runMs ?? 3_600_000
    const adapter = new OpenCodeExecutionAdapter({
      client: input.client,
      git: manager,
      parentSessionId: input.sessionId,
      authorizeSession: input.authorizeSession,
      ...(input.deauthorizeSession ? { deauthorizeSession: input.deauthorizeSession } : {}),
      ...(input.workerEvidence ? { workerEvidence: (nodeId: string) => input.workerEvidence!(id, nodeId) } : {}),
      cache: input.cache ?? { enabled: true, minFanout: 2 },
      protocolAttempts: input.policy?.maxDecompositionAttempts ?? defaultPolicy.maxDecompositionAttempts ?? 2,
      ...(input.escalation ? { escalation: input.escalation } : {}),
      ...(input.models ? { models: input.models } : {}),
      maxConcurrency: input.policy?.maxConcurrency ?? defaultPolicy.maxConcurrency ?? 4,
      maxObservedCost: input.policy?.maxObservedCost ?? defaultPolicy.maxObservedCost ?? 0,
      signal: controller.signal,
      deadlineMs: Date.now() + runMs,
      timeouts: {
        promptMs: input.timeouts?.promptMs ?? 600_000,
        verificationMs: input.timeouts?.verificationMs ?? 120_000,
      },
    })
    const runtime = new RecursiveRuntime(graph, adapter, { ...defaultPolicy, ...input.policy })
    adapter.seedBoundary(root, rootBoundary, materialized.decision)
    let handle!: RunHandle
    const persist = async (): Promise<void> => {
      await this.store.write(
        { ...graph.snapshot, worktrees: manager.recordsSnapshot() },
        { expectedLeaseId: leaseId },
      )
    }
    const stopPersisting = graph.onChange(() => {
      void persist().catch((error) => controller.abort(error))
    })
    const heartbeat = setInterval(() => {
      if (!graph.snapshot.lease || graph.snapshot.status !== "running") return
      graph.snapshot.lease.heartbeatAt = Date.now()
      void persist().catch((error) => controller.abort(error))
    }, leaseHeartbeatMs)
    heartbeat.unref()
    const runTimeout = setTimeout(
      () => controller.abort(new Error(`Maximum run time ${(input.timeouts?.runMs ?? 3_600_000) / 1_000}s exceeded`)),
      runMs,
    )
    runTimeout.unref()
    const promise = Promise.resolve()
      .then(() => runtime.executeRoot(root, materialized.decision, rootBoundary))
      .then(async (result) => {
        clearInterval(heartbeat)
        delete graph.snapshot.lease
        await persist()
        return result
      }, async (error) => {
        clearInterval(heartbeat)
        delete graph.snapshot.lease
        graph.fail()
        await persist()
        throw error
      })
      .finally(() => {
        clearInterval(heartbeat)
        clearTimeout(runTimeout)
        stopPersisting()
        adapter.dispose()
        input.releaseWorkerEvidence?.(id)
      })
    handle = {
      id,
      sessionId: input.sessionId,
      repository,
      invocationBase,
      graph,
      git: manager,
      controller,
      promise,
    }
    this.runs.set(id, handle)
    this.latestBySession.set(input.sessionId, id)
    await persist()
    return handle
  }

  get(id: string): RunHandle {
    const handle = this.runs.get(id)
    if (!handle) throw new Error(`Unknown or non-resident run ${id}`)
    return handle
  }

  async snapshot(directory: string, id: string | undefined, sessionId: string): Promise<RunSnapshot> {
    const repository = await repositoryRoot(directory)
    const residentId = id ?? this.latestBySession.get(sessionId)
    const resident = residentId ? this.runs.get(residentId) : undefined
    if (resident) {
      this.assertSession(resident.graph.snapshot, sessionId)
      return structuredClone(resident.graph.snapshot)
    }
    const stored = id ? await this.store.read(repository, id) : await this.store.latest(repository, sessionId)
    this.assertSession(stored, sessionId)
    if (stored.status !== "running") return stored
    if (stored.lease && Date.now() - stored.lease.heartbeatAt <= leaseStaleMs) return stored
    return { ...stored, status: "interrupted", updatedAt: Date.now() }
  }

  async wait(directory: string, id: string | undefined, sessionId: string, timeoutSeconds: number): Promise<RunSnapshot> {
    const residentId = id ?? this.latestBySession.get(sessionId)
    const handle = residentId ? this.runs.get(residentId) : undefined
    if (handle) {
      if (handle.sessionId !== sessionId) throw new Error(`Run ${handle.id} belongs to a different OpenCode session`)
      await Promise.race([
        handle.promise,
        new Promise((resolveWait) => setTimeout(resolveWait, timeoutSeconds * 1_000)),
      ])
    }
    return this.snapshot(directory, id, sessionId)
  }

  async cancel(directory: string, id: string | undefined, sessionId: string): Promise<RunSnapshot> {
    const repository = await repositoryRoot(directory)
    const current = await this.snapshot(repository, id, sessionId)
    return this.store.withOperationLock(repository, current.id, () => this.cancelUnlocked(repository, current.id, sessionId))
  }

  private async cancelUnlocked(repository: string, id: string, sessionId: string): Promise<RunSnapshot> {
    const current = await this.snapshot(repository, id, sessionId)
    if (["canceled", "abandoned"].includes(current.status)) return current
    if (current.status !== "running" && current.status !== "interrupted") {
      throw new Error(`Run ${current.id} is ${current.status}; only a running or interrupted run can be canceled`)
    }
    const handle = this.runs.get(current.id)
    if (handle) {
      handle.controller.abort(new Error("Canceled by user"))
      await handle.promise.catch(() => undefined)
      handle.graph.cancel("Canceled by user")
      const canceled = { ...handle.graph.snapshot, worktrees: handle.git.recordsSnapshot() }
      await this.store.write(canceled)
      return structuredClone(canceled)
    }
    if (current.status === "running") {
      throw new Error(`Run ${current.id} has an active lease in another Quackery runtime`)
    }
    const { lease: _staleLease, ...interrupted } = current
    const canceled: RunSnapshot = {
      ...interrupted,
      status: "canceled",
      nodes: current.nodes.map((node) => ["verified", "failed", "refused"].includes(node.status)
        ? node
        : { ...node, status: "canceled", failure: "Canceled after process interruption", completedAt: Date.now() }),
      updatedAt: Date.now(),
    }
    await this.store.write(canceled)
    return canceled
  }

  async abandon(directory: string, id: string | undefined, sessionId: string): Promise<RunSnapshot> {
    const repository = await repositoryRoot(directory)
    const current = await this.snapshot(repository, id, sessionId)
    return this.store.withOperationLock(repository, current.id, () => this.abandonUnlocked(repository, current.id, sessionId))
  }

  private async abandonUnlocked(repository: string, id: string, sessionId: string): Promise<RunSnapshot> {
    let snapshot = await this.snapshot(repository, id, sessionId)
    if (snapshot.status === "running" || snapshot.status === "interrupted") {
      snapshot = await this.cancelUnlocked(repository, snapshot.id, sessionId)
    }
    if (snapshot.status === "applied") throw new Error(`Run ${snapshot.id} was applied and cannot be abandoned`)
    const handle = this.runs.get(snapshot.id)
    const manager = handle?.git ?? new GitWorkspaceManager(repository, snapshot.id)
    if (!handle) manager.restoreRecords(snapshot.worktrees ?? [])
    const cleanup = await manager.cleanup()
    if (handle) {
      handle.graph.abandon(cleanup)
      const abandoned = { ...handle.graph.snapshot, worktrees: manager.recordsSnapshot() }
      await this.store.write(abandoned)
      return structuredClone(abandoned)
    }
    const abandoned: RunSnapshot = {
      ...snapshot,
      status: "abandoned",
      cleanup,
      worktrees: manager.recordsSnapshot(),
      updatedAt: Date.now(),
    }
    await this.store.write(abandoned)
    return abandoned
  }

  async apply(directory: string, id: string | undefined, sessionId: string): Promise<RunSnapshot> {
    const repository = await repositoryRoot(directory)
    const current = await this.snapshot(repository, id, sessionId)
    return this.store.withOperationLock(repository, current.id, () => this.applyUnlocked(repository, current.id, sessionId))
  }

  private async applyUnlocked(repository: string, id: string, sessionId: string): Promise<RunSnapshot> {
    const residentId = id
    const handle = residentId ? this.runs.get(residentId) : undefined
    if (handle) {
      if (handle.sessionId !== sessionId) throw new Error(`Run ${handle.id} belongs to a different OpenCode session`)
      const result = await handle.promise
      if (!result.ok) throw new Error(`Run failed: ${result.reason}`)
    }
    const snapshot = await this.snapshot(repository, id, sessionId)
    if (snapshot.status === "applied") {
      if (!snapshot.worktrees?.length) return snapshot
      const manager = handle?.git ?? new GitWorkspaceManager(repository, snapshot.id)
      if (!handle) manager.restoreRecords(snapshot.worktrees)
      const cleanup = await manager.cleanup()
      const retried: RunSnapshot = {
        ...snapshot,
        cleanup,
        worktrees: manager.recordsSnapshot(),
        updatedAt: Date.now(),
      }
      await this.store.write(retried)
      return retried
    }
    if (snapshot.status !== "verified" || !snapshot.resultCommit) {
      throw new Error(`Run ${snapshot.id} is ${snapshot.status}; only a verified result can be applied`)
    }
    const manager = handle?.git ?? new GitWorkspaceManager(repository, snapshot.id)
    if (!handle) manager.restoreRecords(snapshot.worktrees ?? [])
    await manager.applyResult(snapshot.invocationBase, snapshot.resultCommit)
    const appliedCommit = await git(repository, ["rev-parse", "HEAD"])
    const cleanup = await manager.cleanup()
    if (handle) {
      handle.graph.applied(appliedCommit, cleanup)
      const applied = { ...handle.graph.snapshot, worktrees: manager.recordsSnapshot() }
      await this.store.write(applied)
      return structuredClone(applied)
    }
    const applied: RunSnapshot = {
      ...snapshot,
      status: "applied",
      appliedCommit,
      cleanup,
      worktrees: manager.recordsSnapshot(),
      updatedAt: Date.now(),
    }
    await this.store.write(applied)
    return applied
  }

  async qualifySelfHost(directory: string, id: string | undefined, sessionId: string): Promise<SelfHostQualification> {
    const repository = await repositoryRoot(directory)
    const snapshot = await this.snapshot(directory, id, sessionId)
    if (!snapshot.resultCommit) return evaluateSelfHostQualification(snapshot, [], 0)
    const changed = await git(repository, ["diff", "--name-only", "-z", `${snapshot.invocationBase}..${snapshot.resultCommit}`])
    const count = Number(await git(repository, ["rev-list", "--count", `${snapshot.invocationBase}..${snapshot.resultCommit}`]))
    return evaluateSelfHostQualification(snapshot, changed.split("\0").filter(Boolean).sort(), count)
  }

  private assertSession(snapshot: RunSnapshot, sessionId: string): void {
    if (snapshot.sessionId && snapshot.sessionId !== sessionId) {
      throw new Error(`Run ${snapshot.id} belongs to a different OpenCode session`)
    }
  }
}
