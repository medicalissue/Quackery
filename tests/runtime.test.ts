import { expect, test } from "bun:test"
import type {
  DecompositionDecision,
  NodeContext,
  NodePlan,
  NodeResult,
  NodeSuccess,
  SplitDecision,
} from "../src/model.js"
import { RunGraph } from "../src/graph.js"
import { RecursiveRuntime, type ExecutionAdapter } from "../src/runtime.js"

function plan(
  id: string,
  kind: "leaf" | "scope",
  exported: string,
  imports: string[],
  depth: number,
  ownedPath = `src/${id}`,
): NodePlan {
  return {
    id,
    kind,
    scope: id,
    exports: [exported],
    imports,
    world: { witPath: "worlds.wit", world: `${exported}-surgeon`, behaviorPath: "behavior.md" },
    reads: [],
    owns: [{ path: ownedPath, mode: "prefix" }],
    verify: ["true"],
    estimatedRemainingDepth: depth,
    estimatedWork: 1,
  }
}

test("an atomic Nurse handoff overlaps a sibling Nurse's recursive decomposition", async () => {
  const events: string[] = []
  const root = rootContext()
  const rootDecision: SplitDecision = {
    kind: "split",
    children: [
      plan("a", "scope", "a", [], 1),
      plan("b", "scope", "b", ["a"], 1),
    ],
    join: { verify: [] },
  }
  const decisions = new Map<string, DecompositionDecision>([
    ["root/a", { kind: "leaf", leaf: plan("a-implementation", "leaf", "a", [], 0, "src/a") }],
    ["root/b", {
      kind: "split",
      children: [
        plan("b1", "leaf", "b1", ["a"], 0, "src/b/b1"),
        plan("b2", "leaf", "b2", ["a"], 0, "src/b/b2"),
      ],
      join: {
        integration: plan("b-integration", "leaf", "b", ["b1", "b2"], 0, "src/b/index.ts"),
        verify: [],
      },
    }],
  ])
  const adapter = fakeAdapter(events, async (node) => {
    events.push(`decompose:start:${node.id}`)
    if (node.id === "root/b") await Bun.sleep(70)
    events.push(`decompose:end:${node.id}`)
    const decision = decisions.get(node.id)
    if (!decision) throw new Error(`missing decision ${node.id}`)
    return decision
  })

  const graph = new RunGraph({ id: "run", repository: "/fake", root, invocationBase: "base" })
  const result = await new RecursiveRuntime(graph, adapter, runtimePolicy()).executeRoot(root, rootDecision, "root-boundary")
  expect(result.ok).toBe(true)
  expect(events.indexOf("leaf:start:root/a/a-implementation")).toBeLessThan(events.indexOf("decompose:end:root/b"))
  expect(events).toContain("leaf:start:root/b/b1")
  expect(events).toContain("leaf:start:root/b/b2")
  expect(graph.snapshot.status).toBe("verified")
  expect(graph.render()).toContain("nurse · a")
  expect(graph.render()).toContain("surgeon · a-implementation")
})

test("starts a Nurse subtree before the next root child worktree finishes creation", async () => {
  const events: string[] = []
  const root = rootContext()
  const rootDecision: SplitDecision = {
    kind: "split",
    children: [plan("a", "scope", "a", [], 1), plan("b", "scope", "b", [], 1)],
    join: { verify: [] },
  }
  const adapter = fakeAdapter(events, async (node) => ({
    kind: "leaf",
    leaf: { ...node.plan!, id: `${node.plan!.id}-implementation`, kind: "leaf", estimatedRemainingDepth: 0 },
  }))
  const originalFork = adapter.forkChild
  adapter.forkChild = async (parent, boundaryCommit, childPlan) => {
    events.push(`fork:start:${parent.id}:${childPlan.id}`)
    if (parent.id === "root" && childPlan.id === "b") await Bun.sleep(60)
    events.push(`fork:end:${parent.id}:${childPlan.id}`)
    return originalFork(parent, boundaryCommit, childPlan)
  }

  const graph = new RunGraph({ id: "immediate", repository: "/fake", root, invocationBase: "base" })
  const result = await new RecursiveRuntime(graph, adapter, runtimePolicy()).executeRoot(root, rootDecision, "boundary")
  expect(result.ok).toBe(true)
  expect(events.indexOf("leaf:start:root/a/a-implementation")).toBeLessThan(events.indexOf("fork:end:root:b"))
})

test("returns only a non-atomic Surgeon delta to a Nurse without rerunning siblings", async () => {
  const root = rootContext()
  const attempts = new Map<string, number>()
  const events: string[] = []
  const rootDecision: SplitDecision = {
    kind: "split",
    children: [
      plan("a", "scope", "a", [], 1, "src/a"),
      plan("b", "scope", "b", [], 1, "src/b"),
    ],
    join: { verify: [] },
  }
  const nestedDecision: SplitDecision = {
    kind: "split",
    children: [
      plan("a1", "leaf", "a1", [], 0, "src/a/one"),
      plan("a2", "leaf", "a2", [], 0, "src/a/two"),
    ],
    join: {
      integration: plan("a-join", "leaf", "a", ["a1", "a2"], 0, "src/a/index.ts"),
      verify: [],
    },
  }
  const adapter = fakeAdapter(events, async (node) => {
    events.push(`decompose:${node.id}`)
    if (node.id === "root/a/a-implementation") return nestedDecision
    return {
      kind: "leaf",
      leaf: { ...node.plan!, id: `${node.plan!.id}-implementation`, kind: "leaf", estimatedRemainingDepth: 0 },
    }
  }, async (node) => {
    const count = (attempts.get(node.id) ?? 0) + 1
    attempts.set(node.id, count)
    events.push(`leaf:${node.id}:${count}`)
    if (node.id === "root/a/a-implementation" && count === 1) {
      return { ok: false, nodeId: node.id, reason: "NEEDS_NURSE", detail: "two holes", actualDepth: 0 }
    }
    return success(node, `${node.id}-result`)
  })

  const graph = new RunGraph({ id: "bounce", repository: "/fake", root, invocationBase: "base" })
  const result = await new RecursiveRuntime(graph, adapter, runtimePolicy()).executeRoot(root, rootDecision, "boundary")
  expect(result.ok).toBe(true)
  expect(events).toContain("preserve:root/a/a-implementation")
  expect(events).toContain("decompose:root/a/a-implementation")
  expect(attempts.get("root/b/b-implementation")).toBe(1)
  expect(attempts.get("root/a/a-implementation/a1")).toBe(1)
  expect(attempts.get("root/a/a-implementation/a2")).toBe(1)
  expect(graph.snapshot.nodes.find((node) => node.id === "root/a/a-implementation")?.role).toBe("nurse")
})

test("routes root integration through Nurse before any Surgeon", async () => {
  const root = rootContext()
  const attempts = new Map<string, number>()
  const events: string[] = []
  const rootDecision: SplitDecision = {
    kind: "split",
    children: [
      plan("a", "scope", "a", [], 1, "src/a"),
      plan("b", "scope", "b", [], 1, "src/b"),
    ],
    join: {
      integration: plan("root-integration", "scope", "feature", ["a", "b"], 1, "src/integration"),
      verify: [],
    },
  }
  const repairDecision: SplitDecision = {
    kind: "split",
    children: [
      plan("wire-a", "leaf", "wire-a", ["a", "b"], 0, "src/integration/a"),
      plan("wire-b", "leaf", "wire-b", ["a", "b"], 0, "src/integration/b"),
    ],
    join: {
      integration: plan("wire-join", "leaf", "feature", ["wire-a", "wire-b"], 0, "src/integration/index.ts"),
      verify: [],
    },
  }
  const adapter = fakeAdapter(events, async (node) => {
    events.push(`decompose:${node.id}`)
    if (node.id === "root/integration/integration-implementation") return repairDecision
    return {
      kind: "leaf",
      leaf: { ...node.plan!, id: `${node.plan!.id}-implementation`, kind: "leaf", estimatedRemainingDepth: 0 },
    }
  }, async (node) => {
    const count = (attempts.get(node.id) ?? 0) + 1
    attempts.set(node.id, count)
    if (node.id === "root/integration/integration-implementation" && count === 1) {
      return { ok: false, nodeId: node.id, reason: "NEEDS_NURSE", actualDepth: 0 }
    }
    return success(node, `${node.id}-result`)
  })

  const graph = new RunGraph({ id: "integration-bounce", repository: "/fake", root, invocationBase: "base" })
  const result = await new RecursiveRuntime(graph, adapter, runtimePolicy()).executeRoot(root, rootDecision, "boundary")
  expect(result.ok).toBe(true)
  expect(events).toContain("decompose:root/integration")
  expect(events).toContain("preserve:root/integration/integration-implementation")
  expect(attempts.get("root/a/a-implementation")).toBe(1)
  expect(attempts.get("root/b/b-implementation")).toBe(1)
  expect(attempts.get("root/integration/integration-implementation/wire-a")).toBe(1)
})

function fakeAdapter(
  events: string[],
  decompose: (node: NodeContext) => Promise<DecompositionDecision>,
  runLeaf: (node: NodeContext) => Promise<NodeResult> = async (node) => {
    events.push(`leaf:start:${node.id}`)
    await Bun.sleep(10)
    events.push(`leaf:end:${node.id}`)
    return success(node, `${node.id}-result`)
  },
): ExecutionAdapter {
  return {
    decompose,
    async commitBoundary(node) { return `${node.id}-boundary` },
    async forkChild(parent, boundaryCommit, childPlan) { return childContext(parent, boundaryCommit, childPlan) },
    async prepareNeedsNurse(node) {
      events.push(`preserve:${node.id}`)
      return `stash-${node.id}`
    },
    runLeaf,
    async prepareJoin(node) {
      events.push(`compose:${node.id}`)
      return `${node.id}-composed`
    },
    async join(node, _boundary, children) {
      events.push(`join:${node.id}`)
      return success(node, `${node.id}-joined`, 1 + Math.max(0, ...children.map((child) => child.actualDepth)))
    },
  }
}

function rootContext(): NodeContext {
  return {
    id: "root",
    depth: 0,
    role: "pharmacist",
    scope: "feature",
    worktree: "/fake/current-checkout",
    baseCommit: "base",
    boundaryRoot: ".quack/contracts/run/root",
  }
}

function childContext(parent: NodeContext, boundaryCommit: string, childPlan: NodePlan): NodeContext {
  return {
    id: `${parent.id}/${childPlan.id}`,
    parentId: parent.id,
    depth: parent.depth + 1,
    role: childPlan.kind === "leaf" ? "surgeon" : "nurse",
    scope: childPlan.scope,
    plan: childPlan,
    worktree: `/fake/${childPlan.id}`,
    baseCommit: boundaryCommit,
    boundaryRoot: `.quack/contracts/run/${childPlan.id}`,
  }
}

function runtimePolicy() {
  return {
    maxDepth: 8,
    maxNodes: 32,
    maxNeedsNurseBounces: 1,
    maxDepthSkew: 1,
    maxWorkRatio: 2,
    allowJustifiedImbalance: false,
  }
}

function success(node: NodeContext, headCommit: string, actualDepth = 0): NodeSuccess {
  return {
    ok: true,
    nodeId: node.id,
    baseCommit: node.baseCommit,
    headCommit,
    changedPaths: [],
    evidence: [],
    actualDepth,
  }
}
