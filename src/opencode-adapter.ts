import { access } from "node:fs/promises"
import { z } from "zod"
import type { DecompositionDecision, NodeContext, NodePlan, NodeResult, NodeSuccess, SplitDecision } from "./model.js"
import { decompositionDecisionSchema } from "./model.js"
import type { ExecutionAdapter } from "./runtime.js"
import { GitWorkspaceManager } from "./git.js"
import { assertNodeWorldMatchesWit, resolveRepositoryPath } from "./validation.js"
import { decompositionPrompt, implementationPrompt, integrationPrompt } from "./prompts.js"

const implementationResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("implemented"), summary: z.string() }),
  z.object({ kind: z.literal("needs-nurse"), reason: z.string() }),
  z.object({ kind: z.literal("contract-failure"), reason: z.string() }),
])

type Client = {
  session: {
    create(input: unknown): Promise<unknown>
    prompt(input: unknown): Promise<unknown>
  }
}

function dataOf(value: unknown): any {
  if (value && typeof value === "object" && "data" in value) return (value as { data: unknown }).data
  return value
}

function responseText(value: unknown): string {
  const data = dataOf(value)
  const parts = data?.parts ?? data?.info?.parts ?? []
  return parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
}

export function parseJsonResponse(value: unknown): unknown {
  const text = typeof value === "string" ? value : responseText(value)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  if (!candidate) throw new Error(`Agent did not return JSON: ${text.slice(-1_000)}`)
  try {
    return JSON.parse(candidate)
  } catch (error) {
    throw new Error(`Agent returned invalid JSON: ${candidate.slice(0, 1_000)}`, { cause: error })
  }
}

export interface OpenCodeAdapterOptions {
  client: Client
  git: GitWorkspaceManager
  parentSessionId: string
  authorizeSession(sessionId: string, node: NodeContext): void
}

export class OpenCodeExecutionAdapter implements ExecutionAdapter {
  private readonly decompositionSessions = new Map<string, string>()

  constructor(private readonly options: OpenCodeAdapterOptions) {}

  async decompose(node: NodeContext): Promise<DecompositionDecision> {
    const agent = node.depth === 0 ? "pharmacist" : "nurse"
    const sessionId = await this.createSession(node, agent, `${agent} · ${node.scope}`)
    this.decompositionSessions.set(node.id, sessionId)
    const response = await this.prompt(sessionId, node.worktree, agent, decompositionPrompt(node))
    return decompositionDecisionSchema.parse(parseJsonResponse(response))
  }

  async commitBoundary(node: NodeContext, decision: DecompositionDecision): Promise<string> {
    const plans = decision.kind === "leaf"
      ? [decision.leaf]
      : decision.kind === "split"
        ? [...decision.children, ...(decision.join.integration ? [decision.join.integration] : [])]
        : []
    for (const plan of plans) {
      await assertNodeWorldMatchesWit(node.worktree, plan)
      await access(resolveRepositoryPath(node.worktree, plan.world.behaviorPath))
    }
    const commit = await this.options.git.commitAll(node.id, `quackery(${node.id}): freeze abstract worlds`)
    if (node.plan) await this.options.git.assertOwned(node.id, node.baseCommit, node.plan.owns, commit)
    return commit
  }

  async forkChild(parent: NodeContext, boundaryCommit: string, plan: NodePlan): Promise<NodeContext> {
    const id = `${parent.id}/${plan.id}`
    const record = await this.options.git.create(id, boundaryCommit)
    return {
      id,
      parentId: parent.id,
      depth: parent.depth + 1,
      role: plan.kind === "leaf" ? "surgeon" : "nurse",
      scope: plan.scope,
      plan,
      worktree: record.path,
      baseCommit: boundaryCommit,
    }
  }

  async runLeaf(node: NodeContext): Promise<NodeResult> {
    if (!node.plan) throw new Error(`Leaf ${node.id} has no plan`)
    await assertNodeWorldMatchesWit(node.worktree, node.plan)
    await access(resolveRepositoryPath(node.worktree, node.plan.world.behaviorPath))

    const sessionId = await this.createSession(node, "surgeon", `surgeon · ${node.scope}`)
    const response = await this.prompt(sessionId, node.worktree, "surgeon", implementationPrompt(node))
    const agentResult = implementationResponseSchema.parse(parseJsonResponse(response))
    if (agentResult.kind !== "implemented") {
      return {
        ok: false,
        nodeId: node.id,
        reason: agentResult.kind === "needs-nurse" ? "NEEDS_NURSE" : "CONTRACT_FAILURE",
        detail: agentResult.reason,
        actualDepth: 0,
      }
    }

    const evidence = await this.options.git.verify(node.id, node.plan.verify)
    const committedHead = await this.options.git.commitAll(node.id, `quackery(${node.id}): fill implementation hole`)
    const normalized = await this.options.git.normalizedResultCommit(
      node.id,
      node.baseCommit,
      `quackery(${node.id}): verified node result`,
    )
    let changedPaths: string[]
    try {
      changedPaths = await this.options.git.assertOwned(node.id, node.baseCommit, node.plan.owns, normalized)
    } catch (error) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "OWNERSHIP_VIOLATION",
        detail: error instanceof Error ? error.message : String(error),
        recoverableCommit: committedHead,
        actualDepth: 0,
      }
    }
    const failedEvidence = evidence.find((item) => item.exitCode !== 0)
    if (failedEvidence) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "VERIFICATION_FAILED",
        detail: `${failedEvidence.command} exited with ${failedEvidence.exitCode}`,
        recoverableCommit: committedHead,
        actualDepth: 0,
      }
    }
    return {
      ok: true,
      nodeId: node.id,
      baseCommit: node.baseCommit,
      headCommit: normalized,
      changedPaths,
      evidence,
      actualDepth: 0,
    }
  }

  async join(
    node: NodeContext,
    boundaryCommit: string,
    children: NodeSuccess[],
    decision: SplitDecision,
  ): Promise<NodeResult> {
    await this.options.git.cherryPick(node.id, children.map((child) => child.headCommit))
    const integrationBase = await this.options.git.head(node.id)

    const integration = decision.join.integration
    if (integration) {
      const integrationContext: NodeContext = {
        id: `${node.id}/integration`,
        parentId: node.id,
        depth: node.depth + 1,
        role: "integration-surgeon",
        scope: integration.scope,
        plan: integration,
        worktree: node.worktree,
        baseCommit: integrationBase,
      }
      const sessionId = await this.createSession(integrationContext, "surgeon", `integration surgeon · ${node.scope}`)
      const response = await this.prompt(
        sessionId,
        node.worktree,
        "surgeon",
        integrationPrompt(node, decision, children.map((child) => child.headCommit)),
      )
      const agentResult = implementationResponseSchema.parse(parseJsonResponse(response))
      if (agentResult.kind !== "implemented") {
        return {
          ok: false,
          nodeId: node.id,
          reason: agentResult.kind === "needs-nurse" ? "INTEGRATION_NEEDS_NURSE" : "INTEGRATION_CONTRACT_FAILURE",
          detail: agentResult.reason,
          actualDepth: 0,
        }
      }
    }

    const evidence = await this.options.git.verify(node.id, [
      ...(integration?.verify ?? []),
      ...decision.join.verify,
    ])
    const committedHead = await this.options.git.commitAll(node.id, `quackery(${node.id}): recursive join`)
    if (integration) {
      try {
        await this.options.git.assertOwned(node.id, integrationBase, integration.owns, committedHead)
      } catch (error) {
        return {
          ok: false,
          nodeId: node.id,
          reason: "INTEGRATION_OWNERSHIP_VIOLATION",
          detail: error instanceof Error ? error.message : String(error),
          recoverableCommit: committedHead,
          actualDepth: 0,
        }
      }
    } else {
      const verificationMutations = await this.options.git.changedPaths(node.id, integrationBase, committedHead)
      if (verificationMutations.length > 0) {
        return {
          ok: false,
          nodeId: node.id,
          reason: "JOIN_VERIFICATION_MUTATION",
          detail: `Verification changed tracked paths: ${verificationMutations.join(", ")}`,
          recoverableCommit: committedHead,
          actualDepth: 0,
        }
      }
    }
    const failedEvidence = evidence.find((item) => item.exitCode !== 0)
    if (failedEvidence) {
      return {
        ok: false,
        nodeId: node.id,
        reason: "JOIN_VERIFICATION_FAILED",
        detail: `${failedEvidence.command} exited with ${failedEvidence.exitCode}`,
        recoverableCommit: committedHead,
        actualDepth: 0,
      }
    }
    const normalized = await this.options.git.normalizedResultCommit(
      node.id,
      node.baseCommit,
      `quackery(${node.id}): verified subtree result`,
    )
    const changedPaths = await this.options.git.changedPaths(node.id, node.baseCommit, normalized)
    return {
      ok: true,
      nodeId: node.id,
      baseCommit: node.baseCommit,
      headCommit: normalized,
      changedPaths,
      evidence: [...children.flatMap((child) => child.evidence), ...evidence],
      actualDepth: 0,
    }
  }

  private async createSession(node: NodeContext, agent: string, title: string): Promise<string> {
    // A Surgeon spawned after this node's Nurse must be a child of that Nurse.
    // A direct leaf has no local decomposition session, so it remains a child
    // of the parent node's decomposer (or the user's originating session).
    const parentID =
      this.decompositionSessions.get(node.id) ??
      (node.parentId
        ? this.decompositionSessions.get(node.parentId) ?? this.options.parentSessionId
        : this.options.parentSessionId)
    const response = await this.options.client.session.create({
      query: { directory: node.worktree },
      body: { parentID, title },
    })
    const data = dataOf(response)
    const sessionId = data?.id
    if (typeof sessionId !== "string") throw new Error(`OpenCode did not return a session id for ${node.id}`)
    this.options.authorizeSession(sessionId, node)
    return sessionId
  }

  private prompt(sessionId: string, directory: string, agent: string, text: string): Promise<unknown> {
    return this.options.client.session.prompt({
      path: { id: sessionId },
      query: { directory },
      body: {
        agent,
        parts: [{ type: "text", text }],
      },
    })
  }
}
