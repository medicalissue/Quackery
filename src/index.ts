import { relative, resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { NodeContext } from "./model.js"
import { cachePartitionKey } from "./cache.js"
import { configuredRoleModel, loadQuackConfig, type ModelRole, type QuackConfig, type ResolvedRoleModel } from "./config.js"
import { pharmacistPrompt, psychiatristPrompt, nursePrompt, surgeonPrompt } from "./prompts.js"
import { RunRegistry } from "./registry.js"
import { IntentRegistry } from "./intent.js"
import { ownershipContains } from "./validation.js"

function toolPaths(toolName: string, args: Record<string, unknown>): string[] {
  const direct = [args.filePath, args.path, args.filename].filter((value): value is string => typeof value === "string")
  const patch = typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : ""
  if (toolName === "apply_patch" && patch) {
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

const modelRoles: ModelRole[] = ["psychiatrist", "pharmacist", "nurse", "surgeon"]

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
        "quackery_intent_confirm": "allow",
        bash: {
          "*": "deny",
          "git status*": "allow",
          "git log*": "allow",
          "git diff*": "allow",
          "git show*": "allow",
          "rg *": "allow",
          "ls *": "allow",
        },
      },
    },
    pharmacist: {
      description: "Starts and reports Quackery's Git-native recursive parallel implementation runtime",
      mode: "primary",
      prompt: pharmacistPrompt,
      permission: {
        edit: "allow",
        bash: "deny",
        task: "deny",
        "quackery_*": "allow",
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

export const QuackeryPlugin: Plugin = async ({ client, directory }, options) => {
  const quack = await loadQuackConfig(directory, options)
  const registry = new RunRegistry()
  const intents = new IntentRegistry()
  const authorizedSessions = new Map<string, {
    node: NodeContext
    agent: "pharmacist" | "nurse" | "surgeon"
  }>()
  const pharmacistSessions = new Set<string>()
  let effectiveModels = Object.fromEntries(
    modelRoles.map((role) => [role, configuredRoleModel(quack, role)]),
  ) as Record<ModelRole, ResolvedRoleModel>

  const authorizeSession = (
    sessionId: string,
    node: NodeContext,
    agent: "pharmacist" | "nurse" | "surgeon",
  ): void => {
    authorizedSessions.set(sessionId, { node, agent })
  }

  return {
    config: async (config) => {
      effectiveModels = agentConfiguration(config, quack)
    },

    "chat.message": async (input) => {
      if (input.agent === "pharmacist" && !authorizedSessions.has(input.sessionID)) {
        pharmacistSessions.add(input.sessionID)
      }
      if ((input.agent === "nurse" || input.agent === "surgeon") && !authorizedSessions.has(input.sessionID)) {
        throw new Error(`${input.agent} is internal to the Quackery runtime and cannot be invoked directly`)
      }
    },

    "chat.params": async (input, output) => {
      const node = authorizedSessions.get(input.sessionID)?.node
      if (!node?.cache || quack.cache.mode === "off") return
      if (input.model.providerID === "openai" || input.provider.options.setCacheKey === true) {
        const role = node.role === "integration-surgeon" ? "surgeon" : node.role
        const variant = role === "nurse" || role === "surgeon" ? effectiveModels[role].variant : undefined
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
      if (!["write", "edit", "apply_patch"].includes(input.tool)) return
      const authorized = authorizedSessions.get(input.sessionID)
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
        description: "Start a background Quackery run. Pharmacist calls this once after intent is fixed.",
        args: {
          intentRevision: tool.schema.string().min(1).optional(),
          directGoal: tool.schema.string().min(1).optional(),
          maxDepth: tool.schema.number().int().min(1).max(12).optional(),
          maxNodes: tool.schema.number().int().min(1).max(128).optional(),
        },
        async execute(args, context) {
          if (context.agent !== "pharmacist") throw new Error("Only Pharmacist can start Quackery")
          if (args.intentRevision && args.directGoal) {
            throw new Error("Choose a confirmed intentRevision or a directGoal, not both")
          }
          const intent = args.directGoal
            ? await intents.confirm(context.directory, context.sessionID, "pharmacist-direct", {
                goal: args.directGoal,
                observableOutcomes: [],
                inScope: [],
                outOfScope: [],
                constraints: [],
                acceptance: [],
                assumptions: ["Direct Pharmacist request; no Psychiatrist interview was required"],
              })
            : await intents.resolve(context.directory, context.sessionID, args.intentRevision)
          const handle = await registry.start({
            directory: context.directory,
            sessionId: context.sessionID,
            goal: intent.goal,
            intent,
            client,
            authorizeSession,
            policy: {
              ...quack.balance,
              maxDepth: args.maxDepth ?? quack.limits.maxDepth,
              maxNodes: args.maxNodes ?? quack.limits.maxNodes,
              maxNeedsNurseBounces: quack.limits.maxNeedsNurseBounces,
            },
            cache: {
              enabled: quack.cache.mode === "auto",
              minFanout: quack.cache.minFanout,
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
          const handle = registry.resolve(args.runId, context.sessionID)
          return {
            title: `Quackery ${handle.id}`,
            output: handle.graph.render(),
            metadata: { runId: handle.id, status: handle.graph.snapshot.status },
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

      quackery_wait: tool({
        description: "Wait briefly for a Quackery run and then return its text graph.",
        args: {
          runId: tool.schema.string().optional(),
          timeoutSeconds: tool.schema.number().int().min(1).max(60).default(30),
        },
        async execute(args, context) {
          const handle = registry.resolve(args.runId, context.sessionID)
          await Promise.race([
            handle.promise,
            new Promise((resolveWait) => setTimeout(resolveWait, args.timeoutSeconds * 1_000)),
          ])
          return {
            title: `Quackery ${handle.id}`,
            output: handle.graph.render(),
            metadata: { runId: handle.id, status: handle.graph.snapshot.status },
          }
        },
      }),

      quackery_apply: tool({
        description: "Apply a verified root result commit to the unchanged invocation branch after approval.",
        args: { runId: tool.schema.string().optional() },
        async execute(args, context) {
          const handle = registry.resolve(args.runId, context.sessionID)
          const result = await handle.promise
          if (!result.ok) throw new Error(`Run failed: ${result.reason}`)
          await context.ask({
            permission: "quackery_apply",
            patterns: [result.headCommit],
            always: [],
            metadata: { runId: handle.id, commit: result.headCommit },
          })
          await handle.git.applyResult(handle.invocationBase, result.headCommit)
          return `Applied verified result ${result.headCommit} to the invocation branch.`
        },
      }),
    },
  }
}
