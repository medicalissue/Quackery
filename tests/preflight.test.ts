import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { configuredRoleModel, quackConfigSchema, type ModelRole } from "../src/config.js"
import { runPreflight } from "../src/preflight.js"

const execFileAsync = promisify(execFile)
const roles: ModelRole[] = ["psychiatrist", "pharmacist", "nurse", "surgeon"]

test("preflight separates local readiness from live provider unknowns", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quack-preflight-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "base\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  const config = quackConfigSchema.parse({})
  const routing = Object.fromEntries(roles.map((role) => [role, configuredRoleModel(config, role)])) as any
  const ready = await runPreflight(repository, config, routing)
  expect(ready.ready).toBe(true)
  expect(ready.checks.find((check) => check.name === "live provider protocol")?.status).toBe("UNKNOWN")
  expect(ready.checks.find((check) => check.name === "provider cache")?.status).toBe("UNKNOWN")

  await writeFile(join(repository, "dirty.txt"), "dirty\n")
  const dirty = await runPreflight(repository, config, routing)
  expect(dirty.ready).toBe(false)
  expect(dirty.checks.find((check) => check.name === "invocation worktree")?.status).toBe("FAIL")
})
