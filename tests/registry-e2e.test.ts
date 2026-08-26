import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import type { NodeContext } from "../src/model.js"
import type { ConfirmedIntent } from "../src/intent.js"
import { git } from "../src/git.js"
import { RunRegistry } from "../src/registry.js"

const execFileAsync = promisify(execFile)

test("fake OpenCode sessions fill two holes in parallel and return one root commit", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quackery-e2e-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "fixture\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  const base = await git(repository, ["rev-parse", "HEAD"])

  let nextSession = 0
  const sessions = new Map<string, string>()
  const sessionParents = new Map<string, string | undefined>()
  const sessionAgents = new Map<string, string>()
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
        if (!directory) throw new Error(`unknown fake session ${input.path.id}`)
        sessionAgents.set(input.path.id, input.body.agent)
        if (input.body.agent === "pharmacist") {
          const node = authorized.get(input.path.id)
          if (!node) throw new Error("pharmacist session was not authorized")
          await mkdir(join(directory, node.boundaryRoot), { recursive: true })
          await writeFile(join(directory, node.boundaryRoot, "worlds.wit"), `
            package quackery:fixture@0.1.0;
            interface a { value: func() -> string; }
            interface b { value: func() -> string; }
            interface feature { value: func() -> string; }
            world a-surgeon { export a; }
            world b-surgeon { import a; export b; }
            world feature-surgeon { import a; import b; export feature; }
          `)
          await writeFile(join(directory, node.boundaryRoot, "behavior.md"), "# a\nWrite a.txt.\n\n# b\nWrite b.txt.\n")
          await writeFile(join(directory, node.boundaryRoot, "a.stub.ts"), "export interface A { value(): string }\n")
          const witPath = `${node.boundaryRoot}/worlds.wit`
          const behaviorPath = `${node.boundaryRoot}/behavior.md`
          const stubPath = `${node.boundaryRoot}/a.stub.ts`
          return jsonResponse({
            kind: "split",
            children: [
              leafPlan("a", [], "a-surgeon", "a.txt", witPath, behaviorPath, stubPath),
              {
                ...leafPlan("b", ["a"], "b-surgeon", "b.txt", witPath, behaviorPath, stubPath),
                kind: "scope",
                estimatedRemainingDepth: 1,
              },
            ],
            join: {
              integration: {
                ...leafPlan(
                  "feature-join",
                  ["a", "b"],
                  "feature-surgeon",
                  "index.txt",
                  witPath,
                  behaviorPath,
                  stubPath,
                ),
                exports: ["feature"],
              },
              verify: ["test -f a.txt && test -f b.txt && test -f index.txt"],
            },
          })
        }

        if (input.body.agent === "nurse") {
          const inherited = authorized.get(input.path.id)?.plan
          if (!inherited) throw new Error("nurse session has no inherited plan")
          return jsonResponse({
            kind: "leaf",
            leaf: { ...inherited, kind: "leaf", estimatedRemainingDepth: 0 },
          })
        }

        const plan = authorized.get(input.path.id)?.plan
        const leaf = plan?.owns[0]?.path === "index.txt" ? "index" : plan?.id
        if (leaf !== "a" && leaf !== "b" && leaf !== "index") throw new Error(`unknown leaf for ${input.path.id}`)
        if (leaf !== "index") leafStarts.push(Date.now())
        await Bun.sleep(100)
        await writeFile(join(directory, `${leaf}.txt`), `${leaf} implemented\n`)
        return jsonResponse({ kind: "implemented", summary: `${leaf} done` })
      },
    },
  }

  const authorized = new Map<string, NodeContext>()
  const registry = new RunRegistry()
  const handle = await registry.start({
    directory: repository,
    sessionId: "parent-session",
    goal: "implement a and b",
    intent: directIntent(repository, base),
    client: fakeClient,
    authorizeSession: (id, node) => authorized.set(id, node),
    policy: { allowJustifiedImbalance: false },
  })
  const result = await handle.promise

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(leafStarts).toHaveLength(2)
  // The direct Surgeon remains active while the sibling Nurse establishes its
  // own boundary and launches the nested Surgeon.
  expect(Math.max(...leafStarts) - Math.min(...leafStarts)).toBeLessThan(80)
  expect(await readFile(join(repository, "README.md"), "utf8")).toBe("fixture\n")
  expect(await Bun.file(join(repository, "a.txt")).exists()).toBe(false)
  expect(await git(repository, ["show", `${result.headCommit}:a.txt`])).toBe("a implemented")
  expect(await git(repository, ["show", `${result.headCommit}:b.txt`])).toBe("b implemented")
  expect(await git(repository, ["show", `${result.headCommit}:index.txt`])).toBe("index implemented")
  expect(await git(repository, ["ls-tree", "-r", "--name-only", result.headCommit])).not.toContain(".quack/contracts/")
  expect(await git(repository, ["rev-list", "--count", `${base}..${result.headCommit}`])).toBe("1")
  expect(handle.graph.snapshot.status).toBe("verified")
  expect(handle.graph.render()).toContain("surgeon · implement a · verified")
  expect(handle.graph.render()).toContain("nurse · implement b · verified")
  expect(authorized.size).toBe(5)

  const pharmacist = [...sessionAgents].find(([, agent]) => agent === "pharmacist")?.[0]
  const nurse = [...sessionAgents].find(([, agent]) => agent === "nurse")?.[0]
  const surgeons = [...sessionAgents].filter(([, agent]) => agent === "surgeon").map(([id]) => id)
  expect(pharmacist).toBeDefined()
  expect(nurse).toBeDefined()
  expect(sessionParents.get(pharmacist!)).toBe("parent-session")
  expect(sessionParents.get(nurse!)).toBe(pharmacist)
  expect(surgeons.some((id) => sessionParents.get(id) === pharmacist)).toBe(true)
  expect(surgeons.some((id) => sessionParents.get(id) === nurse)).toBe(true)

  const worktrees = handle.git.recordsSnapshot()
  const restarted = new RunRegistry()
  const recovered = await restarted.snapshot(repository, handle.id, "parent-session")
  expect(recovered.status).toBe("verified")
  expect(recovered.resultCommit).toBe(result.headCommit)
  expect(recovered.worktrees).toHaveLength(4)

  const applied = await restarted.apply(repository, handle.id, "parent-session")
  expect(applied.status).toBe("applied")
  expect(applied.cleanup?.failures).toEqual([])
  expect(await readFile(join(repository, "a.txt"), "utf8")).toBe("a implemented\n")
  expect(await readFile(join(repository, "b.txt"), "utf8")).toBe("b implemented\n")
  expect(await readFile(join(repository, "index.txt"), "utf8")).toBe("index implemented\n")
  expect(await git(repository, ["ls-files", ".quack/contracts"])).toBe("")
  for (const worktree of worktrees) {
    expect(access(worktree.path)).rejects.toThrow()
  }
  expect(await git(repository, ["branch", "--list", `quackery/${handle.id}/*`])).toBe("")
})

test("a direct root LEAF returns one product-only commit", async () => {
  const repository = await mkdtemp(join(tmpdir(), "quackery-root-leaf-"))
  await execFileAsync("git", ["init", "-q"], { cwd: repository })
  await writeFile(join(repository, "README.md"), "fixture\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: repository })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: repository })
  const base = await git(repository, ["rev-parse", "HEAD"])
  let nextSession = 0
  const sessions = new Map<string, string>()
  const authorized = new Map<string, NodeContext>()
  const fakeClient = {
    session: {
      async create(input: any) {
        const id = `leaf-session-${nextSession++}`
        sessions.set(id, input.query.directory)
        return { data: { id } }
      },
      async prompt(input: any) {
        const directory = sessions.get(input.path.id)
        const node = authorized.get(input.path.id)
        if (!directory || !node) throw new Error("unknown fake root-leaf session")
        if (input.body.agent === "pharmacist") {
          await mkdir(join(directory, node.boundaryRoot), { recursive: true })
          await writeFile(join(directory, node.boundaryRoot, "world.wit"), `
            package quackery:fixture@0.1.0;
            interface feature { value: func() -> string; }
            world feature-world { export feature; }
          `)
          await writeFile(join(directory, node.boundaryRoot, "behavior.md"), "# feature\n")
          return jsonResponse({
            kind: "leaf",
            leaf: leafPlan(
              "feature",
              [],
              "feature-world",
              "feature.txt",
              `${node.boundaryRoot}/world.wit`,
              `${node.boundaryRoot}/behavior.md`,
              `${node.boundaryRoot}/behavior.md`,
            ),
          })
        }
        await writeFile(join(directory, "feature.txt"), "implemented\n")
        return jsonResponse({ kind: "implemented", summary: "done" })
      },
    },
  }
  const registry = new RunRegistry()
  const handle = await registry.start({
    directory: repository,
    sessionId: "root-leaf-parent",
    goal: "implement feature",
    intent: { ...directIntent(repository, base), sessionId: "root-leaf-parent", goal: "implement feature" },
    client: fakeClient,
    authorizeSession: (id, node) => authorized.set(id, node),
  })
  const result = await handle.promise
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(await git(repository, ["rev-list", "--count", `${base}..${result.headCommit}`])).toBe("1")
  expect(await git(repository, ["show", `${result.headCommit}:feature.txt`])).toBe("implemented")
  expect(await git(repository, ["ls-tree", "-r", "--name-only", result.headCommit])).not.toContain(".quack/contracts/")
  expect(await Bun.file(join(repository, "feature.txt")).exists()).toBe(false)
})

function leafPlan(
  id: string,
  imports: string[],
  world: string,
  file: string,
  witPath: string,
  behaviorPath: string,
  stubPath: string,
) {
  return {
    id,
    kind: "leaf",
    scope: `implement ${id}`,
    exports: [id],
    imports,
    world: {
      witPath,
      world,
      behaviorPath,
    },
    reads: [stubPath],
    artifacts: [stubPath],
    owns: [{ path: file, mode: "exact" }],
    verify: [`test -f ${file}`],
    estimatedRemainingDepth: 0,
    estimatedWork: 1,
  }
}

function jsonResponse(value: unknown) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(value) }] } }
}

function directIntent(repository: string, repositoryBase: string): ConfirmedIntent {
  return {
    revision: "intent-test",
    source: "pharmacist-direct",
    repository,
    repositoryBase,
    sessionId: "parent-session",
    confirmedAt: 1,
    goal: "implement a and b",
    observableOutcomes: [],
    inScope: [],
    outOfScope: [],
    constraints: [],
    acceptance: [],
    assumptions: [],
  }
}
