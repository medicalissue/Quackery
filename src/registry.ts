import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { NodeContext, NodeResult } from "./model.js"
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
  authorizeSession(sessionId: string, node: NodeContext): void
  policy?: Partial<RuntimePolicy>
}

const defaultPolicy: RuntimePolicy = {
  maxDepth: 6,
  maxNodes: 32,
  maxDepthSkew: 1,
  maxWorkRatio: 2,
  allowJustifiedImbalance: true,
}

function runId(): string {
  return `q-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

export class RunRegistry {
  private readonly runs = new Map<string, RunHandle>()
  private readonly latestBySession = new Map<string, string>()

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
    }
    const graph = new RunGraph({ id, repository, root, invocationBase })
    const adapter = new OpenCodeExecutionAdapter({
      client: input.client,
      git: manager,
      parentSessionId: input.sessionId,
      authorizeSession: input.authorizeSession,
    })
    const runtime = new RecursiveRuntime(graph, adapter, { ...defaultPolicy, ...input.policy })
    const stateDirectory = await this.stateDirectory(repository)
    graph.onChange((snapshot) => {
      void writeFile(resolve(stateDirectory, `${id}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
    })
    const promise = runtime.execute(root)
    const handle: RunHandle = {
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
    return handle
  }

  get(id: string): RunHandle {
    const handle = this.runs.get(id)
    if (!handle) throw new Error(`Unknown or non-resident run ${id}`)
    return handle
  }

  latest(sessionId: string): RunHandle {
    const id = this.latestBySession.get(sessionId)
    if (!id) throw new Error("No Quackery run exists for this session")
    return this.get(id)
  }

  resolve(id: string | undefined, sessionId: string): RunHandle {
    return id ? this.get(id) : this.latest(sessionId)
  }

  private async stateDirectory(repository: string): Promise<string> {
    const common = await git(repository, ["rev-parse", "--git-common-dir"])
    const directory = resolve(repository, common, "quackery", "runs")
    await mkdir(directory, { recursive: true })
    return directory
  }
}
