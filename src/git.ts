import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { BoundaryArtifact, OwnershipRule, VerificationEvidence } from "./model.js"
import { assertChangedPathsOwned, normalizeOwnedPath } from "./validation.js"

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

function scopedName(value: string): string {
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 10)
  return `${safeName(value).slice(0, 55)}-${suffix}`
}

export interface WorktreeRecord {
  nodeId: string
  path: string
  branch: string
}

export interface CleanupReport {
  removedWorktrees: string[]
  removedBranches: string[]
  failures: string[]
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
    const name = scopedName(nodeId)
    const path = join(this.worktreeBase, name)
    const branch = `quackery/${safeName(this.runId)}/${name}`
    await git(this.repository, ["worktree", "add", "-b", branch, path, baseCommit])
    const record = { nodeId, path, branch }
    this.records.set(nodeId, record)
    return record
  }

  has(nodeId: string): boolean {
    return this.records.has(nodeId)
  }

  async createSyntheticBoundary(baseCommit: string, artifacts: BoundaryArtifact[]): Promise<string> {
    if (artifacts.length === 0) throw new Error("A root boundary requires at least one artifact")
    const normalized = artifacts.map((artifact) => ({
      path: normalizeOwnedPath(artifact.path),
      content: artifact.content,
    }))
    const unique = new Set(normalized.map((artifact) => artifact.path))
    if (unique.size !== normalized.length) throw new Error("Root boundary artifact paths must be unique")
    const contractRoot = this.contractRunRoot()
    for (const artifact of normalized) {
      if (artifact.path !== contractRoot && !artifact.path.startsWith(`${contractRoot}/`)) {
        throw new Error(`Root boundary artifact ${artifact.path} must be under ${contractRoot}`)
      }
    }

    const indexDirectory = await mkdtemp(join(tmpdir(), "quackery-boundary-index-"))
    const env = { ...process.env, GIT_INDEX_FILE: join(indexDirectory, "index") }
    try {
      await execute("git", ["read-tree", baseCommit], { cwd: this.repository, env })
      for (let index = 0; index < normalized.length; index += 1) {
        const artifact = normalized[index]
        if (!artifact) continue
        const source = join(indexDirectory, `artifact-${index}`)
        await writeFile(source, artifact.content, "utf8")
        const blob = (await execute("git", ["hash-object", "-w", source], { cwd: this.repository, env })).stdout.trim()
        await execute(
          "git",
          ["update-index", "--add", "--cacheinfo", `100644,${blob},${artifact.path}`],
          { cwd: this.repository, env },
        )
      }
      const tree = (await execute("git", ["write-tree"], { cwd: this.repository, env })).stdout.trim()
      return (await execute("git", [
        "-c", "user.name=Quackery", "-c", "user.email=quackery@local",
        "commit-tree", tree, "-p", baseCommit, "-m", "quackery(root): freeze abstract worlds",
      ], { cwd: this.repository, env })).stdout.trim()
    } finally {
      await rm(indexDirectory, { recursive: true, force: true })
    }
  }

  get(nodeId: string): WorktreeRecord {
    const record = this.records.get(nodeId)
    if (!record) throw new Error(`Unknown worktree for ${nodeId}`)
    return record
  }

  boundaryRoot(nodeId: string): string {
    return `${this.contractRunRoot()}/${scopedName(nodeId)}`
  }

  contractRunRoot(): string {
    return `.quack/contracts/${safeName(this.runId)}`
  }

  recordsSnapshot(): WorktreeRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }))
  }

  restoreRecords(records: WorktreeRecord[]): void {
    for (const record of records) {
      const name = scopedName(record.nodeId)
      const expectedPath = join(this.worktreeBase, name)
      const expectedBranch = `quackery/${safeName(this.runId)}/${name}`
      if (record.path !== expectedPath || record.branch !== expectedBranch) {
        throw new Error(`Persisted worktree record for ${record.nodeId} does not match run ${this.runId}`)
      }
      this.records.set(record.nodeId, { ...record })
    }
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

  async stashUncommitted(nodeId: string, message: string): Promise<string | undefined> {
    const worktree = this.get(nodeId).path
    const status = await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])
    if (!status) return undefined
    await git(worktree, ["stash", "push", "--include-untracked", "-m", message])
    return git(worktree, ["rev-parse", "stash@{0}"])
  }

  async worktreeChanges(nodeId: string): Promise<string[]> {
    const worktree = this.get(nodeId).path
    const status = await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])
    return status ? status.split("\n").filter(Boolean) : []
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
        const result = await execute("/bin/sh", ["-lc", command], { cwd: worktree, timeout })
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
      await git(worktree, [
        "-c", "user.name=Quackery", "-c", "user.email=quackery@local",
        "cherry-pick", commit,
      ])
    }
  }

  async normalizedResultCommit(nodeId: string, invocationBase: string, message: string): Promise<string> {
    const worktree = this.get(nodeId).path
    const indexDirectory = await mkdtemp(join(tmpdir(), "quackery-index-"))
    const env = { ...process.env, GIT_INDEX_FILE: join(indexDirectory, "index") }
    try {
      await execute("git", ["read-tree", "HEAD"], { cwd: worktree, env })
      await execute("git", [
        "reset", "-q", invocationBase, "--", this.contractRunRoot(),
      ], { cwd: worktree, env })
      const tree = (await execute("git", ["write-tree"], { cwd: worktree, env })).stdout.trim()
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
    } finally {
      await rm(indexDirectory, { recursive: true, force: true })
    }
  }

  async applyResult(invocationBase: string, resultCommit: string): Promise<void> {
    await assertCleanRepository(this.repository)
    const current = await git(this.repository, ["rev-parse", "HEAD"])
    if (current !== invocationBase) {
      throw new Error(`Invocation branch moved from ${invocationBase} to ${current}; result was preserved at ${resultCommit}`)
    }
    try {
      await git(this.repository, [
        "-c", "user.name=Quackery", "-c", "user.email=quackery@local",
        "cherry-pick", resultCommit,
      ])
    } catch (error) {
      try {
        await git(this.repository, ["cherry-pick", "--abort"])
      } catch {
        // Preserve the original cherry-pick failure; the caller reports that
        // the verified result commit remains recoverable.
      }
      throw error
    }
  }

  async cleanup(): Promise<CleanupReport> {
    const report: CleanupReport = { removedWorktrees: [], removedBranches: [], failures: [] }
    const records = [...this.records.values()].sort((a, b) => b.nodeId.length - a.nodeId.length)
    for (const record of records) {
      let worktreeExists = true
      try {
        await access(record.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") worktreeExists = false
        else {
          report.failures.push(error instanceof Error ? error.message : String(error))
          continue
        }
      }
      if (worktreeExists) {
        try {
          await git(this.repository, ["worktree", "remove", "--force", record.path])
          report.removedWorktrees.push(record.path)
        } catch (error) {
          report.failures.push(error instanceof Error ? error.message : String(error))
          continue
        }
      }
      try {
        const branch = await git(this.repository, ["branch", "--list", record.branch])
        if (branch) {
          await git(this.repository, ["branch", "-D", record.branch])
          report.removedBranches.push(record.branch)
        }
        this.records.delete(record.nodeId)
      } catch (error) {
        report.failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (report.failures.length === 0) {
      try {
        await rmdir(this.worktreeBase)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          report.failures.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
    return report
  }
}
