import { access, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { z } from "zod"

export const modelTierSchema = z.enum(["frontier", "strong", "balanced", "economy"])
export type ModelTier = z.infer<typeof modelTierSchema>

export const modelTargetSchema = z.object({
  model: z.string().min(1),
  variant: z.string().min(1).optional(),
}).strict()
export type ModelTarget = z.infer<typeof modelTargetSchema>

const modelLadderSchema = z.object({
  frontier: modelTargetSchema.optional(),
  strong: modelTargetSchema.optional(),
  balanced: modelTargetSchema.optional(),
  economy: modelTargetSchema.optional(),
}).strict().default({})

const roleTierSchema = z.object({
  psychiatrist: modelTierSchema.optional(),
  pharmacist: modelTierSchema.optional(),
  nurse: modelTierSchema.optional(),
  surgeon: modelTierSchema.optional(),
}).strict().default({})

export const quackConfigSchema = z.object({
  version: z.literal(1).default(1),
  profile: z.enum(["quality", "balanced"]).default("balanced"),
  models: modelLadderSchema,
  roles: roleTierSchema,
  cache: z.object({
    mode: z.enum(["auto", "off"]).default("auto"),
    scope: z.literal("parent-boundary").default("parent-boundary"),
    minFanout: z.number().int().min(2).default(2),
  }).strict().default({ mode: "auto", scope: "parent-boundary", minFanout: 2 }),
  balance: z.object({
    maxDepthSkew: z.number().int().min(0).default(1),
    maxWorkRatio: z.number().min(1).default(2),
    allowJustifiedImbalance: z.boolean().default(true),
  }).strict().default({ maxDepthSkew: 1, maxWorkRatio: 2, allowJustifiedImbalance: true }),
  limits: z.object({
    maxDepth: z.number().int().min(1).max(12).default(6),
    maxNodes: z.number().int().min(1).max(128).default(32),
    maxNeedsNurseBounces: z.number().int().min(0).max(3).default(1),
    maxRunSeconds: z.number().int().min(1).max(86_400).default(3_600),
    maxPromptSeconds: z.number().int().min(1).max(3_600).default(600),
    verificationSeconds: z.number().int().min(1).max(1_800).default(120),
  }).strict().default({
    maxDepth: 6,
    maxNodes: 32,
    maxNeedsNurseBounces: 1,
    maxRunSeconds: 3_600,
    maxPromptSeconds: 600,
    verificationSeconds: 120,
  }),
}).strict()

export type QuackConfig = z.infer<typeof quackConfigSchema>
export type QuackPluginOptions = Partial<z.input<typeof quackConfigSchema>>
export type ModelRole = "psychiatrist" | "pharmacist" | "nurse" | "surgeon"

export interface ResolvedRoleModel {
  role: ModelRole
  tier: ModelTier
  model?: string
  variant?: string
  source: "quack" | "opencode" | "inherit"
}

const profileTiers: Record<QuackConfig["profile"], Record<ModelRole, ModelTier>> = {
  quality: {
    psychiatrist: "frontier",
    pharmacist: "frontier",
    nurse: "strong",
    surgeon: "balanced",
  },
  balanced: {
    psychiatrist: "frontier",
    pharmacist: "strong",
    nurse: "balanced",
    surgeon: "economy",
  },
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mergeObjects(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? mergeObjects(merged[key], value) : value
  }
  return merged
}

async function readJsonc(path: string): Promise<Record<string, unknown> | undefined> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const errors: ParseError[] = []
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const detail = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")
    throw new Error(`Invalid Quackery config ${path}: ${detail}`)
  }
  if (!isObject(value)) throw new Error(`Quackery config ${path} must be a JSON object`)
  return value
}

export async function findQuackDirectory(start: string): Promise<string | undefined> {
  let current = resolve(start)
  while (true) {
    const candidate = join(current, ".quack")
    try {
      await access(candidate)
      return candidate
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

export async function loadQuackConfig(start: string, pluginOptions: unknown = {}): Promise<QuackConfig> {
  const directory = await findQuackDirectory(start)
  const shared = directory ? await readJsonc(join(directory, "config.jsonc")) : undefined
  const local = directory ? await readJsonc(join(directory, "config.local.jsonc")) : undefined
  const merged = mergeObjects(mergeObjects(pluginOptions, shared ?? {}), local ?? {})
  return quackConfigSchema.parse(merged)
}

export function roleTier(config: QuackConfig, role: ModelRole): ModelTier {
  return config.roles[role] ?? profileTiers[config.profile][role]
}

export function configuredRoleModel(config: QuackConfig, role: ModelRole): ResolvedRoleModel {
  const tier = roleTier(config, role)
  const target = config.models[tier]
  return {
    role,
    tier,
    ...(target?.model ? { model: target.model } : {}),
    ...(target?.variant ? { variant: target.variant } : {}),
    source: target ? "quack" : "inherit",
  }
}
