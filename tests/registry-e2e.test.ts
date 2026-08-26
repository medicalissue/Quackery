import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import type { NodeContext } from "../src/model.js"
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
          await mkdir(join(directory, "contracts"), { recursive: true })
          await writeFile(join(directory, "contracts/worlds.wit"), `
            package quackery:fixture@0.1.0;
            interface a { value: func() -> string; }
            interface b { value: func() -> string; }
            world a-surgeon { export a; }
            world b-surgeon { import a; export b; }
          `)
          await writeFile(join(directory, "contracts/behavior.md"), "# a\nWrite a.txt.\n\n# b\nWrite b.txt.\n")
          await writeFile(join(directory, "contracts/a.stub.ts"), "export interface A { value(): string }\n")
          return jsonResponse({
            kind: "split",
            children: [
              leafPlan("a", [], "a-surgeon", "a.txt"),
              { ...leafPlan("b", ["a"], "b-surgeon", "b.txt"), kind: "scope", estimatedRemainingDepth: 1 },
            ],
            join: { verify: ["test -f a.txt && test -f b.txt"] },
          })
        }

        if (input.body.agent === "nurse") {
          return jsonResponse({ kind: "leaf", leaf: leafPlan("b", ["a"], "b-surgeon", "b.txt") })
        }

        leafStarts.push(Date.now())
        const leaf = basename(directory).endsWith("a") ? "a" : "b"
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
  expect(await git(repository, ["rev-list", "--count", `${base}..${result.headCommit}`])).toBe("1")
  expect(handle.graph.snapshot.status).toBe("verified")
  expect(handle.graph.render()).toContain("surgeon · implement a · verified")
  expect(handle.graph.render()).toContain("nurse · implement b · verified")
  expect(authorized.size).toBe(4)

  const pharmacist = [...sessionAgents].find(([, agent]) => agent === "pharmacist")?.[0]
  const nurse = [...sessionAgents].find(([, agent]) => agent === "nurse")?.[0]
  const surgeons = [...sessionAgents].filter(([, agent]) => agent === "surgeon").map(([id]) => id)
  expect(pharmacist).toBeDefined()
  expect(nurse).toBeDefined()
  expect(sessionParents.get(pharmacist!)).toBe("parent-session")
  expect(sessionParents.get(nurse!)).toBe(pharmacist)
  expect(surgeons.some((id) => sessionParents.get(id) === pharmacist)).toBe(true)
  expect(surgeons.some((id) => sessionParents.get(id) === nurse)).toBe(true)
})

function leafPlan(id: string, imports: string[], world: string, file: string) {
  return {
    id,
    kind: "leaf",
    scope: `implement ${id}`,
    exports: [id],
    imports,
    world: {
      witPath: "contracts/worlds.wit",
      world,
      behaviorPath: "contracts/behavior.md",
    },
    reads: ["contracts/a.stub.ts"],
    owns: [{ path: file, mode: "exact" }],
    verify: [`test -f ${file}`],
    estimatedRemainingDepth: 0,
    estimatedWork: 1,
  }
}

function jsonResponse(value: unknown) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(value) }] } }
}
