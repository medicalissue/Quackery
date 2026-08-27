import { expect, test } from "bun:test"
import type { NodeContext } from "../src/model.js"
import {
  decompositionPrompt,
  implementationPrompt,
  nursePrompt,
  pharmacistPrompt,
  psychiatristPrompt,
  quackeryRolePrelude,
  surgeonPrompt,
} from "../src/prompts.js"

const nurseNode: NodeContext = {
  id: "root/scope",
  depth: 1,
  role: "nurse",
  scope: "decompose one scope",
  worktree: "/tmp/quackery-scope",
  baseCommit: "base",
  boundaryRoot: ".quack/contracts/run/scope",
}

const surgeonNode: NodeContext = {
  ...nurseNode,
  id: "root/scope/leaf",
  depth: 2,
  role: "surgeon",
  scope: "implement one leaf",
  plan: {
    id: "leaf",
    kind: "leaf",
    scope: "implement one leaf",
    exports: ["feature"],
    imports: ["store"],
    world: {
      witPath: "world.wit",
      world: "feature",
      behaviorPath: "behavior.md",
      projectionPath: "projection.ts",
      bindingPath: "binding.json",
      stubs: [],
    },
    reads: [],
    owns: [{ path: "src/feature.ts", mode: "exact" }],
    verify: ["bun test"],
    estimatedRemainingDepth: 0,
    estimatedWork: 1,
  },
}

test("every role sees the same software-protocol map before its assignment", () => {
  expect(quackeryRolePrelude).toContain("software-orchestration role names")
  expect(quackeryRolePrelude).toContain("They are not real clinical jobs")
  expect(quackeryRolePrelude).toContain("Pharmacist -> Nurse")
  expect(quackeryRolePrelude).toContain("Nurse -> Nurse | Surgeon")
  expect(quackeryRolePrelude).toContain("one cohesive responsibility, not one source function")
  expect(quackeryRolePrelude).toContain("Never expose local variables, loops, branches, algorithms")
  expect(quackeryRolePrelude).toContain("Models do not contact, message, or spawn the other roles themselves")

  for (const prompt of [psychiatristPrompt, pharmacistPrompt, nursePrompt, surgeonPrompt]) {
    expect(prompt.startsWith(quackeryRolePrelude)).toBe(true)
    expect(prompt.match(/QUACKERY SOFTWARE EXECUTION PROTOCOL/g)).toHaveLength(1)
  }
})

test("Psychiatrist adapts interview depth but stops before decomposition", () => {
  expect(psychiatristPrompt).toContain("ADAPT INTERVIEW DEPTH")
  expect(psychiatristPrompt).toContain("EVIDENCE BEFORE QUESTIONS")
  expect(psychiatristPrompt).toContain("clearance gate")
  expect(psychiatristPrompt).toContain("return CLARIFY")
  expect(psychiatristPrompt).toContain("return READY")
  expect(psychiatristPrompt).toContain("Do not edit files")
  expect(psychiatristPrompt).toContain("WIT worlds")
  expect(psychiatristPrompt).toContain("detailed implementation plan")
})

test("implementation roles encode the strict Pharmacist to Nurse to Surgeon tree", () => {
  expect(pharmacistPrompt).toContain("You never hand work directly to a Surgeon")
  expect(pharmacistPrompt).toContain("Every root child must have kind \"scope\"")
  expect(pharmacistPrompt).toContain("current checkout is the root context")
  expect(pharmacistPrompt).toContain("Decompose by cohesive responsibility or capability")
  expect(pharmacistPrompt).toContain("do not manufacture one child per method")
  expect(nursePrompt).toContain("created by Pharmacist or by another Nurse")
  expect(nursePrompt).toContain("does not ask you to act like a real nurse or communicate with a Pharmacist model")
  expect(nursePrompt).toContain("kind \"leaf\" for Surgeon work and kind \"scope\" for Nurse work")
  expect(nursePrompt).toContain("runtime creates a separate Surgeon child")
  expect(nursePrompt).toContain("Atomic does not mean one function or a tiny code fragment")
  expect(nursePrompt).toContain("Preconditions, Postconditions, Invariants")
  expect(nursePrompt).toContain("projections contain signatures/types only")
  expect(nursePrompt).toContain("reuses exports, imports, world (all paths and stubs), artifacts, owns, and verify exactly")
  expect(nursePrompt).toContain("run trusted-local inspection")
  expect(surgeonPrompt).toContain("one atomic LEAF only from a Nurse")
  expect(surgeonPrompt).toContain("single cohesive exported object/service responsibility")
  expect(surgeonPrompt).toContain("return needs-nurse")
  expect(surgeonPrompt).toContain("return contract-failure")
  expect(surgeonPrompt).toContain("trusted-local build, type-check, test")
  expect(surgeonPrompt).toContain("not final acceptance")
  expect(surgeonPrompt).toContain("Do not mistake decomposition pseudocode for a public contract")
})

test("node prompts contain only the assigned node payload, not a duplicate role prompt", () => {
  const nursePayload = decompositionPrompt(nurseNode)
  const surgeonPayload = implementationPrompt(surgeonNode)

  expect(nursePayload).toStartWith("CURRENT NODE")
  expect(surgeonPayload).toStartWith("NODE PLAN")
  expect(nursePayload).not.toContain("QUACKERY SOFTWARE EXECUTION PROTOCOL")
  expect(surgeonPayload).not.toContain("QUACKERY SOFTWARE EXECUTION PROTOCOL")
  expect(nursePayload).not.toContain("YOUR ASSIGNED ROLE")
  expect(surgeonPayload).not.toContain("YOUR ASSIGNED ROLE")
  expect(nursePayload).toContain("one encapsulated object/service responsibility")
  expect(nursePayload).toContain("It must not encode internal variables")
  expect(nursePayload).toContain("Responsibility, Inputs, Outputs, Preconditions, Postconditions, Invariants")
  expect(nursePayload).toContain("If the inherited scope is atomic")
})
