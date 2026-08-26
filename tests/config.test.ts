import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentConfiguration } from "../src/index.js"
import { configuredRoleModel, loadQuackConfig } from "../src/config.js"

test("loads JSONC config with local overrides and profile role defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "quack-config-"))
  try {
    const quack = join(root, ".quack")
    await mkdir(quack)
    await writeFile(join(quack, "config.jsonc"), `{
      // Shared project policy.
      "profile": "balanced",
      "models": {
        "frontier": { "model": "shared/frontier" },
        "economy": { "model": "shared/economy" },
      },
      "limits": { "maxDepth": 7 }
    }`)
    await writeFile(join(quack, "config.local.jsonc"), `{
      "models": { "economy": { "model": "local/economy", "variant": "fast" } },
      "roles": { "nurse": "strong" },
    }`)

    const config = await loadQuackConfig(join(root, "nested"), {
      profile: "quality",
      limits: { maxNodes: 12 },
    })

    expect(config.profile).toBe("balanced")
    expect(config.limits).toEqual({ maxDepth: 7, maxNodes: 12 })
    expect(configuredRoleModel(config, "psychiatrist")).toMatchObject({ tier: "frontier", model: "shared/frontier" })
    expect(configuredRoleModel(config, "nurse")).toMatchObject({ tier: "strong", source: "inherit" })
    expect(configuredRoleModel(config, "surgeon")).toMatchObject({
      tier: "economy",
      model: "local/economy",
      variant: "fast",
      source: "quack",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("preserves OpenCode model tuning unless the Quack model ladder overrides it", async () => {
  const inherited = await loadQuackConfig("/tmp/no-quackery-config-here")
  const config: any = {
    model: "host/default",
    agent: {
      nurse: { model: "host/nurse", variant: "careful", temperature: 0.2 },
      psychiatrist: { model: "host/frontier", variant: "old-variant" },
    },
  }
  const inheritedRouting = agentConfiguration(config, inherited)
  expect(config.agent.nurse).toMatchObject({ model: "host/nurse", variant: "careful", temperature: 0.2 })
  expect(inheritedRouting.nurse).toMatchObject({ model: "host/nurse", variant: "careful", source: "opencode" })

  const root = await mkdtemp(join(tmpdir(), "quack-model-"))
  try {
    await mkdir(join(root, ".quack"))
    await writeFile(join(root, ".quack", "config.jsonc"), `{
      "models": {
        "frontier": { "model": "project/frontier" },
        "balanced": { "model": "project/nurse", "variant": "medium" }
      }
    }`)
    const project = await loadQuackConfig(root)
    const projectRouting = agentConfiguration(config, project)
    expect(config.agent.nurse).toMatchObject({ model: "project/nurse", variant: "medium", temperature: 0.2 })
    expect(projectRouting.nurse).toMatchObject({ model: "project/nurse", variant: "medium", source: "quack" })
    expect(config.agent.psychiatrist.model).toBe("project/frontier")
    expect(config.agent.psychiatrist.variant).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects invalid project policy instead of silently falling back", async () => {
  const root = await mkdtemp(join(tmpdir(), "quack-invalid-"))
  try {
    await mkdir(join(root, ".quack"))
    await writeFile(join(root, ".quack", "config.jsonc"), `{ "cache": { "minFanout": 1 } }`)
    expect(loadQuackConfig(root)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
