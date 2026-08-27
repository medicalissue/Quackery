import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodePlanSchema, rootSplitDecisionSchema, type NodePlan, type SplitDecision } from "../src/model.js"
import {
  assertBalancedSplit,
  assertBoundaryAssets,
  assertDisjointOwnership,
  assertNodeWorldMatchesWit,
  assertWorldWiring,
  ContractValidationError,
} from "../src/validation.js"

const behaviorContract = `# Responsibility\nFeature responsibility.\n# Inputs\nDefined by WIT.\n# Outputs\nDefined by WIT.\n# Preconditions\nNone.\n# Postconditions\nThe result follows the contract.\n# Invariants\nThe interface remains stable.\n# Errors\nDefined by WIT.\n# Effects\nNone.\n# Constraints\nNo contract changes.\n# Non-goals\nImplementation details.\n`

function plan(input: Partial<NodePlan> & Pick<NodePlan, "id" | "exports">): NodePlan {
  return {
    id: input.id,
    kind: input.kind ?? "leaf",
    scope: input.scope ?? input.id,
    exports: input.exports,
    imports: input.imports ?? [],
    world: input.world ?? {
      witPath: "contracts/worlds.wit",
      world: `${input.id}-surgeon`,
      behaviorPath: "contracts/behavior.md",
      projectionPath: "contracts/projection.ts",
      bindingPath: "contracts/binding.json",
      stubs: (input.imports ?? []).map((item) => ({ interface: item, path: `contracts/${item}.stub.ts` })),
    },
    reads: input.reads ?? [],
    owns: input.owns ?? [{ path: `src/${input.id}`, mode: "prefix" }],
    verify: input.verify ?? ["true"],
    estimatedRemainingDepth: input.estimatedRemainingDepth ?? 0,
    estimatedWork: input.estimatedWork ?? 1,
  }
}

function split(children: NodePlan[], imbalanceJustification?: string): SplitDecision {
  return {
    kind: "split",
    children,
    join: { verify: [] },
    ...(imbalanceJustification ? { imbalanceJustification } : {}),
  }
}

describe("split validation", () => {
  test("rejects node IDs that could escape or alias worktree paths", () => {
    expect(nodePlanSchema.safeParse(plan({ id: "../alias", exports: ["alias"] })).success).toBe(false)
    expect(nodePlanSchema.safeParse(plan({ id: "nested/alias", exports: ["alias"] })).success).toBe(false)
  })

  test("accepts balanced sibling depth and work", () => {
    const children = [
      plan({ id: "a", exports: ["a"], estimatedRemainingDepth: 1, estimatedWork: 2 }),
      plan({ id: "b", exports: ["b"], estimatedRemainingDepth: 2, estimatedWork: 3 }),
    ]
    expect(assertBalancedSplit(split(children), {
      maxDepthSkew: 1,
      maxWorkRatio: 2,
      allowJustifiedImbalance: false,
    })).toEqual({ depthSkew: 1, workRatio: 1.5 })
  })

  test("rejects a branch-heavy tree", () => {
    const children = [
      plan({ id: "a", exports: ["a"], estimatedRemainingDepth: 0, estimatedWork: 1 }),
      plan({ id: "b", exports: ["b"], estimatedRemainingDepth: 4, estimatedWork: 10 }),
    ]
    expect(() => assertBalancedSplit(split(children), {
      maxDepthSkew: 1,
      maxWorkRatio: 2,
      allowJustifiedImbalance: false,
    })).toThrow(ContractValidationError)
  })

  test("rejects overlapping child ownership", () => {
    const children = [
      plan({ id: "a", exports: ["a"], owns: [{ path: "src/shared", mode: "prefix" }] }),
      plan({ id: "b", exports: ["b"], owns: [{ path: "src/shared/file.ts", mode: "exact" }] }),
    ]
    expect(() => assertDisjointOwnership(children)).toThrow("Ownership overlaps")
  })

  test("resolves imports from sibling exports and inherited imports", () => {
    const parent = plan({ id: "parent", kind: "scope", exports: ["feature"], imports: ["clock"] })
    const children = [
      plan({ id: "a", exports: ["store"], imports: ["clock"] }),
      plan({ id: "b", exports: ["service"], imports: ["store"] }),
    ]
    expect(() => assertWorldWiring(parent, children)).not.toThrow()
  })

  test("allows one or more root Nurse scopes but rejects a root Surgeon leaf", () => {
    const nurse = plan({ id: "area", kind: "scope", exports: ["area"] })
    expect(rootSplitDecisionSchema.safeParse({
      kind: "split",
      children: [nurse],
      join: { verify: ["true"] },
    }).success).toBe(true)
    expect(rootSplitDecisionSchema.safeParse({
      kind: "split",
      children: [{ ...nurse, kind: "leaf" }],
      join: { verify: ["true"] },
    }).success).toBe(false)
    expect(rootSplitDecisionSchema.safeParse({
      kind: "split",
      children: [nurse],
      join: { verify: [] },
    }).success).toBe(false)
  })
})

test("matches a node plan to one-export WIT world", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quackery-wit-"))
  await mkdir(join(directory, "contracts"))
  await writeFile(join(directory, "contracts/worlds.wit"), `
    package quackery:test@0.1.0;
    interface store { get: func(key: string) -> string; }
    interface service { run: func() -> string; }
    world service-surgeon {
      import store;
      export service;
    }
  `)
  await writeFile(join(directory, "contracts/behavior.md"), behaviorContract)
  await writeFile(join(directory, "contracts/projection.ts"), "export interface Service { run(): string }\n")
  await writeFile(join(directory, "contracts/store.stub.ts"), "export const store = { get: (_key: string) => \"\" }\n")
  await writeFile(join(directory, "contracts/binding.json"), JSON.stringify({
    version: 1,
    world: "service-surgeon",
    export: { interface: "service", symbol: "Service" },
    imports: [{ interface: "store", symbol: "store" }],
  }))
  await expect(assertNodeWorldMatchesWit(directory, plan({
    id: "service",
    exports: ["service"],
    imports: ["store"],
    world: {
      witPath: "contracts/worlds.wit",
      world: "service-surgeon",
      behaviorPath: "contracts/behavior.md",
      projectionPath: "contracts/projection.ts",
      bindingPath: "contracts/binding.json",
      stubs: [{ interface: "store", path: "contracts/store.stub.ts" }],
    },
  }))).resolves.toBeUndefined()
})

test("rejects syntactically invalid WIT through the canonical parser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quackery-invalid-wit-"))
  await mkdir(join(directory, "contracts"))
  await writeFile(join(directory, "contracts/worlds.wit"), `
    package quackery:test@0.1.0;
    interface service { run: definitely-not-a-wit-type; }
    world service-surgeon { export service; }
  `)
  await expect(assertNodeWorldMatchesWit(directory, plan({
    id: "service",
    exports: ["service"],
    world: {
      witPath: "contracts/worlds.wit",
      world: "service-surgeon",
      behaviorPath: "contracts/behavior.md",
      projectionPath: "contracts/projection.ts",
      bindingPath: "contracts/binding.json",
      stubs: [],
    },
  }))).rejects.toMatchObject({ code: "invalid-wit" })
})

test("rejects incomplete behavior, import stubs, and binding metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quackery-incomplete-world-"))
  await mkdir(join(directory, "contracts"))
  await writeFile(join(directory, "contracts/projection.ts"), "export interface Service { run(): string }\n")
  const service = plan({ id: "service", exports: ["service"], imports: ["store"] })
  await expect(assertBoundaryAssets(directory, { ...service, world: { ...service.world, stubs: [] } }))
    .rejects.toMatchObject({ code: "incomplete-world" })

  await writeFile(join(directory, "contracts/store.stub.ts"), "export const store = {}\n")
  await writeFile(join(directory, "contracts/projection.ts"), "export interface Service { run(: string }\n")
  await expect(assertBoundaryAssets(directory, service)).rejects.toMatchObject({ code: "invalid-projection" })
  await writeFile(join(directory, "contracts/projection.ts"), "export interface Service { run(): string }\n")
  await writeFile(join(directory, "contracts/binding.json"), JSON.stringify({
    version: 1,
    world: "wrong-world",
    export: { interface: "service", symbol: "Service" },
    imports: [{ interface: "store", symbol: "store" }],
  }))
  await expect(assertBoundaryAssets(directory, service)).rejects.toMatchObject({ code: "invalid-binding" })
  await writeFile(join(directory, "contracts/binding.json"), JSON.stringify({
    version: 1,
    world: "service-surgeon",
    export: { interface: "service", symbol: "Service" },
    imports: [{ interface: "store", symbol: "store" }],
  }))
  await writeFile(join(directory, "contracts/projection.ts"), "// Service is intentionally not declared.\nexport {}\n")
  await expect(assertBoundaryAssets(directory, service)).rejects.toMatchObject({ code: "invalid-binding" })
  await writeFile(join(directory, "contracts/projection.ts"), "export interface Service { run(): string }\n")

  await writeFile(join(directory, "contracts/worlds.wit"), `
    package quackery:test@0.1.0;
    interface store { get: func() -> string; }
    interface service { run: func() -> string; }
    world service-surgeon { import store; export service; }
  `)
  await writeFile(join(directory, "contracts/behavior.md"), "# Responsibility\nOnly one section.\n")
  await expect(assertNodeWorldMatchesWit(directory, service)).rejects.toMatchObject({ code: "incomplete-behavior" })
  await writeFile(
    join(directory, "contracts/behavior.md"),
    behaviorContract.replace("# Errors\nDefined by WIT.\n", "# Errors\n"),
  )
  await expect(assertNodeWorldMatchesWit(directory, service)).rejects.toMatchObject({ code: "incomplete-behavior" })
})
