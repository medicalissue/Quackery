import { expect, test } from "bun:test"
import { psychiatristPrompt } from "../src/prompts.js"

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
