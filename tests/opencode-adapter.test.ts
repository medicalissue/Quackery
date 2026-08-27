import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { GitWorkspaceManager } from "../src/git.js"
import type { NodeContext } from "../src/model.js"
import { OpenCodeExecutionAdapter, parseJsonResponse } from "../src/opencode-adapter.js"

const execFileAsync = promisify(execFile)

test("extracts a decomposer JSON object from an OpenCode text response", () => {
  const response = {
    data: {
      parts: [
        { type: "tool", name: "write" },
        { type: "text", text: "```json\n{\"kind\":\"refuse\",\"reason\":\"ambiguous\",\"detail\":\"missing owner\"}\n```" },
      ],
    },
  }
  expect(parseJsonResponse(response)).toEqual({
    kind: "refuse",
    reason: "ambiguous",
    detail: "missing owner",
  })
})

test("rejects verification commands that mutate the worktree", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quack-verification-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "base\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  const manager = new GitWorkspaceManager(repository, `verification-test-${randomUUID()}`)
  const base = await manager.initialize()
  const record = await manager.create("root", base)
  const boundaryRoot = manager.boundaryRoot("root")
  await mkdir(join(record.path, boundaryRoot), { recursive: true })
  await writeFile(join(record.path, boundaryRoot, "world.wit"), `
    package quackery:test@0.1.0;
    interface feature { run: func(); }
    world feature-world { export feature; }
  `)
  await writeFile(join(record.path, boundaryRoot, "behavior.md"), "# Feature\n")
  const boundary = await manager.commitAll("root", "boundary")
  const node: NodeContext = {
    id: "root",
    depth: 0,
    role: "surgeon",
    scope: "feature",
    worktree: record.path,
    baseCommit: base,
    boundaryRoot,
    plan: {
      id: "feature",
      kind: "leaf",
      scope: "feature",
      exports: ["feature"],
      imports: [],
      world: {
        witPath: `${boundaryRoot}/world.wit`,
        world: "feature-world",
        behaviorPath: `${boundaryRoot}/behavior.md`,
      },
      reads: [],
      artifacts: [],
      owns: [{ path: "feature.txt", mode: "exact" }],
      verify: ["printf mutation > generated.txt"],
      estimatedRemainingDepth: 0,
      estimatedWork: 1,
    },
  }
  const adapter = new OpenCodeExecutionAdapter({
    client: {
      session: {
        create: async () => ({ data: { id: "surgeon-session" } }),
        prompt: async () => {
          await writeFile(join(record.path, "feature.txt"), "implemented\n")
          return { data: { parts: [{ type: "text", text: JSON.stringify({ kind: "implemented", summary: "done" }) }] } }
        },
      },
    },
    git: manager,
    parentSessionId: "parent",
    authorizeSession() {},
    cache: { enabled: false, minFanout: 2 },
  })
  const result = await adapter.runLeaf(node, boundary)
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.reason).toBe("VERIFICATION_MUTATION")
  expect(result.recoverableCommit).toBeDefined()
})

test("aborts an OpenCode request at the configured prompt timeout", async () => {
  const node: NodeContext = {
    id: "root",
    depth: 0,
    role: "nurse",
    scope: "timeout",
    worktree: "/tmp",
    baseCommit: "base",
    boundaryRoot: ".quack/contracts/run/root",
  }
  const adapter = new OpenCodeExecutionAdapter({
    client: {
      session: {
        create: async () => ({ data: { id: "timeout-session" } }),
        prompt: async (input: any) => new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true })
        }),
      },
    },
    git: {} as GitWorkspaceManager,
    parentSessionId: "parent",
    authorizeSession() {},
    cache: { enabled: false, minFanout: 2 },
    timeouts: { promptMs: 10, verificationMs: 100 },
  })
  expect(adapter.decompose(node)).rejects.toThrow("OpenCode request timeout")
})

test("rejects a Nurse boundary commit that also changes product code", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quack-boundary-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "base\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  const manager = new GitWorkspaceManager(repository, `boundary-test-${randomUUID()}`)
  const base = await manager.initialize()
  const record = await manager.create("root/nurse", base)
  const boundaryRoot = manager.boundaryRoot("root/nurse")
  await mkdir(join(record.path, boundaryRoot), { recursive: true })
  await writeFile(join(record.path, boundaryRoot, "world.wit"), `
    package quackery:test@0.1.0;
    interface feature { run: func(); }
    world feature-world { export feature; }
  `)
  await writeFile(join(record.path, boundaryRoot, "behavior.md"), "# Feature\n")
  await writeFile(join(record.path, "product.ts"), "export const unsafe = true\n")
  const node: NodeContext = {
    id: "root/nurse",
    parentId: "root",
    depth: 1,
    role: "nurse",
    scope: "feature",
    worktree: record.path,
    baseCommit: base,
    boundaryRoot,
  }
  const adapter = new OpenCodeExecutionAdapter({
    client: { session: { create: async () => ({}), prompt: async () => ({}) } },
    git: manager,
    parentSessionId: "parent",
    authorizeSession() {},
    cache: { enabled: false, minFanout: 2 },
  })
  expect(adapter.commitBoundary(node, {
    kind: "leaf",
    leaf: {
      id: "feature",
      kind: "leaf",
      scope: "feature",
      exports: ["feature"],
      imports: [],
      world: {
        witPath: `${boundaryRoot}/world.wit`,
        world: "feature-world",
        behaviorPath: `${boundaryRoot}/behavior.md`,
      },
      reads: [],
      artifacts: [],
      owns: [{ path: "src/feature", mode: "prefix" }],
      verify: ["true"],
      estimatedRemainingDepth: 0,
      estimatedWork: 1,
    },
  })).rejects.toThrow("Node changed unowned paths: product.ts")
})
