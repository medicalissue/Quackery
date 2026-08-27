import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import type { NodeContext, NodePlan, RootSplitDecision } from "../src/model.js"
import type { ConfirmedIntent } from "../src/intent.js"
import { git } from "../src/git.js"
import { RunRegistry } from "../src/registry.js"

const execFileAsync = promisify(execFile)
const behaviorContract = `# Responsibility\nFixture capability.\n# Inputs\nDefined by WIT.\n# Outputs\nDefined by WIT.\n# Preconditions\nThe fixture repository exists.\n# Postconditions\nOwned output is present.\n# Invariants\nThe boundary remains stable.\n# Errors\nVerification failures.\n# Effects\nWrites owned fixture files.\n# Constraints\nNo unowned changes.\n# Non-goals\nImplementation details.\n`

test("root Pharmacist fans out only Nurses, which delegate atomic holes to parallel Surgeons", async () => {
  const repository = await repositoryFixture("quackery-e2e-")
  const base = await git(repository, ["rev-parse", "HEAD"])
  let nextSession = 0
  const sessions = new Map<string, string>()
  const sessionParents = new Map<string, string | undefined>()
  const sessionAgents = new Map<string, string>()
  const authorized = new Map<string, NodeContext>()
  const leafStarts: number[] = []
  const fakeClient = {
    session: {
      async create(input: any) {
        const id = `session-${nextSession++}`
        sessions.set(id, input.query.directory)
        sessionParents.set(id, input.body.parentID)
        return { data: { id } }
      },
      async prompt(input: any) {
        const directory = sessions.get(input.path.id)
        const node = authorized.get(input.path.id)
        if (!directory || !node?.plan) throw new Error(`unknown fake session ${input.path.id}`)
        sessionAgents.set(input.path.id, input.body.agent)
        if (input.body.agent === "nurse") {
          return jsonResponse({
            kind: "leaf",
            leaf: {
              ...node.plan,
              id: `${node.plan.id}-implementation`,
              kind: "leaf",
              estimatedRemainingDepth: 0,
            },
          })
        }
        if (input.body.agent !== "surgeon") throw new Error(`unexpected runtime agent ${input.body.agent}`)
        const path = node.plan.owns[0]?.path
        if (!path) throw new Error(`missing owned path for ${node.id}`)
        if (path === "a.txt" || path === "b.txt") leafStarts.push(Date.now())
        await Bun.sleep(100)
        const content = path === "index.txt"
          ? node.id.includes("integration-repair") ? "index repaired\n" : "index incomplete\n"
          : `${basename(path, ".txt")} implemented\n`
        await writeFile(join(directory, path), content)
        return jsonResponse({ kind: "implemented", summary: `${path} done` })
      },
    },
  }

  const registry = new RunRegistry()
  const handle = await registry.start({
    directory: repository,
    sessionId: "parent-session",
    goal: "implement a and b",
    intent: directIntent(repository, base, "parent-session", "implement a and b"),
    rootDecision: rootDecision(),
    artifacts: rootArtifacts(),
    client: fakeClient,
    authorizeSession: (id, node) => authorized.set(id, node),
    policy: { allowJustifiedImbalance: false },
  })
  const result = await handle.promise

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.evidence).toContainEqual(expect.objectContaining({
    command: "test -f a.txt && test -f b.txt && test \"$(cat index.txt)\" = \"index repaired\"",
    exitCode: 1,
  }))
  expect(leafStarts).toHaveLength(2)
  expect(Math.max(...leafStarts) - Math.min(...leafStarts)).toBeLessThan(250)
  expect(await readFile(join(repository, "README.md"), "utf8")).toBe("fixture\n")
  expect(await Bun.file(join(repository, "a.txt")).exists()).toBe(false)
  expect(await git(repository, ["show", `${result.headCommit}:a.txt`])).toBe("a implemented")
  expect(await git(repository, ["show", `${result.headCommit}:b.txt`])).toBe("b implemented")
  expect(await git(repository, ["show", `${result.headCommit}:index.txt`])).toBe("index repaired")
  expect(await git(repository, ["ls-tree", "-r", "--name-only", result.headCommit])).not.toContain(".quack/contracts/")
  expect(await git(repository, ["rev-list", "--count", `${base}..${result.headCommit}`])).toBe("1")
  expect(handle.graph.render()).toContain("nurse · implement a · verified")
  expect(handle.graph.render()).toContain("surgeon · implement a · verified")
  expect([...sessionAgents.values()]).not.toContain("pharmacist")
  expect([...sessionAgents.values()].filter((agent) => agent === "nurse")).toHaveLength(4)
  expect([...sessionAgents.values()].filter((agent) => agent === "surgeon")).toHaveLength(4)
  for (const [session, agent] of sessionAgents) {
    if (agent === "nurse") expect(sessionParents.get(session)).toBe("parent-session")
  }

  const worktrees = handle.git.recordsSnapshot()
  expect(worktrees).toHaveLength(9)
  expect(handle.graph.snapshot.nodes.find((node) => node.id === "root/integration-repair-1")?.status).toBe("verified")
  const restarted = new RunRegistry()
  const recovered = await restarted.snapshot(repository, handle.id, "parent-session")
  expect(recovered.status).toBe("verified")
  expect(recovered.resultCommit).toBe(result.headCommit)
  const qualification = await restarted.qualifySelfHost(repository, handle.id, "parent-session")
  expect(qualification.passed).toBe(false)
  expect(qualification.checks.find((check) => check.name === "normalized result")?.status).toBe("PASS")
  const terminalOperations = await Promise.allSettled([
    restarted.apply(repository, handle.id, "parent-session"),
    restarted.abandon(repository, handle.id, "parent-session"),
  ])
  const completed = terminalOperations.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<RunRegistry["apply"]>>> => item.status === "fulfilled")
  expect(completed).toHaveLength(1)
  expect(terminalOperations.filter((item) => item.status === "rejected")).toHaveLength(1)
  const terminal = completed[0]!.value
  expect(["applied", "abandoned"]).toContain(terminal.status)
  expect(terminal.cleanup?.failures).toEqual([])
  if (terminal.status === "applied") {
    expect(await readFile(join(repository, "a.txt"), "utf8")).toBe("a implemented\n")
    expect(await readFile(join(repository, "b.txt"), "utf8")).toBe("b implemented\n")
    expect(await readFile(join(repository, "index.txt"), "utf8")).toBe("index repaired\n")
  } else {
    expect(await Bun.file(join(repository, "a.txt")).exists()).toBe(false)
  }
  expect(await git(repository, ["ls-files", ".quack/contracts"])).toBe("")
  for (const worktree of worktrees) expect(access(worktree.path)).rejects.toThrow()
}, 20_000)

test("does not create a root checkout before the Nurse fan-out finishes", async () => {
  const repository = await repositoryFixture("quackery-no-root-checkout-")
  const base = await git(repository, ["rev-parse", "HEAD"])
  let releaseNurse!: () => void
  const nurseGate = new Promise<void>((resolve) => { releaseNurse = resolve })
  let nurseStarted!: () => void
  const started = new Promise<void>((resolve) => { nurseStarted = resolve })
  let nextSession = 0
  const sessions = new Map<string, string>()
  const authorized = new Map<string, NodeContext>()
  const agents: string[] = []
  const registry = new RunRegistry()
  const handle = await registry.start({
    directory: repository,
    sessionId: "single-parent",
    goal: "implement feature",
    intent: directIntent(repository, base, "single-parent", "implement feature"),
    rootDecision: {
      kind: "split",
      children: [scopePlan("feature", [], "feature-world", "feature.txt")],
      join: { verify: ["test -f feature.txt"] },
    },
    artifacts: [
      {
        path: "worlds.wit",
        content: `package quackery:single@0.1.0;
          interface feature { value: func() -> string; }
          world feature-world { export feature; }
        `,
      },
      { path: "behavior.md", content: behaviorContract },
      { path: "fixture.contract.ts", content: "export interface Feature { value(): string }\n" },
      { path: "fixture.stub.ts", content: "export const fixture = { value: () => \"\" }\n" },
      {
        path: "feature-world.binding.json",
        content: JSON.stringify({
          version: 1,
          world: "feature-world",
          export: { interface: "feature", symbol: "Feature" },
          imports: [],
        }),
      },
    ],
    client: {
      session: {
        async create(input: any) {
          const id = `single-${nextSession++}`
          sessions.set(id, input.query.directory)
          return { data: { id } }
        },
        async prompt(input: any) {
          const node = authorized.get(input.path.id)
          const directory = sessions.get(input.path.id)
          if (!node?.plan || !directory) throw new Error("unknown single session")
          agents.push(input.body.agent)
          if (input.body.agent === "nurse") {
            nurseStarted()
            await nurseGate
            return jsonResponse({
              kind: "leaf",
              leaf: { ...node.plan, id: "feature-implementation", kind: "leaf", estimatedRemainingDepth: 0 },
            })
          }
          await writeFile(join(directory, "feature.txt"), "implemented\n")
          return jsonResponse({ kind: "implemented", summary: "done" })
        },
      },
    },
    authorizeSession: (id, node) => authorized.set(id, node),
  })

  await started
  expect(handle.git.recordsSnapshot().map((record) => record.nodeId)).toEqual(["root/feature"])
  releaseNurse()
  const result = await handle.promise
  expect(result.ok).toBe(true)
  expect(agents).toEqual(["nurse", "surgeon"])
})

function rootDecision(): RootSplitDecision {
  return {
    kind: "split",
    children: [
      scopePlan("a", [], "a-world", "a.txt"),
      scopePlan("b", ["a"], "b-world", "b.txt"),
    ],
    join: {
      integration: {
        ...scopePlan("feature-integration", ["a", "b"], "feature-world", "index.txt"),
        exports: ["feature"],
      },
      verify: ["test -f a.txt && test -f b.txt && test \"$(cat index.txt)\" = \"index repaired\""],
    },
  }
}

function scopePlan(id: string, imports: string[], world: string, file: string): NodePlan & { kind: "scope" } {
  return {
    id,
    kind: "scope",
    scope: `implement ${id}`,
    exports: [id],
    imports,
    world: {
      witPath: "worlds.wit",
      world,
      behaviorPath: "behavior.md",
      projectionPath: "fixture.contract.ts",
      bindingPath: `${world}.binding.json`,
      stubs: imports.map((item) => ({ interface: item, path: "fixture.stub.ts" })),
    },
    reads: ["fixture.stub.ts"],
    artifacts: ["fixture.stub.ts"],
    owns: [{ path: file, mode: "exact" }],
    verify: [`test -f ${file}`],
    estimatedRemainingDepth: 1,
    estimatedWork: 1,
  }
}

function rootArtifacts() {
  return [
    {
      path: "worlds.wit",
      content: `package quackery:fixture@0.1.0;
        interface a { value: func() -> string; }
        interface b { value: func() -> string; }
        interface feature { value: func() -> string; }
        world a-world { export a; }
        world b-world { import a; export b; }
        world feature-world { import a; import b; export feature; }
      `,
    },
    { path: "behavior.md", content: behaviorContract },
    {
      path: "fixture.contract.ts",
      content: "export interface A { value(): string }\nexport interface B { value(): string }\nexport interface Feature { value(): string }\n",
    },
    { path: "fixture.stub.ts", content: "export const a = { value: () => \"\" }\nexport const b = { value: () => \"\" }\n" },
    ...[
      { world: "a-world", exported: "a", imports: [] },
      { world: "b-world", exported: "b", imports: ["a"] },
      { world: "feature-world", exported: "feature", imports: ["a", "b"] },
    ].map((binding) => ({
      path: `${binding.world}.binding.json`,
      content: JSON.stringify({
        version: 1,
        world: binding.world,
        export: { interface: binding.exported, symbol: `${binding.exported[0]?.toUpperCase()}${binding.exported.slice(1)}` },
        imports: binding.imports.map((item) => ({ interface: item, symbol: item })),
      }),
    })),
  ]
}

async function repositoryFixture(prefix: string): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), prefix))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "fixture\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  return repository
}

function jsonResponse(value: unknown) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(value) }] } }
}

function directIntent(repository: string, repositoryBase: string, sessionId: string, goal: string): ConfirmedIntent {
  return {
    revision: "intent-test",
    source: "pharmacist-direct",
    repository,
    repositoryBase,
    sessionId,
    confirmedAt: 1,
    goal,
    observableOutcomes: [goal],
    inScope: [],
    outOfScope: [],
    constraints: [],
    acceptance: ["Root verification passes"],
    assumptions: [],
  }
}
