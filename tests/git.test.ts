import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { GitWorkspaceManager, git } from "../src/git.js"

const execFileAsync = promisify(execFile)

test("Git freezes a boundary, preserves the checkout, and applies one result commit", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quackery-git-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "feature.txt"), "base\n")
  await execFileAsync("git", ["add", "feature.txt"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })

  const worktreeBase = await mkdtemp(join(tmpdir(), "quackery-worktrees-"))
  const manager = new GitWorkspaceManager(repository, "test-run", worktreeBase)
  const base = await manager.initialize()
  const root = await manager.create("root", base)
  await writeFile(join(root.path, "feature.txt"), "implemented\n")
  await manager.commitAll("root", "implement")
  const result = await manager.normalizedResultCommit("root", base, "result")

  expect(await readFile(join(repository, "feature.txt"), "utf8")).toBe("base\n")
  expect(await manager.assertOwned("root", base, [{ path: "feature.txt", mode: "exact" }], result)).toEqual(["feature.txt"])
  expect(await git(repository, ["rev-list", "--count", `${base}..${result}`])).toBe("1")

  await manager.applyResult(base, result)
  expect(await readFile(join(repository, "feature.txt"), "utf8")).toBe("implemented\n")
})
