import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("package exposes an OpenCode server plugin entrypoint", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    main?: string
    exports?: Record<string, string>
  }

  expect(manifest.main).toBe("./dist/index.js")
  expect(manifest.exports?.["."]).toBe("./dist/index.js")
  expect(manifest.exports?.["./server"]).toBe("./dist/index.js")
})
