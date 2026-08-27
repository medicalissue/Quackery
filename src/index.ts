import { relative, resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  boundaryArtifactSchema,
  rootSplitDecisionSchema,
  type NodeContext,
  type VerificationEvidence,
} from "./model.js"
import { cachePartitionKey } from "./cache.js"
import {
  configuredRoleModel,
  escalationRoleModel,
  loadQuackConfig,
  type ModelRole,
  type QuackConfig,
  type ResolvedRoleModel,
} from "./config.js"
import { pharmacistPrompt, psychiatristPrompt, nursePrompt, surgeonPrompt } from "./prompts.js"
import { RunRegistry } from "./registry.js"
import { IntentRegistry } from "./intent.js"
import { renderRunEvidence, renderRunSnapshot } from "./graph.js"
import { renderPreflight, runPreflight } from "./preflight.js"
import { ownershipContains } from "./validation.js"
import { parseJsonResponse, responseFailure } from "./opencode-adapter.js"
import { renderSelfHostQualification } from "./qualification.js"

function toolPaths(toolName: string, args: Record<string, unknown>): string[] {
  const direct = [args.filePath, args.path, args.filename].filter((value): value is string => typeof value === "string")
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (!edit || typeof edit !== "object") continue
      const record = edit as Record<string, unknown>
      const path = [record.filePath, record.path, record.filename]
        .find((value): value is string => typeof value === "string")
      if (path) direct.push(path)
    }
  }
  const patch = typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : ""
  if ((toolName === "apply_patch" || toolName === "patch") && patch) {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      const path = match[1]?.trim()
      if (path) direct.push(path)
    }
  }
  return [...new Set(direct)]
}

function repositoryRelativePath(node: NodeContext, value: string): string {
  const absolute = resolve(node.worktree, value)
  return relative(node.worktree, absolute).replaceAll("\\", "/")
}

export function assertWorkerCommand(command: string): void {
  const readOnly = new Set(["blame", "cat-file", "describe", "diff", "grep", "log", "ls-files", "ls-tree", "merge-base", "rev-parse", "show", "status"])
  for (const match of command.matchAll(/\bgit\b([^;&|\n]*)/gi)) {
    let rest = match[1]?.trim() ?? ""
    if (/^--version(?:\s|$)/.test(rest)) continue
    while (rest) {
      const optionWithValue = /^(?:-C|-c|--git-dir|--work-tree)\s+(?:"[^"]*"|'[^']*'|\S+)\s*/.exec(rest)
      if (optionWithValue) {
        rest = rest.slice(optionWithValue[0].length)
        continue
      }
      const option = /^(?:--git-dir=\S+|--work-tree=\S+|--no-pager|--paginate|-P)\s*/.exec(rest)
      if (option) {
        rest = rest.slice(option[0].length)
        continue
      }
      break
    }
    const subcommand = /^([a-z][a-z-]*)\b/i.exec(rest)?.[1]?.toLowerCase()
    if (!subcommand || !readOnly.has(subcommand)) {
      throw new Error("Quackery workers may use only read-only Git commands; commits and joins belong to the runtime")
    }
  }
}

export function workerCommandExitCode(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object") return -1
  const value = metadata as Record<string, unknown>
  return [value.exitCode, value.exit_code, value.exit, value.code]
    .find((candidate): candidate is number => typeof candidate === "number") ?? -1
}

const modelRoles: ModelRole[] = ["psychiatrist", "pharmacist", "nurse", "surgeon"]

const rootOwnershipToolSchema = tool.schema.object({
  path: tool.schema.string().min(1),
  mode: tool.schema.enum(["exact", "prefix"]),
})

const rootNursePlanToolSchema = tool.schema.object({
  id: tool.schema.string().min(1),
  kind: tool.schema.literal("scope"),
  scope: tool.schema.string().min(1),
  exports: tool.schema.array(tool.schema.string().min(1)).length(1),
  imports: tool.schema.array(tool.schema.string().min(1)),
  world: tool.schema.object({
    witPath: tool.schema.string().min(1),
    world: tool.schema.string().min(1),
    behaviorPath: tool.schema.string().min(1),
    projectionPath: tool.schema.string().min(1),
    bindingPath: tool.schema.string().min(1),
    stubs: tool.schema.array(tool.schema.object({
      interface: tool.schema.string().min(1),
      path: tool.schema.string().min(1),
    }).strict()).default([]),
  }),
  reads: tool.schema.array(tool.schema.string().min(1)).default([]),
  artifacts: tool.schema.array(tool.schema.string().min(1)).optional(),
  owns: tool.schema.array(rootOwnershipToolSchema).min(1),
  verify: tool.schema.array(tool.schema.string().min(1)).min(1),
  estimatedRemainingDepth: tool.schema.number().int().min(0),
  estimatedWork: tool.schema.number().positive(),
})

const rootDecisionToolSchema = tool.schema.object({
  kind: tool.schema.literal("split"),
  children: tool.schema.array(rootNursePlanToolSchema).min(1),
  join: tool.schema.object({
    integration: rootNursePlanToolSchema.optional(),
    verify: tool.schema.array(tool.schema.string().min(1)).min(1),
  }),
  imbalanceJustification: tool.schema.string().min(1).optional(),
})

const boundaryArtifactToolSchema = tool.schema.object({
  path: tool.schema.string().min(1),
  content: tool.schema.string(),
})

function preservedAgentTuning(agent: any): Record<string, unknown> {
  if (!agent || typeof agent !== "object") return {}
  return Object.fromEntries(
    ["model", "variant", "temperature", "top_p", "options", "steps", "maxSteps", "color"]
      .filter((key) => agent[key] !== undefined)
      .map((key) => [key, agent[key]]),
  )
}

export function agentConfiguration(config: any, quack: QuackConfig): Record<ModelRole, ResolvedRoleModel> {
  config.agent ??= {}
  const base: Record<ModelRole, Record<string, unknown>> = {
    psychiatrist: {
      description: "Clarifies user intent and produces a confirmed Intent Contract without implementation",
      mode: "primary",
      prompt: psychiatristPrompt,
      permission: {
        edit: "deny",
        task: "deny",
        "quackery_*": "deny",
        "quackery_intent_confirm": "allow",
        bash: "deny",
      },
    },
    pharmacist: {
      description: "Starts and reports Quackery's Git-native recursive parallel implementation runtime",
      mode: "primary",
      prompt: pharmacistPrompt,
      permission: {
        edit: "deny",
        bash: "deny",
        task: "deny",
        "quackery_*": "allow",
        "quackery_apply_approval": "ask",
        "quackery_abandon_approval": "ask",
      },
    },
    nurse: {
      description: "Internal recursive decomposer that creates balanced immediate WIT worlds",
      mode: "subagent",
      hidden: true,
      prompt: nursePrompt,
      permission: {
        edit: "allow",
        bash: "allow",
        task: "deny",
        "quackery_*": "deny",
      },
    },
    surgeon: {
      description: "Internal cheap implementer that fills one WIT export hole",
      mode: "subagent",
      hidden: true,
      prompt: surgeonPrompt,
      permission: {
        edit: "allow",
        bash: "allow",
        task: "deny",
        "quackery_*": "deny",
      },
    },
  }

  const effective = {} as Record<ModelRole, ResolvedRoleModel>
  for (const role of modelRoles) {
    const existing = config.agent[role] ?? {}
    const routed = configuredRoleModel(quack, role)
    const tuning = preservedAgentTuning(existing)
    const target = routed.model
      ? { model: routed.model, ...(routed.variant ? { variant: routed.variant } : {}) }
      : tuning
    config.agent[role] = { ...base[role], ...tuning, ...target }
    if (routed.model && !routed.variant) delete config.agent[role].variant
    effective[role] = routed.model
      ? routed
      : {
          ...routed,
          ...(typeof existing.model === "string"
            ? {
                model: existing.model,
                ...(typeof existing.variant === "string" ? { variant: existing.variant } : {}),
                source: "opencode" as const,
              }
            : typeof config.model === "string"
              ? { model: config.model, source: "inherit" as const }
              : {}),
        }
  }
  return effective
}

function renderModelRouting(config: QuackConfig, routing: Record<ModelRole, ResolvedRoleModel>): string {
  const lines = [`profile ${config.profile}`, ""]
  for (const role of modelRoles) {
    const item = routing[role]
    const model = item.model ?? "OpenCode current model"
    const variant = item.variant ? ` #${item.variant}` : ""
    lines.push(`${role.padEnd(12)} ${item.tier.padEnd(9)} ${model}${variant} · ${item.source}`)
  }
  return lines.join("\n")
}

interface AuthorizedRuntimeSession {
  node: NodeContext
  agent: "nurse" | "surgeon"
  probe?: boolean
  commands: VerificationEvidence[]
}

interface SharedRuntimeState {
  registry: RunRegistry
  authorizedSessions: Map<string, AuthorizedRuntimeSession>
  evidenceByRun: Map<string, Map<string, VerificationEvidence[]>>
  pendingCommands: Map<string, { sessionId: string; evidence: VerificationEvidence }>
  pharmacistSessions: Set<string>
}

const sharedRuntimeKey = Symbol.for("quackery-opencode.runtime.v1")
const sharedRuntime = (() => {
  const host = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = host[sharedRuntimeKey] as SharedRuntimeState | undefined
  if (existing) return existing
  const created: SharedRuntimeState = {
    registry: new RunRegistry(),
    authorizedSessions: new Map(),
    evidenceByRun: new Map(),
    pendingCommands: new Map(),
    pharmacistSessions: new Set(),
  }
  host[sharedRuntimeKey] = created
  return created
})()

export const QuackeryPlugin: Plugin = async ({ client, directory }, options) => {
  const quack = await loadQuackConfig(directory, options)
  const registry = sharedRuntime.registry
  const intents = new IntentRegistry()
  const { authorizedSessions, evidenceByRun, pendingCommands, pharmacistSessions } = sharedRuntime
  let effectiveModels = Object.fromEntries(
    modelRoles.map((role) => [role, configuredRoleModel(quack, role)]),
  ) as Record<ModelRole, ResolvedRoleModel>

  const authorizeSession = (
    sessionId: string,
    node: NodeContext,
    agent: "nurse" | "surgeon",
  ): void => {
    const runId = node.runId ?? "unscoped"
    const runEvidence = evidenceByRun.get(runId) ?? new Map<string, VerificationEvidence[]>()
    evidenceByRun.set(runId, runEvidence)
    const commands = runEvidence.get(node.id) ?? []
    runEvidence.set(node.id, commands)
    authorizedSessions.set(sessionId, { node, agent, commands })
  }
  const deauthorizeSession = (sessionId: string): void => {
    authorizedSessions.delete(sessionId)
    for (const [callId, pending] of pendingCommands) {
      if (pending.sessionId === sessionId) pendingCommands.delete(callId)
    }
  }
  const workerEvidence = (runId: string, nodeId: string): VerificationEvidence[] => (evidenceByRun.get(runId)?.get(nodeId) ?? [])
    .map((item) => ({ ...item }))
  const releaseWorkerEvidence = (runId: string): void => {
    evidenceByRun.delete(runId)
  }

  return {
    config: async (config) => {
      effectiveModels = agentConfiguration(config, quack)
    },

    "chat.message": async (input) => {
      if (!authorizedSessions.has(input.sessionID)) {
        if (input.agent === "pharmacist") pharmacistSessions.add(input.sessionID)
        else pharmacistSessions.delete(input.sessionID)
      }
      if ((input.agent === "nurse" || input.agent === "surgeon") && !authorizedSessions.has(input.sessionID)) {
        throw new Error(`${input.agent} is internal to the Quackery runtime and cannot be invoked directly`)
      }
    },

    "chat.params": async (input, output) => {
      const node = authorizedSessions.get(input.sessionID)?.node
      if (!node?.cache || quack.cache.mode === "off") return
      if (input.model.providerID === "openai" || input.provider.options.setCacheKey === true) {
        const role = node.role
        const variant = node.modelOverride?.variant
          ?? (role === "nurse" || role === "surgeon" ? effectiveModels[role].variant : undefined)
        output.options.promptCacheKey = cachePartitionKey(
          node.cache,
          input.model.providerID,
          input.model.id,
          variant,
        )
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID || quack.cache.mode === "off") return
      const node = authorizedSessions.get(input.sessionID)?.node
      if (node?.cache) output.system.push(node.cache.prefix)
    },

    "tool.execute.before": async (input, output) => {
      const authorized = authorizedSessions.get(input.sessionID)
      if (authorized?.probe) throw new Error("Quackery live probe sessions cannot invoke tools")
      if (authorized && ["bash", "shell"].includes(input.tool)) {
        const args = output.args as Record<string, unknown>
        const command = [args.command, args.cmd, args.script].find((value): value is string => typeof value === "string")
          ?? JSON.stringify(args).slice(0, 2_000)
        assertWorkerCommand(command)
        const evidence: VerificationEvidence = {
          command,
          exitCode: -1,
          output: "command did not complete",
          source: "worker-feedback",
        }
        authorized.commands.push(evidence)
        pendingCommands.set(input.callID, { sessionId: input.sessionID, evidence })
      }
      if (!["write", "edit", "multiedit", "patch", "apply_patch"].includes(input.tool)) return
      if (!authorized) {
        if (pharmacistSessions.has(input.sessionID)) {
          throw new Error("Visible Pharmacist cannot edit files; only its isolated runtime session may write boundaries")
        }
        return
      }
      const { node, agent } = authorized
      const paths = toolPaths(input.tool, output.args as Record<string, unknown>)
      if (paths.length === 0) throw new Error(`Cannot resolve target paths for ${input.tool}`)
      for (const path of paths) {
        const candidate = repositoryRelativePath(node, path)
        const allowed = agent === "surgeon"
          ? node.plan?.owns.some((rule) => ownershipContains(rule, candidate)) === true
          : ownershipContains({ path: node.boundaryRoot, mode: "prefix" }, candidate)
        if (!allowed) {
          throw new Error(
            agent === "surgeon"
              ? `Node ${node.id} does not own ${candidate}`
              : `Decomposer ${node.id} may write only under ${node.boundaryRoot}, not ${candidate}`,
          )
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const pending = pendingCommands.get(input.callID)
      if (!pending || pending.sessionId !== input.sessionID) return
      pendingCommands.delete(input.callID)
      const metadata = output.metadata as Record<string, unknown> | undefined
      pending.evidence.exitCode = workerCommandExitCode(metadata)
      pending.evidence.output = output.output.slice(-20_000)
    },

    tool: {
      quackery_intent_confirm: tool({
        description: "Persist the Intent Contract after explicit user confirmation. Psychiatrist only.",
        args: {
          goal: tool.schema.string().min(1),
          observableOutcomes: tool.schema.array(tool.schema.string().min(1)).min(1),
          inScope: tool.schema.array(tool.schema.string().min(1)).default([]),
          outOfScope: tool.schema.array(tool.schema.string().min(1)).default([]),
          constraints: tool.schema.array(tool.schema.string().min(1)).default([]),
          acceptance: tool.schema.array(tool.schema.string().min(1)).min(1),
          assumptions: tool.schema.array(tool.schema.string().min(1)).default([]),
        },
        async execute(args, context) {
          if (context.agent !== "psychiatrist") throw new Error("Only Psychiatrist can confirm an Intent Contract")
          const intent = await intents.confirm(context.directory, context.sessionID, "psychiatrist", args)
          return {
            title: `Intent ${intent.revision}`,
            output: `Confirmed ${intent.revision} at ${intent.repositoryBase.slice(0, 7)}. Pharmacist can now consume this revision.`,
            metadata: { revision: intent.revision, repositoryBase: intent.repositoryBase },
          }
        },
      }),

      quackery_start: tool({
        description: "Freeze Pharmacist's root Nurse split and start the background Quackery runtime.",
        args: {
          intentRevision: tool.schema.string().min(1).optional(),
          directGoal: tool.schema.string().min(1).optional(),
          rootDecision: rootDecisionToolSchema,
          artifacts: tool.schema.array(boundaryArtifactToolSchema).min(1),
          maxDepth: tool.schema.number().int().min(1).max(12).optional(),
          maxNodes: tool.schema.number().int().min(1).max(128).optional(),
        },
        async execute(args, context) {
          if (context.agent !== "pharmacist") throw new Error("Only Pharmacist can start Quackery")
          if (args.intentRevision && args.directGoal) {
            throw new Error("Choose a confirmed intentRevision or a directGoal, not both")
          }
          const rootDecision = rootSplitDecisionSchema.parse(args.rootDecision)
          const intent = args.directGoal
            ? await intents.confirm(context.directory, context.sessionID, "pharmacist-direct", {
                goal: args.directGoal,
                observableOutcomes: [args.directGoal],
                inScope: [
                  ...rootDecision.children.map((child) => child.scope),
                  ...(rootDecision.join.integration ? [rootDecision.join.integration.scope] : []),
                ],
                outOfScope: [],
                constraints: ["Changes remain within the root plan's declared ownership reservations"],
                acceptance: rootDecision.join.verify,
                assumptions: ["Direct Pharmacist request; no Psychiatrist interview was required"],
              })
            : await intents.resolve(context.directory, context.sessionID, args.intentRevision)
          const artifacts = tool.schema.array(boundaryArtifactToolSchema).parse(args.artifacts)
          const parsedArtifacts = boundaryArtifactSchema.array().parse(artifacts)
          const handle = await registry.start({
            directory: context.directory,
            sessionId: context.sessionID,
            goal: intent.goal,
            intent,
            rootDecision,
            artifacts: parsedArtifacts,
            client,
            authorizeSession,
            deauthorizeSession,
            workerEvidence,
            releaseWorkerEvidence,
            policy: {
              ...quack.balance,
              maxDepth: args.maxDepth ?? quack.limits.maxDepth,
              maxNodes: args.maxNodes ?? quack.limits.maxNodes,
              maxNeedsNurseBounces: quack.limits.maxNeedsNurseBounces,
              maxLeafAttempts: quack.limits.maxLeafAttempts,
              maxDecompositionAttempts: quack.limits.maxDecompositionAttempts,
              maxJoinAttempts: quack.limits.maxJoinAttempts,
              maxConcurrency: quack.limits.maxConcurrency,
              maxObservedCost: quack.limits.maxObservedCost,
            },
            models: Object.fromEntries(
              (["nurse", "surgeon"] as const)
                .map((role) => [role, effectiveModels[role]] as const)
                .filter((entry) => Boolean(entry[1].model))
                .map(([role, target]) => [role, {
                  model: target.model!,
                  ...(target.variant ? { variant: target.variant } : {}),
                }]),
            ),
            escalation: Object.fromEntries(
              (["nurse", "surgeon"] as const)
                .map((role) => [role, escalationRoleModel(quack, role)] as const)
                .filter((entry): entry is readonly ["nurse" | "surgeon", NonNullable<typeof entry[1]>] => Boolean(entry[1]?.model))
                .map(([role, target]) => [role, {
                  model: target.model!,
                  ...(target.variant ? { variant: target.variant } : {}),
                }]),
            ),
            cache: {
              enabled: quack.cache.mode === "auto",
              minFanout: quack.cache.minFanout,
            },
            timeouts: {
              runMs: quack.limits.maxRunSeconds * 1_000,
              promptMs: quack.limits.maxPromptSeconds * 1_000,
              verificationMs: quack.limits.verificationSeconds * 1_000,
            },
          })
          return {
            title: `Quackery ${handle.id}`,
            output: `Started ${handle.id}. The original checkout remains untouched.\n\n${handle.graph.render()}`,
            metadata: { runId: handle.id },
          }
        },
      }),

      quackery_status: tool({
        description: "Render the current Quackery graph as ordinary text.",
        args: { runId: tool.schema.string().optional() },
        async execute(args, context) {
          const snapshot = await registry.snapshot(context.directory, args.runId, context.sessionID)
          return {
            title: `Quackery ${snapshot.id}`,
            output: renderRunSnapshot(snapshot),
            metadata: { runId: snapshot.id, status: snapshot.status },
          }
        },
      }),

      quackery_evidence: tool({
        description: "Show persisted provider usage and command/verification evidence for a Quackery run or node.",
        args: {
          runId: tool.schema.string().optional(),
          nodeId: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const snapshot = await registry.snapshot(context.directory, args.runId, context.sessionID)
          return {
            title: `Quackery ${snapshot.id} evidence`,
            output: renderRunEvidence(snapshot, args.nodeId),
            metadata: { runId: snapshot.id, status: snapshot.status, nodeId: args.nodeId },
          }
        },
      }),

      quackery_qualify_self_host: tool({
        description: "Evaluate a run against Quackery's deterministic B1 source-and-regression-test self-hosting gate.",
        args: { runId: tool.schema.string().optional() },
        async execute(args, context) {
          const qualification = await registry.qualifySelfHost(context.directory, args.runId, context.sessionID)
          return {
            title: qualification.passed ? "Quackery self-host qualified" : "Quackery self-host not qualified",
            output: renderSelfHostQualification(qualification),
            metadata: { runId: qualification.runId, passed: qualification.passed },
          }
        },
      }),

      quackery_model_status: tool({
        description: "Show the resolved Quackery role-to-model ladder and configuration source.",
        args: {},
        async execute() {
          return {
            title: "Quackery model routing",
            output: renderModelRouting(quack, effectiveModels),
            metadata: { profile: quack.profile },
          }
        },
      }),

      quackery_doctor: tool({
        description: "Check local prerequisites and optionally run one read-only live provider protocol probe.",
        args: {
          live: tool.schema.boolean().default(false),
        },
        async execute(args, context) {
          const report = await runPreflight(context.directory, quack, effectiveModels)
          if (args.live && report.ready) {
            const node: NodeContext = {
              id: "live-probe",
              depth: 0,
              role: "nurse",
              scope: "Return one structured live-probe response without tools",
              worktree: context.directory,
              baseCommit: "live-probe",
              boundaryRoot: ".quack/contracts/live-probe",
            }
            let sessionId: string | undefined
            try {
              const created: any = await client.session.create({
                query: { directory: context.directory },
                body: { parentID: context.sessionID, title: "quackery · live provider probe" },
                signal: AbortSignal.timeout(quack.limits.maxPromptSeconds * 1_000),
              })
              const createFailure = responseFailure(created)
              if (createFailure) throw new Error(createFailure)
              sessionId = created?.data?.id ?? created?.id
              if (!sessionId) throw new Error("OpenCode did not return a probe session id")
              authorizedSessions.set(sessionId, { node, agent: "nurse", probe: true, commands: [] })
              const response = await client.session.prompt({
                path: { id: sessionId },
                query: { directory: context.directory },
                body: {
                  agent: "nurse",
                  parts: [{
                    type: "text",
                    text: "Do not call tools. Return exactly this JSON object and nothing else: {\"kind\":\"quackery-live-probe\",\"ok\":true}",
                  }],
                },
                signal: AbortSignal.timeout(quack.limits.maxPromptSeconds * 1_000),
              })
              const parsed = parseJsonResponse(response) as { kind?: unknown; ok?: unknown }
              if (parsed.kind !== "quackery-live-probe" || parsed.ok !== true) {
                throw new Error("provider returned the wrong live-probe payload")
              }
              const check = report.checks.find((item) => item.name === "live provider protocol")
              if (check) Object.assign(check, {
                status: "PASS",
                detail: "child session returned the expected structured response",
              })
            } catch (error) {
              report.ready = false
              const check = report.checks.find((item) => item.name === "live provider protocol")
              if (check) Object.assign(check, {
                status: "FAIL",
                detail: error instanceof Error ? error.message : String(error),
              })
            } finally {
              if (sessionId) {
                authorizedSessions.delete(sessionId)
                try {
                  await client.session.delete({
                    path: { id: sessionId },
                    query: { directory: context.directory },
                  })
                } catch {
                  // Probe cleanup must not hide the provider result.
                }
              }
            }
          }
          return {
            title: report.ready ? "Quackery ready" : "Quackery preflight failed",
            output: renderPreflight(report),
            metadata: { ready: report.ready },
          }
        },
      }),

      quackery_wait: tool({
        description: "Wait briefly for a Quackery run and then return its text graph.",
        args: {
          runId: tool.schema.string().optional(),
          timeoutSeconds: tool.schema.number().int().min(1).max(60).default(30),
        },
        async execute(args, context) {
          const snapshot = await registry.wait(
            context.directory,
            args.runId,
            context.sessionID,
            args.timeoutSeconds,
          )
          return {
            title: `Quackery ${snapshot.id}`,
            output: renderRunSnapshot(snapshot),
            metadata: { runId: snapshot.id, status: snapshot.status },
          }
        },
      }),

      quackery_cancel: tool({
        description: "Cancel a running Quackery run while preserving its graph, commits, and worktrees for inspection.",
        args: { runId: tool.schema.string().optional() },
        async execute(args, context) {
          if (context.agent !== "pharmacist") throw new Error("Only Pharmacist can cancel Quackery")
          const snapshot = await registry.cancel(context.directory, args.runId, context.sessionID)
          return {
            title: `Quackery ${snapshot.id} canceled`,
            output: renderRunSnapshot(snapshot),
            metadata: { runId: snapshot.id, status: snapshot.status },
          }
        },
      }),

      quackery_abandon: tool({
        description: "Discard an unapplied Quackery run and clean its temporary worktrees and branches after approval.",
        args: { runId: tool.schema.string().optional() },
        async execute(args, context) {
          if (context.agent !== "pharmacist") throw new Error("Only Pharmacist can abandon Quackery")
          const snapshot = await registry.snapshot(context.directory, args.runId, context.sessionID)
          await context.ask({
            permission: "quackery_abandon_approval",
            patterns: [snapshot.id],
            always: [],
            metadata: { runId: snapshot.id },
          })
          const abandoned = await registry.abandon(context.directory, snapshot.id, context.sessionID)
          const cleanup = abandoned.cleanup?.failures.length
            ? `Cleanup warning: ${abandoned.cleanup.failures.join("; ")}`
            : "Temporary worktrees and run branches were cleaned."
          return `Abandoned ${abandoned.id}. ${cleanup}`
        },
      }),

      quackery_apply: tool({
        description: "Apply a verified root result commit to the unchanged invocation branch after approval.",
        args: { runId: tool.schema.string().optional() },
        async execute(args, context) {
          if (context.agent !== "pharmacist") throw new Error("Only Pharmacist can apply a Quackery result")
          const snapshot = await registry.snapshot(context.directory, args.runId, context.sessionID)
          if (snapshot.status === "applied") {
            const recovered = await registry.apply(context.directory, snapshot.id, context.sessionID)
            const cleanup = recovered.cleanup?.failures.length
              ? ` Cleanup still needs attention: ${recovered.cleanup.failures.join("; ")}`
              : " Cleanup is complete."
            return `Run ${snapshot.id} was already applied at ${snapshot.appliedCommit}.${cleanup}`
          }
          if (snapshot.status !== "verified" || !snapshot.resultCommit) {
            throw new Error(`Run ${snapshot.id} is ${snapshot.status}; only a verified result can be applied`)
          }
          await context.ask({
            permission: "quackery_apply_approval",
            patterns: [snapshot.resultCommit],
            always: [],
            metadata: { runId: snapshot.id, commit: snapshot.resultCommit },
          })
          const applied = await registry.apply(context.directory, snapshot.id, context.sessionID)
          const cleanup = applied.cleanup?.failures.length
            ? ` Cleanup warning: ${applied.cleanup.failures.join("; ")}`
            : " Temporary worktrees and run branches were cleaned."
          return `Applied verified result ${snapshot.resultCommit} at ${applied.appliedCommit}.${cleanup}`
        },
      }),
    },
  }
}
