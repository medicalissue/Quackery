import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { IntentRegistry } from "../src/intent.js"

const execFileAsync = promisify(execFile)

test("persists a session-scoped confirmed intent and rejects a moved repository base", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quack-intent-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "base\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await commit(repository, "base")

  const registry = new IntentRegistry()
  const intent = await registry.confirm(repository, "session-1", "psychiatrist", {
    goal: "add a verified feature",
    observableOutcomes: ["feature is visible"],
    inScope: ["feature"],
    outOfScope: ["unrelated cleanup"],
    constraints: ["preserve compatibility"],
    acceptance: ["bun test"],
    assumptions: [],
  })
  expect((await registry.resolve(repository, "session-1", intent.revision)).goal).toBe("add a verified feature")
  const revised = await registry.confirm(repository, "session-1", "psychiatrist", {
    goal: "add a revised verified feature",
    observableOutcomes: intent.observableOutcomes,
    inScope: intent.inScope,
    outOfScope: intent.outOfScope,
    constraints: intent.constraints,
    acceptance: intent.acceptance,
    assumptions: intent.assumptions,
  })
  expect((await registry.resolve(repository, "session-1")).revision).toBe(revised.revision)
  expect((await registry.resolve(repository, "session-1", intent.revision)).goal).toBe("add a verified feature")
  expect(registry.resolve(repository, "different-session")).rejects.toThrow("No confirmed Intent Contract")

  await writeFile(join(repository, "README.md"), "moved\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await commit(repository, "move base")
  expect(registry.resolve(repository, "session-1", intent.revision)).rejects.toThrow("Intent base moved")
})

async function commit(repository: string, message: string): Promise<void> {
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", message,
  ], { cwd: repository })
}
