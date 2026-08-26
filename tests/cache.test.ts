import { expect, test } from "bun:test"
import { boundaryCacheSeed, cacheContext, cachePartitionKey, usageFromResponse } from "../src/cache.js"
import type { DecompositionDecision, NodeContext, NodePlan } from "../src/model.js"
import { RunGraph } from "../src/graph.js"

function plan(id: string, kind: "scope" | "leaf", exported: string): NodePlan {
  return {
    id,
    kind,
    scope: `${id} scope`,
    exports: [exported],
    imports: ["shared-dependency"],
    world: { witPath: "contracts/worlds.wit", world: `${id}-world`, behaviorPath: `contracts/${id}.md` },
    reads: [],
    owns: [{ path: `src/${id}`, mode: "prefix" }],
    verify: ["bun test"],
    estimatedRemainingDepth: kind === "leaf" ? 0 : 1,
    estimatedWork: 1,
  }
}

function root(): NodeContext {
  return {
    id: "root",
    depth: 0,
    role: "pharmacist",
    scope: "feature",
    worktree: "/tmp/a-worktree-that-must-not-enter-the-key",
    baseCommit: "base",
    boundaryRoot: ".quack/contracts/test/root",
  }
}

test("same-role siblings share one stable parent-boundary cache group", () => {
  const decision: DecompositionDecision = {
    kind: "split",
    children: [plan("beta", "leaf", "beta-api"), plan("alpha", "leaf", "alpha-api")],
    join: { verify: ["bun test"] },
  }
  const seed = boundaryCacheSeed(root(), "boundary-1", decision)
  const first = cacheContext(seed, "surgeon")
  const reordered = cacheContext(
    boundaryCacheSeed(root(), "boundary-1", { ...decision, children: [...decision.children].reverse() }),
    "surgeon",
  )

  expect(first.group).toBe(reordered.group)
  expect(first.prefix).not.toContain("/tmp/a-worktree")
  expect(first.prefix).not.toContain("beta scope")
})

test("cache partitions change across role or frozen boundary", () => {
  const decision: DecompositionDecision = {
    kind: "split",
    children: [plan("alpha", "scope", "alpha-api"), plan("beta", "scope", "beta-api")],
    join: { verify: [] },
  }
  const seed = boundaryCacheSeed(root(), "boundary-1", decision)
  expect(cacheContext(seed, "nurse").group).not.toBe(cacheContext(seed, "surgeon").group)
  expect(cacheContext(seed, "nurse").group).not.toBe(
    cacheContext(boundaryCacheSeed(root(), "boundary-2", decision), "nurse").group,
  )
  const context = cacheContext(seed, "nurse")
  expect(cachePartitionKey(context, "openai", "frontier", "high")).not.toBe(
    cachePartitionKey(context, "openai", "balanced", "medium"),
  )
})

test("normalizes OpenCode token and prompt-cache telemetry", () => {
  expect(usageFromResponse({
    data: {
      info: {
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 12 } },
        cost: 0.0042,
      },
    },
  })).toEqual({ input: 100, output: 20, reasoning: 5, cacheRead: 80, cacheWrite: 12, cost: 0.0042 })
})

test("text graph distinguishes cache eligibility from provider-returned usage", () => {
  const parent = root()
  const graph = new RunGraph({ id: "cache-run", repository: "/tmp/repo", root: parent, invocationBase: "base" })
  const child: NodeContext = {
    ...root(),
    id: "root/alpha",
    parentId: "root",
    depth: 1,
    role: "surgeon",
    cache: cacheContext({
      boundaryCommit: "boundary-1",
      parentNodeId: "root",
      parentScope: "feature",
      interfaces: [],
    }, "surgeon"),
  }
  graph.add(child)
  expect(graph.render()).toContain("cache eligible")
  graph.transition(child.id, "verified", {
    usage: { input: 100, output: 20, reasoning: 0, cacheRead: 80, cacheWrite: 0, cost: 0.01 },
  })
  expect(graph.render()).toContain("cache 80r/0w")
  expect(graph.render()).toContain("cache 80 read/0 write")
})
