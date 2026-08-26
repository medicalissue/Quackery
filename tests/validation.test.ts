import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodePlan, SplitDecision } from "../src/model.js"
import {
  assertBalancedSplit,
  assertDisjointOwnership,
  assertNodeWorldMatchesWit,
  assertWorldWiring,
  ContractValidationError,
} from "../src/validation.js"

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
  await writeFile(join(directory, "contracts/behavior.md"), "# service\n\nReturn the stored value.\n")
  await expect(assertNodeWorldMatchesWit(directory, plan({
    id: "service",
    exports: ["service"],
    imports: ["store"],
    world: {
      witPath: "contracts/worlds.wit",
      world: "service-surgeon",
      behaviorPath: "contracts/behavior.md",
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
    },
  }))).rejects.toMatchObject({ code: "invalid-wit" })
})
