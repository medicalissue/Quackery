import { relative, resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { NodeContext } from "./model.js"
import { pharmacistPrompt, psychiatristPrompt, nursePrompt, surgeonPrompt } from "./prompts.js"
import { RunRegistry } from "./registry.js"
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

function agentConfiguration(config: any): void {
  config.agent ??= {}
  config.agent.psychiatrist = {
    description: "Clarifies user intent and produces a confirmed Intent Contract without implementation",
    mode: "primary",
    prompt: psychiatristPrompt,
    permission: {
      edit: "deny",
      task: "deny",
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
  }
  config.agent.pharmacist = {
    description: "Starts and reports Quackery's Git-native recursive parallel implementation runtime",
    mode: "primary",
    prompt: pharmacistPrompt,
    permission: {
      edit: "deny",
      bash: "deny",
      task: "deny",
      "quackery_*": "allow",
    },
  }
  config.agent.nurse = {
    description: "Internal recursive decomposer that creates balanced immediate WIT worlds",
    mode: "subagent",
    hidden: true,
    prompt: nursePrompt,
    permission: {
      edit: "allow",
      bash: "allow",
      task: "deny",
    },
  }
  config.agent.surgeon = {
    description: "Internal cheap implementer that fills one WIT export hole",
    mode: "subagent",
    hidden: true,
    prompt: surgeonPrompt,
    permission: {
      edit: "allow",
      bash: "allow",
      task: "deny",
    },
  }
}

export const QuackeryPlugin: Plugin = async ({ client }) => {
  const registry = new RunRegistry()
  const authorizedSessions = new Map<string, NodeContext>()

  const authorizeSession = (sessionId: string, node: NodeContext): void => {
    authorizedSessions.set(sessionId, node)
  }

  return {
    config: async (config) => agentConfiguration(config),

    "chat.message": async (input) => {
      if ((input.agent === "nurse" || input.agent === "surgeon") && !authorizedSessions.has(input.sessionID)) {
        throw new Error(`${input.agent} is internal to the Quackery runtime and cannot be invoked directly`)
      }
    },

    "tool.execute.before": async (input, output) => {
      const node = authorizedSessions.get(input.sessionID)
      if (!node?.plan || !["write", "edit", "apply_patch"].includes(input.tool)) return
      const paths = toolPaths(input.tool, output.args as Record<string, unknown>)
      if (paths.length === 0) throw new Error(`Cannot resolve target paths for ${input.tool}`)
      for (const path of paths) {
        const candidate = repositoryRelativePath(node, path)
        if (!node.plan.owns.some((rule) => ownershipContains(rule, candidate))) {
          throw new Error(`Node ${node.id} does not own ${candidate}`)
        }
      }
    },

    tool: {
      quackery_start: tool({
        description: "Start a background Quackery run. Pharmacist calls this once after intent is fixed.",
        args: {
          goal: tool.schema.string().min(1),
          maxDepth: tool.schema.number().int().min(1).max(12).optional(),
          maxNodes: tool.schema.number().int().min(1).max(128).optional(),
        },
        async execute(args, context) {
          if (context.agent !== "pharmacist") throw new Error("Only Pharmacist can start Quackery")
          const handle = await registry.start({
            directory: context.directory,
            sessionId: context.sessionID,
            goal: args.goal,
            client,
            authorizeSession,
            policy: {
              ...(args.maxDepth ? { maxDepth: args.maxDepth } : {}),
              ...(args.maxNodes ? { maxNodes: args.maxNodes } : {}),
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
