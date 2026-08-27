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
  projectionPath: z.string().min(1),
  bindingPath: z.string().min(1),
  stubs: z.array(z.object({
    interface: z.string().min(1),
    path: z.string().min(1),
  }).strict()).default([]),
})

export type WorldRef = z.infer<typeof worldRefSchema>

export const nodePlanSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be one safe path segment"),
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
  leaf: nodePlanSchema.extend({ kind: z.literal("leaf") }),
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

const rootNursePlanSchema = nodePlanSchema.extend({
  kind: z.literal("scope"),
})

export const rootSplitDecisionSchema = z.object({
  kind: z.literal("split"),
  children: z.array(rootNursePlanSchema).min(1),
  join: z.object({
    integration: rootNursePlanSchema.optional(),
    verify: z.array(z.string().min(1)).min(1),
  }),
  imbalanceJustification: z.string().min(1).optional(),
})

export type RootSplitDecision = z.infer<typeof rootSplitDecisionSchema>

export const boundaryArtifactSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
}).strict()

export type BoundaryArtifact = z.infer<typeof boundaryArtifactSchema>
export type RefuseDecision = z.infer<typeof refuseDecisionSchema>
export type DecompositionDecision = z.infer<typeof decompositionDecisionSchema>

export type NodeRole = "pharmacist" | "nurse" | "surgeon"

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
  runId?: string
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
  attempt?: number
  repair?: {
    reason: string
    detail?: string
    evidence?: VerificationEvidence[]
  }
  priorEvidence?: VerificationEvidence[]
  modelOverride?: {
    providerID: string
    modelID: string
    variant?: string
  }
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
  | "canceled"

export interface VerificationEvidence {
  command: string
  exitCode: number
  output: string
  source?: "worker-feedback" | "runtime-leaf" | "runtime-join"
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
  evidence?: VerificationEvidence[]
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
  recoverableCommit?: string
  cacheGroup?: string
  usage?: TokenUsage
  attempts?: number
  actualDepth?: number
  changedPaths?: string[]
  evidence?: VerificationEvidence[]
  model?: string
  startedAt?: number
  completedAt?: number
}

export interface RunSnapshot {
  id: string
  sessionId?: string
  repository: string
  rootNodeId: string
  invocationBase: string
  resultCommit?: string
  appliedCommit?: string
  worktrees?: Array<{ nodeId: string; path: string; branch: string }>
  lease?: {
    id: string
    processId: number
    heartbeatAt: number
  }
  cleanup?: {
    removedWorktrees: string[]
    removedBranches: string[]
    failures: string[]
  }
  status: "running" | "verified" | "failed" | "interrupted" | "canceled" | "abandoned" | "applied"
  nodes: GraphNodeState[]
  createdAt: number
  updatedAt: number
}
