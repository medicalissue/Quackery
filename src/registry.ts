import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { NodeContext, NodeResult, RunSnapshot } from "./model.js"
import type { ConfirmedIntent } from "./intent.js"
import { RunGraph } from "./graph.js"
import { git, GitWorkspaceManager, repositoryRoot } from "./git.js"
import { OpenCodeExecutionAdapter } from "./opencode-adapter.js"
import { RecursiveRuntime, type RuntimePolicy } from "./runtime.js"

type Client = ConstructorParameters<typeof OpenCodeExecutionAdapter>[0]["client"]

export interface RunHandle {
  id: string
  sessionId: string
  repository: string
  invocationBase: string
  graph: RunGraph
  git: GitWorkspaceManager
  promise: Promise<NodeResult>
}

export interface StartRunInput {
  directory: string
  sessionId: string
  goal: string
  client: Client
  authorizeSession(sessionId: string, node: NodeContext, agent: "pharmacist" | "nurse" | "surgeon"): void
  intent: ConfirmedIntent
  policy?: Partial<RuntimePolicy>
  cache?: {
    enabled: boolean
    minFanout: number
  }
  timeouts?: {
    runMs: number
    promptMs: number
    verificationMs: number
  }
}

const defaultPolicy: RuntimePolicy = {
  maxDepth: 6,
  maxNodes: 32,
  maxNeedsNurseBounces: 1,
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

  async write(snapshot: RunSnapshot): Promise<void> {
    const value = structuredClone(snapshot)
    const path = await this.path(value.repository, value.id)
    const previous = this.writes.get(path) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const temporary = `${path}.${crypto.randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
      await rename(temporary, path)
    })
    this.writes.set(path, next)
    try {
      await next
    } finally {
      if (this.writes.get(path) === next) this.writes.delete(path)
    }
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
}

export class RunRegistry {
  private readonly runs = new Map<string, RunHandle>()
  private readonly latestBySession = new Map<string, string>()
  private readonly store = new RunStateStore()

  async start(input: StartRunInput): Promise<RunHandle> {
    const repository = await repositoryRoot(input.directory)
    const id = runId()
    const manager = new GitWorkspaceManager(repository, id)
    const invocationBase = await manager.initialize()
    const rootRecord = await manager.create("root", invocationBase)
    const root: NodeContext = {
      id: "root",
      depth: 0,
      role: "pharmacist",
      scope: input.goal,
      worktree: rootRecord.path,
      baseCommit: invocationBase,
      boundaryRoot: manager.boundaryRoot("root"),
      intent: input.intent,
    }
    const graph = new RunGraph({ id, sessionId: input.sessionId, repository, root, invocationBase })
    const controller = new AbortController()
    const runMs = input.timeouts?.runMs ?? 3_600_000
    const adapter = new OpenCodeExecutionAdapter({
      client: input.client,
      git: manager,
      parentSessionId: input.sessionId,
      authorizeSession: input.authorizeSession,
      cache: input.cache ?? { enabled: true, minFanout: 2 },
      signal: controller.signal,
      deadlineMs: Date.now() + runMs,
      timeouts: {
        promptMs: input.timeouts?.promptMs ?? 600_000,
        verificationMs: input.timeouts?.verificationMs ?? 120_000,
      },
    })
    const runtime = new RecursiveRuntime(graph, adapter, { ...defaultPolicy, ...input.policy })
    let handle!: RunHandle
    const persist = async (): Promise<void> => {
      await this.store.write({ ...graph.snapshot, worktrees: manager.recordsSnapshot() })
    }
    graph.onChange(() => {
      void persist().catch(() => undefined)
    })
    const runTimeout = setTimeout(
      () => controller.abort(new Error(`Maximum run time ${(input.timeouts?.runMs ?? 3_600_000) / 1_000}s exceeded`)),
      runMs,
    )
    runTimeout.unref()
    const promise = Promise.resolve()
      .then(() => runtime.execute(root))
      .then(async (result) => {
        await persist()
        return result
      })
      .finally(() => clearTimeout(runTimeout))
    handle = {
      id,
      sessionId: input.sessionId,
      repository,
      invocationBase,
      graph,
      git: manager,
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
    if (resident) return structuredClone(resident.graph.snapshot)
    const stored = id ? await this.store.read(repository, id) : await this.store.latest(repository, sessionId)
    if (stored.status !== "running") return stored
    return { ...stored, status: "interrupted", updatedAt: Date.now() }
  }

  async wait(directory: string, id: string | undefined, sessionId: string, timeoutSeconds: number): Promise<RunSnapshot> {
    const residentId = id ?? this.latestBySession.get(sessionId)
    const handle = residentId ? this.runs.get(residentId) : undefined
    if (handle) {
      await Promise.race([
        handle.promise,
        new Promise((resolveWait) => setTimeout(resolveWait, timeoutSeconds * 1_000)),
      ])
    }
    return this.snapshot(directory, id, sessionId)
  }

  async apply(directory: string, id: string | undefined, sessionId: string): Promise<RunSnapshot> {
    const repository = await repositoryRoot(directory)
    const residentId = id ?? this.latestBySession.get(sessionId)
    const handle = residentId ? this.runs.get(residentId) : undefined
    if (handle) {
      const result = await handle.promise
      if (!result.ok) throw new Error(`Run failed: ${result.reason}`)
    }
    const snapshot = await this.snapshot(directory, id, sessionId)
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
}
