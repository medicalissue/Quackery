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
    world: { witPath: "worlds.wit", world: `${id}-surgeon`, behaviorPath: "behavior.md" },
    reads: [],
    owns: [{ path: ownedPath, mode: "prefix" }],
    verify: ["true"],
    estimatedRemainingDepth: depth,
    estimatedWork: 1,
  }
}

test("leaf implementation overlaps a sibling Nurse's recursive decomposition", async () => {
  const events: string[] = []
  const root: NodeContext = {
    id: "root",
    depth: 0,
    role: "pharmacist",
    scope: "feature",
    worktree: "/fake/root",
    baseCommit: "base",
    boundaryRoot: ".quack/contracts/run/root",
  }
  const decisions = new Map<string, DecompositionDecision>([
    ["root", {
      kind: "split",
      children: [
        plan("a", "leaf", "a", [], 0),
        plan("b", "scope", "b", ["a"], 1),
      ],
      join: { verify: [] },
    }],
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

  const adapter: ExecutionAdapter = {
    async decompose(node) {
      events.push(`decompose:start:${node.id}`)
      if (node.id === "root/b") await Bun.sleep(70)
      events.push(`decompose:end:${node.id}`)
      const decision = decisions.get(node.id)
      if (!decision) throw new Error(`missing decision ${node.id}`)
      return decision
    },
    async commitBoundary(node) {
      return `${node.id}-boundary`
    },
    async forkChild(parent, boundaryCommit, childPlan) {
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
    },
    async prepareNeedsNurse() {},
    async runLeaf(node): Promise<NodeResult> {
      events.push(`leaf:start:${node.id}`)
      await Bun.sleep(10)
      events.push(`leaf:end:${node.id}`)
      return success(node, `${node.id}-result`)
    },
    async join(node, _boundary, children, _decision: SplitDecision) {
      events.push(`join:${node.id}`)
      return success(node, `${node.id}-joined`, 1 + Math.max(...children.map((child) => child.actualDepth)))
    },
  }

  const graph = new RunGraph({ id: "run", repository: "/fake", root, invocationBase: "base" })
  const runtime = new RecursiveRuntime(graph, adapter, {
    maxDepth: 5,
    maxNodes: 10,
    maxNeedsNurseBounces: 1,
    maxDepthSkew: 1,
    maxWorkRatio: 2,
    allowJustifiedImbalance: false,
  })
  const result = await runtime.execute(root)
  expect(result.ok).toBe(true)
  expect(events.indexOf("leaf:start:root/a")).toBeLessThan(events.indexOf("decompose:end:root/b"))
  expect(events).toContain("leaf:start:root/b/b1")
  expect(events).toContain("leaf:start:root/b/b2")
  expect(graph.snapshot.status).toBe("verified")
  expect(graph.render()).toContain("nurse · b")
})

test("starts each child before the next worktree has finished being created", async () => {
  const events: string[] = []
  const root = rootContext()
  const decision: SplitDecision = {
    kind: "split",
    children: [plan("a", "leaf", "a", [], 0), plan("b", "leaf", "b", [], 0)],
    join: { verify: [] },
  }
  const adapter: ExecutionAdapter = {
    async decompose() { return decision },
    async commitBoundary() { return "boundary" },
    async forkChild(parent, boundaryCommit, childPlan) {
      events.push(`fork:start:${childPlan.id}`)
      if (childPlan.id === "b") await Bun.sleep(60)
      events.push(`fork:end:${childPlan.id}`)
      return childContext(parent, boundaryCommit, childPlan)
    },
    async runLeaf(node) {
      events.push(`leaf:${node.id}`)
      return success(node, `${node.id}-result`)
    },
    async prepareNeedsNurse() {},
    async join(node) { return success(node, "joined", 1) },
  }
  const graph = new RunGraph({ id: "immediate", repository: "/fake", root, invocationBase: "base" })
  const result = await new RecursiveRuntime(graph, adapter, runtimePolicy()).execute(root)
  expect(result.ok).toBe(true)
  expect(events.indexOf("leaf:root/a")).toBeLessThan(events.indexOf("fork:end:b"))
})

test("turns only a NEEDS_NURSE leaf back into recursive decomposition", async () => {
  const root = rootContext()
  const attempts = new Map<string, number>()
  const events: string[] = []
  const rootDecision: SplitDecision = {
    kind: "split",
    children: [
      plan("a", "leaf", "a", [], 0, "src/a"),
      plan("b", "leaf", "b", [], 0, "src/b"),
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
  const adapter: ExecutionAdapter = {
    async decompose(node) {
      events.push(`decompose:${node.id}`)
      return node.id === "root" ? rootDecision : nestedDecision
    },
    async commitBoundary(node) { return `${node.id}-boundary` },
    async forkChild(parent, boundaryCommit, childPlan) {
      return childContext(parent, boundaryCommit, childPlan)
    },
    async runLeaf(node) {
      const count = (attempts.get(node.id) ?? 0) + 1
      attempts.set(node.id, count)
      events.push(`leaf:${node.id}:${count}`)
      if (node.id === "root/a" && count === 1) {
        return {
          ok: false,
          nodeId: node.id,
          reason: "NEEDS_NURSE",
          detail: "two implementation holes",
          actualDepth: 0,
        }
      }
      return success(node, `${node.id}-result`)
    },
    async prepareNeedsNurse(node) {
      events.push(`preserve:${node.id}`)
      return `stash-${node.id}`
    },
    async join(node, _boundary, children) {
      return success(node, `${node.id}-joined`, 1 + Math.max(...children.map((child) => child.actualDepth)))
    },
  }
  const graph = new RunGraph({ id: "bounce", repository: "/fake", root, invocationBase: "base" })
  const result = await new RecursiveRuntime(graph, adapter, runtimePolicy()).execute(root)
  expect(result.ok).toBe(true)
  expect(events).toContain("preserve:root/a")
  expect(events).toContain("decompose:root/a")
  expect(attempts.get("root/b")).toBe(1)
  expect(attempts.get("root/a/a1")).toBe(1)
  expect(attempts.get("root/a/a2")).toBe(1)
  expect(graph.render()).toContain("nurse · a · verified")
  expect(graph.snapshot.nodes.find((node) => node.id === "root/a")?.recoverableCommit).toBe("stash-root/a")
})

test("turns an integration LEAF back into a local Nurse subtree", async () => {
  const root = rootContext()
  const attempts = new Map<string, number>()
  const events: string[] = []
  const rootDecision: SplitDecision = {
    kind: "split",
    children: [
      plan("a", "leaf", "a", [], 0, "src/a"),
      plan("b", "leaf", "b", [], 0, "src/b"),
    ],
    join: {
      integration: plan("root-join", "leaf", "feature", ["a", "b"], 0, "src/integration"),
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
  const adapter: ExecutionAdapter = {
    async decompose(node) {
      events.push(`decompose:${node.id}`)
      return node.id === "root" ? rootDecision : repairDecision
    },
    async commitBoundary(node) { return `${node.id}-boundary` },
    async forkChild(parent, boundaryCommit, childPlan) {
      return childContext(parent, boundaryCommit, childPlan)
    },
    async prepareJoin(node) {
      events.push(`compose:${node.id}`)
      return `${node.id}-composed`
    },
    async runLeaf(node) {
      const count = (attempts.get(node.id) ?? 0) + 1
      attempts.set(node.id, count)
      events.push(`leaf:${node.id}:${count}`)
      if (node.id === "root/integration" && count === 1) {
        return { ok: false, nodeId: node.id, reason: "NEEDS_NURSE", actualDepth: 0 }
      }
      return success(node, `${node.id}-result`)
    },
    async prepareNeedsNurse(node) { events.push(`preserve:${node.id}`) },
    async join(node) { return success(node, `${node.id}-joined`) },
  }
  const graph = new RunGraph({ id: "integration-bounce", repository: "/fake", root, invocationBase: "base" })
  const result = await new RecursiveRuntime(graph, adapter, runtimePolicy()).execute(root)
  expect(result.ok).toBe(true)
  expect(events).toContain("preserve:root/integration")
  expect(events).toContain("decompose:root/integration")
  expect(attempts.get("root/a")).toBe(1)
  expect(attempts.get("root/b")).toBe(1)
  expect(attempts.get("root/integration/wire-a")).toBe(1)
  expect(attempts.get("root/integration/wire-b")).toBe(1)
  expect(graph.render()).toContain("nurse · root-join · verified")
})

function rootContext(): NodeContext {
  return {
    id: "root",
    depth: 0,
    role: "pharmacist",
    scope: "feature",
    worktree: "/fake/root",
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
    maxDepth: 5,
    maxNodes: 10,
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
