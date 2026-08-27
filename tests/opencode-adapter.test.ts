import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { git, GitWorkspaceManager } from "../src/git.js"
import type { NodeContext } from "../src/model.js"
import { OpenCodeExecutionAdapter, parseJsonResponse, responseFailure } from "../src/opencode-adapter.js"

const execFileAsync = promisify(execFile)
const behaviorContract = `# Responsibility\nAdapter fixture.\n# Inputs\nDefined by WIT.\n# Outputs\nDefined by WIT.\n# Preconditions\nNone.\n# Postconditions\nThe output is verifiable.\n# Invariants\nThe interface remains stable.\n# Errors\nVerification failures.\n# Effects\nWrites owned files.\n# Constraints\nOwned paths only.\n# Non-goals\nImplementation details.\n`

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

test("surfaces SDK and assistant errors instead of reporting empty JSON", () => {
  const transport = {
    data: undefined,
    error: { name: "BadRequestError", data: { message: "unknown model" } },
    response: { status: 400, statusText: "Bad Request" },
  }
  expect(responseFailure(transport)).toBe("BadRequestError: unknown model")
  expect(() => parseJsonResponse(transport)).toThrow("Agent request failed: BadRequestError: unknown model")

  const assistant = {
    data: {
      info: { error: { name: "APIError", data: { message: "provider unavailable" } } },
      parts: [],
    },
  }
  expect(() => parseJsonResponse(assistant)).toThrow("Agent request failed: APIError: provider unavailable")
})

test("accepts direct structured output and retries one malformed protocol response", async () => {
  expect(parseJsonResponse({ data: { kind: "refuse", reason: "bounded", detail: "direct" } })).toEqual({
    kind: "refuse",
    reason: "bounded",
    detail: "direct",
  })

  const prompts: string[] = []
  const node: NodeContext = {
    id: "root",
    depth: 0,
    role: "nurse",
    scope: "protocol correction",
    worktree: "/tmp",
    baseCommit: "base",
    boundaryRoot: ".quack/contracts/run/root",
  }
  const adapter = new OpenCodeExecutionAdapter({
    client: {
      session: {
        create: async () => ({ data: { id: "correction-session" } }),
        prompt: async (input: any) => {
          prompts.push(input.body.parts[0].text)
          return prompts.length === 1
            ? { data: { parts: [{ type: "text", text: "not json" }] } }
            : { data: { parts: [{ type: "text", text: JSON.stringify({
                kind: "refuse",
                reason: "bounded",
                detail: "corrected",
              }) }] } }
        },
      },
    },
    git: {} as GitWorkspaceManager,
    parentSessionId: "parent",
    authorizeSession() {},
    cache: { enabled: false, minFanout: 2 },
    protocolAttempts: 2,
  })
  await expect(adapter.decompose(node)).resolves.toMatchObject({ kind: "refuse", detail: "corrected" })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain("violated the required structured protocol")
})

test("opens a fresh Nurse session when decomposition session creation failed", async () => {
  let creates = 0
  const node: NodeContext = {
    id: "root/retry",
    depth: 1,
    role: "nurse",
    scope: "retry session creation",
    worktree: "/tmp",
    baseCommit: "base",
    boundaryRoot: ".quack/contracts/run/retry",
  }
  const adapter = new OpenCodeExecutionAdapter({
    client: {
      session: {
        create: async () => {
          creates += 1
          if (creates === 1) throw new Error("transient session failure")
          return { data: { id: "replacement-session" } }
        },
        prompt: async () => ({ data: { parts: [{ type: "text", text: JSON.stringify({
          kind: "refuse",
          reason: "bounded",
          detail: "replacement session worked",
        }) }] } }),
      },
    },
    git: {} as GitWorkspaceManager,
    parentSessionId: "parent",
    authorizeSession() {},
    cache: { enabled: false, minFanout: 2 },
    protocolAttempts: 1,
  })

  await expect(adapter.decompose(node)).rejects.toThrow("transient session failure")
  await expect(adapter.reviseDecomposition(node, new Error("retry"), 2))
    .resolves.toMatchObject({ kind: "refuse", detail: "replacement session worked" })
  expect(creates).toBe(2)
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
  await writeFile(join(record.path, boundaryRoot, "behavior.md"), behaviorContract)
  await writeFile(join(record.path, boundaryRoot, "projection.ts"), "export interface Feature { run(): void }\n")
  await writeFile(join(record.path, boundaryRoot, "binding.json"), JSON.stringify({
    version: 1,
    world: "feature-world",
    export: { interface: "feature", symbol: "Feature" },
    imports: [],
  }))
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
        projectionPath: `${boundaryRoot}/projection.ts`,
        bindingPath: `${boundaryRoot}/binding.json`,
        stubs: [],
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

test("preserves a committed failed attempt and rewinds the isolated worktree before a Nurse bounce", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quack-nurse-rewind-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "base\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  const manager = new GitWorkspaceManager(repository, `rewind-test-${randomUUID()}`)
  const base = await manager.initialize()
  const record = await manager.create("leaf", base)
  await writeFile(join(record.path, "feature.txt"), "failed attempt\n")
  const failedCommit = await manager.commitAll("leaf", "failed implementation")
  const node: NodeContext = {
    id: "leaf",
    depth: 1,
    role: "surgeon",
    scope: "feature",
    worktree: record.path,
    baseCommit: base,
    boundaryRoot: manager.boundaryRoot("leaf"),
  }
  const adapter = new OpenCodeExecutionAdapter({
    client: { session: { create: async () => ({}), prompt: async () => ({}) } },
    git: manager,
    parentSessionId: "parent",
    authorizeSession() {},
    cache: { enabled: false, minFanout: 2 },
  })

  expect(await adapter.prepareNeedsNurse(node)).toBe(failedCommit)
  expect(await manager.head("leaf")).toBe(base)
  expect(await git(repository, ["branch", "--contains", failedCommit, "--format=%(refname:short)"]))
    .toContain(record.branch)
  expect((await manager.cleanup()).failures).toEqual([])
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

test("bounds concurrent provider prompts and stops after the observed cost limit", async () => {
  let nextSession = 0
  let active = 0
  let maxActive = 0
  let promptCalls = 0
  const client = {
    session: {
      create: async () => ({ data: { id: `bounded-${nextSession++}` } }),
      prompt: async () => {
        promptCalls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(15)
        active -= 1
        return {
          data: {
            info: {
              tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0.25,
            },
            parts: [{ type: "text", text: JSON.stringify({
              kind: "refuse",
              reason: "probe",
              detail: "bounded",
            }) }],
          },
        }
      },
    },
  }
  const adapter = new OpenCodeExecutionAdapter({
    client,
    git: {} as GitWorkspaceManager,
    parentSessionId: "parent",
    authorizeSession() {},
    cache: { enabled: false, minFanout: 2 },
    protocolAttempts: 1,
    maxConcurrency: 1,
    maxObservedCost: 0.5,
  })
  const node = (id: string): NodeContext => ({
    id,
    depth: 1,
    role: "nurse",
    scope: id,
    worktree: "/tmp",
    baseCommit: "base",
    boundaryRoot: `.quack/contracts/run/${id}`,
  })

  await Promise.all([adapter.decompose(node("a")), adapter.decompose(node("b"))])
  expect(maxActive).toBe(1)
  expect(promptCalls).toBe(2)
  await expect(adapter.decompose(node("c"))).rejects.toThrow("reached limit $0.5000")
  expect(promptCalls).toBe(2)
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
  await writeFile(join(record.path, boundaryRoot, "behavior.md"), behaviorContract)
  await writeFile(join(record.path, boundaryRoot, "projection.ts"), "export interface Feature { run(): void }\n")
  await writeFile(join(record.path, boundaryRoot, "binding.json"), JSON.stringify({
    version: 1,
    world: "feature-world",
    export: { interface: "feature", symbol: "Feature" },
    imports: [],
  }))
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
        projectionPath: `${boundaryRoot}/projection.ts`,
        bindingPath: `${boundaryRoot}/binding.json`,
        stubs: [],
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
