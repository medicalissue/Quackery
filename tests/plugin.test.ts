import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QuackeryPlugin } from "../src/index.js"

test("visible Pharmacist cannot use its edit permission outside an authorized runtime session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quack-plugin-"))
  const hooks: any = await (QuackeryPlugin as any)({ client: {}, directory })
  await hooks["chat.message"]({ sessionID: "visible-pharmacist", agent: "pharmacist" }, {})
  expect(hooks["tool.execute.before"](
    { sessionID: "visible-pharmacist", tool: "write", callID: "call-1" },
    { args: { filePath: "src/product.ts" } },
  )).rejects.toThrow("Visible Pharmacist cannot edit files")
})
