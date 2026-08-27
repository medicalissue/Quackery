import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ConfirmedIntent } from "../src/intent.js"
import { git } from "../src/git.js"
import { RunRegistry } from "../src/registry.js"

const execFileAsync = promisify(execFile)
const behaviorContract = `# Responsibility\nTimeout fixture.\n# Inputs\nDefined by WIT.\n# Outputs\nDefined by WIT.\n# Preconditions\nNone.\n# Postconditions\nThe result is observable.\n# Invariants\nThe boundary is stable.\n# Errors\nTimeout.\n# Effects\nNone.\n# Constraints\nBounded execution.\n# Non-goals\nImplementation details.\n`

test("run timeout aborts a signal-aware OpenCode request and persists failure", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quack-run-timeout-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "base\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  const base = await git(repository, ["rev-parse", "HEAD"])
  const registry = new RunRegistry()
  const handle = await registry.start({
    directory: repository,
    sessionId: "timeout-parent",
    goal: "timeout",
    intent: intent(repository, base),
    rootDecision: {
      kind: "split",
      children: [{
        id: "timeout-work",
        kind: "scope",
        scope: "timeout work",
        exports: ["timeout-work"],
        imports: [],
        world: {
          witPath: "world.wit",
          world: "timeout-nurse",
          behaviorPath: "behavior.md",
          projectionPath: "projection.ts",
          bindingPath: "binding.json",
          stubs: [],
        },
        reads: [],
        artifacts: [],
        owns: [{ path: "src/timeout", mode: "prefix" }],
        verify: ["true"],
        estimatedRemainingDepth: 1,
        estimatedWork: 1,
      }],
      join: { verify: ["true"] },
    },
    artifacts: [
      {
        path: "world.wit",
        content: `package quackery:timeout@0.1.0;
          interface timeout-work { run: func(); }
          world timeout-nurse { export timeout-work; }
        `,
      },
      { path: "behavior.md", content: behaviorContract },
      { path: "projection.ts", content: "export interface TimeoutWork { run(): void }\n" },
      {
        path: "binding.json",
        content: JSON.stringify({
          version: 1,
          world: "timeout-nurse",
          export: { interface: "timeout-work", symbol: "TimeoutWork" },
          imports: [],
        }),
      },
    ],
    client: {
      session: {
        create: async () => ({ data: { id: "timeout-session" } }),
        prompt: async (input: any) => new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true })
        }),
      },
    },
    authorizeSession() {},
    timeouts: { runMs: 15, promptMs: 1_000, verificationMs: 1_000 },
  })
  const result = await handle.promise
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toBe("Child root/timeout-work failed: Decomposition failed")
  expect(result.detail).toContain("Maximum run time")
  const recovered = await new RunRegistry().snapshot(repository, handle.id, "timeout-parent")
  expect(recovered.status).toBe("failed")
  await expect(new RunRegistry().snapshot(repository, handle.id, "other-session"))
    .rejects.toThrow("belongs to a different OpenCode session")

  const statePath = join(repository, ".git", "quackery", "runs", `${handle.id}.json`)
  const persisted = JSON.parse(await readFile(statePath, "utf8"))
  persisted.status = "running"
  persisted.lease = { id: "another-runtime", processId: 123, heartbeatAt: Date.now() }
  await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`)
  const restarted = new RunRegistry()
  expect((await restarted.snapshot(repository, handle.id, "timeout-parent")).status).toBe("running")
  await expect(restarted.cancel(repository, handle.id, "timeout-parent"))
    .rejects.toThrow("active lease in another Quackery runtime")
  delete persisted.lease
  await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`)
  const interrupted = await restarted.snapshot(repository, handle.id, "timeout-parent")
  expect(interrupted.status).toBe("interrupted")
  expect(new RunRegistry().snapshot(repository, "../escape", "timeout-parent")).rejects.toThrow("Invalid Quackery run ID")
  const canceled = await restarted.cancel(repository, handle.id, "timeout-parent")
  expect(canceled.status).toBe("canceled")
  expect(canceled.nodes.every((node) => ["failed", "refused", "verified", "canceled"].includes(node.status))).toBe(true)
  const abandoned = await restarted.abandon(repository, handle.id, "timeout-parent")
  expect(abandoned.status).toBe("abandoned")
  expect(abandoned.cleanup?.failures).toEqual([])
  expect(abandoned.worktrees).toEqual([])
})

test("a recovered stale lease cannot be overwritten by its former runtime", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quack-stale-lease-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "base\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  const base = await git(repository, ["rev-parse", "HEAD"])
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const promptStarted = new Promise<void>((resolve) => { started = resolve })
  const owner = new RunRegistry()
  const handle = await owner.start({
    directory: repository,
    sessionId: "lease-session",
    goal: "hold a leased run",
    intent: { ...intent(repository, base), sessionId: "lease-session" },
    rootDecision: {
      kind: "split",
      children: [{
        id: "lease-work",
        kind: "scope",
        scope: "lease work",
        exports: ["lease-work"],
        imports: [],
        world: {
          witPath: "world.wit",
          world: "lease-world",
          behaviorPath: "behavior.md",
          projectionPath: "projection.ts",
          bindingPath: "binding.json",
          stubs: [],
        },
        reads: [],
        owns: [{ path: "lease.txt", mode: "exact" }],
        verify: ["test -f lease.txt"],
        estimatedRemainingDepth: 1,
        estimatedWork: 1,
      }],
      join: { verify: ["test -f lease.txt"] },
    },
    artifacts: [
      {
        path: "world.wit",
        content: "package quackery:lease@0.1.0; interface lease-work { run: func(); } world lease-world { export lease-work; }",
      },
      { path: "behavior.md", content: behaviorContract },
      { path: "projection.ts", content: "export interface LeaseWork { run(): void }\n" },
      {
        path: "binding.json",
        content: JSON.stringify({
          version: 1,
          world: "lease-world",
          export: { interface: "lease-work", symbol: "LeaseWork" },
          imports: [],
        }),
      },
    ],
    client: {
      session: {
        create: async () => ({ data: { id: "lease-worker" } }),
        prompt: async () => {
          started()
          await gate
          return { data: { parts: [{ type: "text", text: JSON.stringify({
            kind: "refuse",
            reason: "stopped",
            detail: "lease was recovered",
          }) }] } }
        },
      },
    },
    authorizeSession() {},
    timeouts: { runMs: 10_000, promptMs: 10_000, verificationMs: 1_000 },
  })
  await promptStarted
  await Bun.sleep(100)
  const statePath = join(repository, ".git", "quackery", "runs", `${handle.id}.json`)
  const stale = JSON.parse(await readFile(statePath, "utf8"))
  stale.lease.heartbeatAt = 0
  await writeFile(statePath, `${JSON.stringify(stale, null, 2)}\n`)

  const recovery = new RunRegistry()
  expect((await recovery.cancel(repository, handle.id, "lease-session")).status).toBe("canceled")
  release()
  await expect(handle.promise).rejects.toThrow("no longer owns persisted state")
  expect((await recovery.snapshot(repository, handle.id, "lease-session")).status).toBe("canceled")
  expect((await recovery.abandon(repository, handle.id, "lease-session")).status).toBe("abandoned")
})

function intent(repository: string, repositoryBase: string): ConfirmedIntent {
  return {
    revision: "intent-timeout",
    source: "pharmacist-direct",
    repository,
    repositoryBase,
    sessionId: "timeout-parent",
    confirmedAt: 1,
    goal: "timeout",
    observableOutcomes: ["The timeout boundary is exercised"],
    inScope: [],
    outOfScope: [],
    constraints: [],
    acceptance: ["The run records its timeout"],
    assumptions: [],
  }
}
