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
        world: { witPath: "world.wit", world: "timeout-nurse", behaviorPath: "behavior.md" },
        reads: [],
        artifacts: [],
        owns: [{ path: "src/timeout", mode: "prefix" }],
        verify: ["true"],
        estimatedRemainingDepth: 1,
        estimatedWork: 1,
      }],
      join: { verify: [] },
    },
    artifacts: [
      {
        path: "world.wit",
        content: `package quackery:timeout@0.1.0;
          interface timeout-work { run: func(); }
          world timeout-nurse { export timeout-work; }
        `,
      },
      { path: "behavior.md", content: "# timeout\n" },
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

  const statePath = join(repository, ".git", "quackery", "runs", `${handle.id}.json`)
  const persisted = JSON.parse(await readFile(statePath, "utf8"))
  persisted.status = "running"
  await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`)
  const interrupted = await new RunRegistry().snapshot(repository, handle.id, "timeout-parent")
  expect(interrupted.status).toBe("interrupted")
  expect(new RunRegistry().snapshot(repository, "../escape", "timeout-parent")).rejects.toThrow("Invalid Quackery run ID")
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
    observableOutcomes: [],
    inScope: [],
    outOfScope: [],
    constraints: [],
    acceptance: [],
    assumptions: [],
  }
}
