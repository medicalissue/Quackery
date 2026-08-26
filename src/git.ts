import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { OwnershipRule, VerificationEvidence } from "./model.js"
import { assertChangedPathsOwned } from "./validation.js"

const execFileAsync = promisify(execFile)

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly output: string,
  ) {
    super(`${command} exited with ${exitCode}`)
    this.name = "CommandError"
  }
}

async function execute(
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: options.env ?? process.env,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const details = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
    const output = `${details.stdout ?? ""}${details.stderr ?? ""}`.trim()
    throw new CommandError([file, ...args].join(" "), typeof details.code === "number" ? details.code : 1, output)
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute("git", args, { cwd })
  return result.stdout.trim()
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--show-toplevel"])
}

export async function assertCleanRepository(cwd: string): Promise<void> {
  await git(cwd, ["rev-parse", "--is-inside-work-tree"])
  const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (status) throw new Error(`Invocation worktree is dirty:\n${status}`)
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "node"
}

export interface WorktreeRecord {
  nodeId: string
  path: string
  branch: string
}

export class GitWorkspaceManager {
  readonly worktreeBase: string
  private readonly records = new Map<string, WorktreeRecord>()

  constructor(
    readonly repository: string,
    readonly runId: string,
    worktreeBase?: string,
  ) {
    this.worktreeBase = worktreeBase ?? join(tmpdir(), `quackery-${safeName(runId)}`)
  }

  async initialize(): Promise<string> {
    await assertCleanRepository(this.repository)
    await mkdir(this.worktreeBase, { recursive: true })
    return git(this.repository, ["rev-parse", "HEAD"])
  }

  async create(nodeId: string, baseCommit: string): Promise<WorktreeRecord> {
    const name = safeName(nodeId)
    const path = join(this.worktreeBase, name)
    const branch = `quackery/${safeName(this.runId)}/${name}`
    await git(this.repository, ["worktree", "add", "-b", branch, path, baseCommit])
    const record = { nodeId, path, branch }
    this.records.set(nodeId, record)
    return record
  }

  get(nodeId: string): WorktreeRecord {
    const record = this.records.get(nodeId)
    if (!record) throw new Error(`Unknown worktree for ${nodeId}`)
    return record
  }

  async head(nodeId: string): Promise<string> {
    return git(this.get(nodeId).path, ["rev-parse", "HEAD"])
  }

  async commitAll(nodeId: string, message: string): Promise<string> {
    const worktree = this.get(nodeId).path
    const status = await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])
    if (!status) return git(worktree, ["rev-parse", "HEAD"])
    await git(worktree, ["add", "-A"])
    await git(worktree, [
      "-c",
      "user.name=Quackery",
      "-c",
      "user.email=quackery@local",
      "commit",
      "-m",
      message,
    ])
    return git(worktree, ["rev-parse", "HEAD"])
  }

  async changedPaths(nodeId: string, baseCommit: string, headCommit?: string): Promise<string[]> {
    const worktree = this.get(nodeId).path
    const head = headCommit ?? (await git(worktree, ["rev-parse", "HEAD"]))
    const output = await git(worktree, ["diff", "--name-only", "-z", `${baseCommit}..${head}`])
    return output.split("\0").filter(Boolean).sort()
  }

  async assertOwned(nodeId: string, baseCommit: string, owns: OwnershipRule[], headCommit?: string): Promise<string[]> {
    const paths = await this.changedPaths(nodeId, baseCommit, headCommit)
    assertChangedPathsOwned(paths, owns)
    return paths
  }

  async verify(nodeId: string, commands: string[], timeout = 120_000): Promise<VerificationEvidence[]> {
    const worktree = this.get(nodeId).path
    const evidence: VerificationEvidence[] = []
    for (const command of commands) {
      try {
        const result = await execute("/bin/zsh", ["-lc", command], { cwd: worktree, timeout })
        evidence.push({ command, exitCode: 0, output: `${result.stdout}${result.stderr}`.trim().slice(-20_000) })
      } catch (error) {
        if (error instanceof CommandError) {
          evidence.push({ command, exitCode: error.exitCode, output: error.output.slice(-20_000) })
        } else {
          evidence.push({ command, exitCode: 1, output: String(error).slice(-20_000) })
        }
        break
      }
    }
    return evidence
  }

  async cherryPick(nodeId: string, commits: string[]): Promise<void> {
    const worktree = this.get(nodeId).path
    for (const commit of commits) {
      await git(worktree, ["cherry-pick", commit])
    }
  }

  async normalizedResultCommit(nodeId: string, invocationBase: string, message: string): Promise<string> {
    const worktree = this.get(nodeId).path
    const tree = await git(worktree, ["rev-parse", "HEAD^{tree}"])
    return git(worktree, [
      "-c",
      "user.name=Quackery",
      "-c",
      "user.email=quackery@local",
      "commit-tree",
      tree,
      "-p",
      invocationBase,
      "-m",
      message,
    ])
  }

  async applyResult(invocationBase: string, resultCommit: string): Promise<void> {
    await assertCleanRepository(this.repository)
    const current = await git(this.repository, ["rev-parse", "HEAD"])
    if (current !== invocationBase) {
      throw new Error(`Invocation branch moved from ${invocationBase} to ${current}; result was preserved at ${resultCommit}`)
    }
    await git(this.repository, ["cherry-pick", resultCommit])
  }
}
