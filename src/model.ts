import { z } from "zod"
import type { ConfirmedIntent } from "./intent.js"

export const ownershipRuleSchema = z.object({
  path: z.string().min(1),
  mode: z.enum(["exact", "prefix"]),
})

export type OwnershipRule = z.infer<typeof ownershipRuleSchema>

export const worldRefSchema = z.object({
  witPath: z.string().min(1),
  world: z.string().min(1),
  behaviorPath: z.string().min(1),
})

export type WorldRef = z.infer<typeof worldRefSchema>

export const nodePlanSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["scope", "leaf"]),
  scope: z.string().min(1),
  exports: z.array(z.string().min(1)).length(1),
  imports: z.array(z.string().min(1)),
  world: worldRefSchema,
  reads: z.array(z.string().min(1)).default([]),
  artifacts: z.array(z.string().min(1)).optional(),
  owns: z.array(ownershipRuleSchema).min(1),
  verify: z.array(z.string().min(1)).min(1),
  estimatedRemainingDepth: z.number().int().min(0),
  estimatedWork: z.number().positive(),
})

export type NodePlan = z.infer<typeof nodePlanSchema>

export const joinPlanSchema = z.object({
  integration: nodePlanSchema.optional(),
  verify: z.array(z.string().min(1)).default([]),
})

export type JoinPlan = z.infer<typeof joinPlanSchema>

export const leafDecisionSchema = z.object({
  kind: z.literal("leaf"),
  leaf: nodePlanSchema,
})

export const splitDecisionSchema = z.object({
  kind: z.literal("split"),
  children: z.array(nodePlanSchema).min(2),
  join: joinPlanSchema,
  imbalanceJustification: z.string().min(1).optional(),
})

export const refuseDecisionSchema = z.object({
  kind: z.literal("refuse"),
  reason: z.string().min(1),
  detail: z.string().min(1),
})

export const decompositionDecisionSchema = z.discriminatedUnion("kind", [
  leafDecisionSchema,
  splitDecisionSchema,
  refuseDecisionSchema,
])

export type LeafDecision = z.infer<typeof leafDecisionSchema>
export type SplitDecision = z.infer<typeof splitDecisionSchema>
export type RefuseDecision = z.infer<typeof refuseDecisionSchema>
export type DecompositionDecision = z.infer<typeof decompositionDecisionSchema>

export type NodeRole = "pharmacist" | "nurse" | "surgeon" | "integration-surgeon"

export interface CacheContext {
  protocol: string
  group: string
  prefix: string
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export interface NodeContext {
  id: string
  parentId?: string
  depth: number
  role: NodeRole
  scope: string
  plan?: NodePlan
  worktree: string
  baseCommit: string
  boundaryCommit?: string
  boundaryRoot: string
  cache?: CacheContext
  intent?: ConfirmedIntent
}

export type NodeStatus =
  | "pending"
  | "decomposing"
  | "boundary"
  | "implementing"
  | "joining"
  | "verified"
  | "failed"
  | "refused"

export interface VerificationEvidence {
  command: string
  exitCode: number
  output: string
}

export interface NodeSuccess {
  ok: true
  nodeId: string
  baseCommit: string
  headCommit: string
  changedPaths: string[]
  evidence: VerificationEvidence[]
  actualDepth: number
  usage?: TokenUsage
}

export interface NodeFailure {
  ok: false
  nodeId: string
  reason: string
  detail?: string
  recoverableCommit?: string
  actualDepth: number
  usage?: TokenUsage
}

export type NodeResult = NodeSuccess | NodeFailure

export interface GraphNodeState {
  id: string
  parentId?: string
  role: NodeRole
  scope: string
  status: NodeStatus
  depth: number
  estimatedRemainingDepth?: number
  estimatedWork?: number
  baseCommit: string
  boundaryCommit?: string
  headCommit?: string
  failure?: string
  cacheGroup?: string
  usage?: TokenUsage
  startedAt?: number
  completedAt?: number
}

export interface RunSnapshot {
  id: string
  repository: string
  rootNodeId: string
  invocationBase: string
  resultCommit?: string
  status: "running" | "verified" | "failed"
  nodes: GraphNodeState[]
  createdAt: number
  updatedAt: number
}
