import { createHash } from "node:crypto"
import type { CacheContext, DecompositionDecision, NodeContext, NodePlan, TokenUsage } from "./model.js"

export const CACHE_PROTOCOL_VERSION = "qcp-1"

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function planInterface(plan: NodePlan): unknown {
  return {
    id: plan.id,
    kind: plan.kind,
    exports: [...plan.exports].sort(),
    imports: [...plan.imports].sort(),
    world: plan.world,
  }
}

export interface BoundaryCacheSeed {
  boundaryCommit: string
  parentNodeId: string
  parentScope: string
  interfaces: unknown[]
}

export function boundaryCacheSeed(
  node: NodeContext,
  boundaryCommit: string,
  decision: DecompositionDecision,
): BoundaryCacheSeed {
  const plans = decision.kind === "leaf"
    ? [decision.leaf]
    : decision.kind === "split"
      ? decision.children
      : []
  return {
    boundaryCommit,
    parentNodeId: node.id,
    parentScope: node.scope,
    interfaces: plans
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(planInterface),
  }
}

export function cacheContext(seed: BoundaryCacheSeed, role: "nurse" | "surgeon"): CacheContext {
  const prefix = stableJson({ protocol: CACHE_PROTOCOL_VERSION, role, ...seed })
  const digest = createHash("sha256").update(prefix).digest("hex").slice(0, 32)
  return {
    protocol: CACHE_PROTOCOL_VERSION,
    group: `quack:${role}:${digest}`,
    prefix: `QUACKERY SHARED BOUNDARY\n${prefix}\nNode-specific instructions follow after this stable prefix.`,
  }
}

export function cachePartitionKey(
  context: CacheContext,
  providerId: string,
  modelId: string,
  variant?: string,
): string {
  const digest = createHash("sha256")
    .update(stableJson({ group: context.group, providerId, modelId, variant: variant ?? "default" }))
    .digest("hex")
    .slice(0, 40)
  return `quack:${digest}`
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost + right.cost,
  }
}

export function usageFromResponse(value: unknown): TokenUsage {
  const data = value && typeof value === "object" && "data" in value
    ? (value as { data: any }).data
    : value as any
  const info = data?.info ?? data?.message ?? data
  const tokens = info?.tokens
  if (!tokens) return emptyUsage()
  return {
    input: number(tokens.input),
    output: number(tokens.output),
    reasoning: number(tokens.reasoning),
    cacheRead: number(tokens.cache?.read),
    cacheWrite: number(tokens.cache?.write),
    cost: number(info.cost),
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
