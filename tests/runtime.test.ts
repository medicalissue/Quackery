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
      }
    },
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
