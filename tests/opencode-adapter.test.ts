import { expect, test } from "bun:test"
import { parseJsonResponse } from "../src/opencode-adapter.js"

test("extracts a decomposer JSON object from an OpenCode text response", () => {
  const response = {
    data: {
      parts: [
        { type: "tool", name: "write" },
        { type: "text", text: "```json\n{\"kind\":\"refuse\",\"reason\":\"ambiguous\",\"detail\":\"missing owner\"}\n```" },
      ],
    },
  }
  expect(parseJsonResponse(response)).toEqual({
    kind: "refuse",
    reason: "ambiguous",
    detail: "missing owner",
  })
})
