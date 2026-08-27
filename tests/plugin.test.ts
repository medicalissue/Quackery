import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { git } from "../src/git.js"
import { assertWorkerCommand, QuackeryPlugin, workerCommandExitCode } from "../src/index.js"

const execFileAsync = promisify(execFile)
const behaviorContract = `# Responsibility\nPlugin fixture.\n# Inputs\nDefined by WIT.\n# Outputs\nDefined by WIT.\n# Preconditions\nNone.\n# Postconditions\nThe feature is present.\n# Invariants\nThe interface remains stable.\n# Errors\nReported failures.\n# Effects\nWrites the owned feature.\n# Constraints\nOwned paths only.\n# Non-goals\nImplementation details.\n`

test("worker command evidence records OpenCode exit metadata and blocks Git mutation", () => {
  expect(workerCommandExitCode({ exit: 7 })).toBe(7)
  expect(workerCommandExitCode({})).toBe(-1)
  expect(() => assertWorkerCommand("bun test && git diff --check")).not.toThrow()
  expect(() => assertWorkerCommand("git commit -am unsafe")).toThrow("read-only Git commands")
  expect(() => assertWorkerCommand("git -C /tmp reset --hard HEAD")).toThrow("read-only Git commands")
  expect(() => assertWorkerCommand("git config user.name Worker")).toThrow("read-only Git commands")
  expect(() => assertWorkerCommand("git apply patch.diff && git fetch origin")).toThrow("read-only Git commands")
})

test("visible Pharmacist cannot use its edit permission outside an authorized runtime session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quack-plugin-"))
  const hooks: any = await (QuackeryPlugin as any)({ client: {}, directory })
  const config: any = {}
  await hooks.config(config)
  expect(config.agent.psychiatrist.permission.bash).toBe("deny")
  expect(config.agent.pharmacist.permission.edit).toBe("deny")
  expect(config.agent.pharmacist.permission.quackery_apply_approval).toBe("ask")
  expect(config.agent.pharmacist.permission.quackery_abandon_approval).toBe("ask")
  expect(config.agent.nurse.permission.bash).toBe("allow")
  expect(config.agent.nurse.permission["quackery_*"]).toBe("deny")
  expect(config.agent.surgeon.permission.bash).toBe("allow")
  expect(config.agent.surgeon.permission["quackery_*"]).toBe("deny")
  await hooks["chat.message"]({ sessionID: "visible-pharmacist", agent: "pharmacist" }, {})
  expect(hooks["tool.execute.before"](
    { sessionID: "visible-pharmacist", tool: "write", callID: "call-1" },
    { args: { filePath: "src/product.ts" } },
  )).rejects.toThrow("Visible Pharmacist cannot edit files")
  expect(hooks["tool.execute.before"](
    { sessionID: "visible-pharmacist", tool: "multiedit", callID: "call-2" },
    { args: { edits: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }] } },
  )).rejects.toThrow("Visible Pharmacist cannot edit files")

  await hooks["chat.message"]({ sessionID: "visible-pharmacist", agent: "build" }, {})
  await expect(hooks["tool.execute.before"](
    { sessionID: "visible-pharmacist", tool: "write", callID: "call-3" },
    { args: { filePath: "src/product.ts" } },
  )).resolves.toBeUndefined()
})

test("plugin tools start from a Pharmacist Nurse split, recover, apply, and clean", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quack-plugin-lifecycle-"))
  await execFileAsync("git", ["init", "-q"], { cwd: directory })
  await writeFile(join(directory, "README.md"), "base\n")
  await writeFile(join(directory, ".gitignore"), ".quack/config.local.jsonc\n")
  await mkdir(join(directory, ".quack"))
  await writeFile(join(directory, ".quack", "config.local.jsonc"), JSON.stringify({
    models: {
      balanced: { model: "fixture/nurse", variant: "careful" },
      economy: { model: "fixture/surgeon", variant: "fast" },
    },
  }))
  await execFileAsync("git", ["add", "README.md", ".gitignore"], { cwd: directory })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: directory })
  let nextSession = 0
  let childHookChecks = 0
  const sessions = new Map<string, string>()
  const client = {
    session: {
      async create(input: any) {
        const id = `plugin-session-${nextSession++}`
        sessions.set(id, input.query.directory)
        return { data: { id } }
      },
      async prompt(input: any) {
        const worktree = sessions.get(input.path.id)
        if (!worktree) throw new Error("unknown plugin fake session")
        const expectedModel = input.body.agent === "nurse"
          ? { providerID: "fixture", modelID: "nurse" }
          : { providerID: "fixture", modelID: "surgeon" }
        expect(input.body.model).toEqual(expectedModel)
        expect(input.body.variant).toBe(input.body.agent === "nurse" ? "careful" : "fast")
        const childHooks: any = await (QuackeryPlugin as any)({ client, directory: worktree })
        await childHooks.config({})
        await childHooks["chat.message"]({ sessionID: input.path.id, agent: input.body.agent }, {})
        childHookChecks += 1
        if (input.body.agent === "nurse") {
          const prompt = input.body.parts[0].text as string
          const inheritedText = /INHERITED NODE PLAN\n([\s\S]*?)\n\nLOCAL REPAIR CONTEXT/.exec(prompt)?.[1]
          if (!inheritedText) throw new Error("missing inherited Nurse plan")
          const inherited = JSON.parse(inheritedText)
          return response({
            kind: "leaf",
            leaf: {
              ...inherited,
              id: "feature-implementation",
              kind: "leaf",
              estimatedRemainingDepth: 0,
            },
          })
        }
        await writeFile(join(worktree, "feature.txt"), "implemented\n")
        return response({ kind: "implemented", summary: "done" })
      },
    },
  }
  const hooks: any = await (QuackeryPlugin as any)({ client, directory })
  await hooks.config({})
  const context = {
    agent: "pharmacist",
    directory,
    sessionID: "visible-session",
    ask: async () => undefined,
  }
  const doctor = await hooks.tool.quackery_doctor.execute({}, context)
  expect(doctor.metadata.ready).toBe(true)
  expect(doctor.output).toContain("UNKNOWN live provider protocol")
  expect(doctor.output).toContain("UNKNOWN provider cache")
  const started = await hooks.tool.quackery_start.execute({
    directGoal: "implement feature",
    rootDecision: {
      kind: "split",
      children: [{
        id: "feature",
        kind: "scope",
        scope: "implement feature",
        exports: ["feature"],
        imports: [],
        world: {
          witPath: "world.wit",
          world: "feature-world",
          behaviorPath: "behavior.md",
          projectionPath: "projection.ts",
          bindingPath: "binding.json",
          stubs: [],
        },
        reads: [],
        artifacts: [],
        owns: [{ path: "feature.txt", mode: "exact" }],
        verify: ["test -f feature.txt"],
        estimatedRemainingDepth: 1,
        estimatedWork: 1,
      }],
      join: { verify: ["test -f feature.txt"] },
    },
    artifacts: [
      {
        path: "world.wit",
        content: `package quackery:plugin@0.1.0;
          interface feature { value: func() -> string; }
          world feature-world { export feature; }
        `,
      },
      { path: "behavior.md", content: behaviorContract },
      { path: "projection.ts", content: "export interface Feature { value(): string }\n" },
      {
        path: "binding.json",
        content: JSON.stringify({
          version: 1,
          world: "feature-world",
          export: { interface: "feature", symbol: "Feature" },
          imports: [],
        }),
      },
    ],
  }, context)
  const runId = started.metadata.runId as string
  const waited = await hooks.tool.quackery_wait.execute({ runId, timeoutSeconds: 5 }, context)
  expect(waited.metadata.status).toBe("verified")
  expect(childHookChecks).toBe(2)
  await expect(hooks["chat.message"]({ sessionID: "plugin-session-0", agent: "nurse" }, {}))
    .rejects.toThrow("nurse is internal")
  expect(await Bun.file(join(directory, "feature.txt")).exists()).toBe(false)

  const restarted: any = await (QuackeryPlugin as any)({ client, directory })
  await restarted.config({})
  const recovered = await restarted.tool.quackery_status.execute({ runId }, context)
  expect(recovered.metadata.status).toBe("verified")
  let askedFor: string | undefined
  const applied = await restarted.tool.quackery_apply.execute({ runId }, {
    ...context,
    ask: async (input: any) => { askedFor = input.patterns[0] },
  })
  expect(askedFor).toBeDefined()
  expect(applied).toContain("Temporary worktrees and run branches were cleaned")
  expect(await readFile(join(directory, "feature.txt"), "utf8")).toBe("implemented\n")
  expect(await git(directory, ["ls-files", ".quack/contracts"])).toBe("")
})

test("doctor can opt into a tool-free live provider protocol probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quack-plugin-probe-"))
  await execFileAsync("git", ["init", "-q"], { cwd: directory })
  await writeFile(join(directory, "README.md"), "base\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: directory })
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-q", "-m", "base",
  ], { cwd: directory })
  let deleted: string | undefined
  const hooks: any = await (QuackeryPlugin as any)({
    directory,
    client: {
      session: {
        create: async () => ({ data: { id: "probe-session" } }),
        prompt: async () => response({ kind: "quackery-live-probe", ok: true }),
        delete: async (input: any) => { deleted = input.path.id },
      },
    },
  })
  await hooks.config({})
  const result = await hooks.tool.quackery_doctor.execute({ live: true }, {
    agent: "build",
    directory,
    sessionID: "build-session",
  })
  expect(result.metadata.ready).toBe(true)
  expect(result.output).toContain("PASS    live provider protocol")
  expect(result.output).toContain("READY (live provider protocol passed; cache not measured)")
  expect(deleted).toBe("probe-session")
})

function response(value: unknown) {
  return { data: { parts: [{ type: "text", text: JSON.stringify(value) }] } }
}
