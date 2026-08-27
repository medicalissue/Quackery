import { expect, test } from "bun:test"
import type { RunSnapshot } from "../src/model.js"
import { evaluateSelfHostQualification, renderSelfHostQualification } from "../src/qualification.js"

test("requires source, regression, provider, verification, and package evidence for B1", () => {
  const snapshot: RunSnapshot = {
    id: "q-qualification",
    sessionId: "session",
    repository: "/repo",
    rootNodeId: "root",
    invocationBase: "base",
    resultCommit: "result",
    status: "verified",
    createdAt: 1,
    updatedAt: 2,
    nodes: [
      {
        id: "root",
        role: "pharmacist",
        scope: "qualify",
        status: "verified",
        depth: 0,
        baseCommit: "base",
        evidence: [
          { command: "bun run verify", exitCode: 0, output: "48 pass", source: "runtime-join" },
          { command: "npm pack --dry-run", exitCode: 0, output: "package ok", source: "runtime-join" },
        ],
      },
      {
        id: "root/source",
        parentId: "root",
        role: "nurse",
        scope: "source",
        status: "verified",
        depth: 1,
        baseCommit: "boundary",
        usage: { input: 10, output: 5, reasoning: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      },
      {
        id: "root/source/implementation",
        parentId: "root/source",
        role: "surgeon",
        scope: "implementation",
        status: "verified",
        depth: 2,
        baseCommit: "boundary",
        usage: { input: 10, output: 5, reasoning: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
      },
    ],
  }
  const passed = evaluateSelfHostQualification(snapshot, ["src/runtime.ts", "tests/runtime.test.ts"], 1)
  expect(passed.passed).toBe(true)
  expect(renderSelfHostQualification(passed)).toContain("QUALIFIED")

  const failed = evaluateSelfHostQualification(snapshot, ["src/runtime.ts", ".quack/contracts/run/world.wit"], 2)
  expect(failed.passed).toBe(false)
  expect(failed.checks.filter((item) => item.status === "FAIL").map((item) => item.name))
    .toEqual(["normalized result", "regression test", "product-only diff"])

  const workerOnly = structuredClone(snapshot)
  const root = workerOnly.nodes.find((node) => node.id === workerOnly.rootNodeId)
  if (!root?.evidence) throw new Error("missing root fixture evidence")
  root.evidence = root.evidence.map((item) => ({ ...item, source: "worker-feedback" }))
  const untrusted = evaluateSelfHostQualification(workerOnly, ["src/runtime.ts", "tests/runtime.test.ts"], 1)
  expect(untrusted.passed).toBe(false)
  expect(untrusted.checks.filter((item) => item.status === "FAIL").map((item) => item.name))
    .toEqual(["full verification", "package inspection"])
})
