import type { GraphNodeState, NodeContext, NodeStatus, RunSnapshot } from "./model.js"

export class RunGraph {
  readonly snapshot: RunSnapshot
  private readonly listeners = new Set<(snapshot: RunSnapshot) => void>()

  constructor(input: { id: string; sessionId?: string; repository: string; root: NodeContext; invocationBase: string }) {
    const now = Date.now()
    this.snapshot = {
      id: input.id,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      repository: input.repository,
      rootNodeId: input.root.id,
      invocationBase: input.invocationBase,
      status: "running",
      nodes: [],
      createdAt: now,
      updatedAt: now,
    }
    this.add(input.root)
  }

  onChange(listener: (snapshot: RunSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  add(context: NodeContext): void {
    if (this.snapshot.nodes.some((node) => node.id === context.id)) return
    const state: GraphNodeState = {
      id: context.id,
      role: context.role,
      scope: context.scope,
      status: "pending",
      depth: context.depth,
      baseCommit: context.baseCommit,
      ...(context.parentId ? { parentId: context.parentId } : {}),
      ...(context.plan ? {
        estimatedRemainingDepth: context.plan.estimatedRemainingDepth,
        estimatedWork: context.plan.estimatedWork,
      } : {}),
      ...(context.cache ? { cacheGroup: context.cache.group } : {}),
    }
    this.snapshot.nodes.push(state)
    this.changed()
  }

  transition(id: string, status: NodeStatus, patch: Partial<GraphNodeState> = {}): void {
    const state = this.snapshot.nodes.find((node) => node.id === id)
    if (!state) throw new Error(`Unknown graph node ${id}`)
    Object.assign(state, patch, { status })
    if (!state.startedAt && status !== "pending") state.startedAt = Date.now()
    if (["verified", "failed", "refused", "canceled"].includes(status)) state.completedAt = Date.now()
    this.changed()
  }

  finish(resultCommit: string): void {
    this.snapshot.status = "verified"
    this.snapshot.resultCommit = resultCommit
    this.changed()
  }

  fail(): void {
    this.snapshot.status = "failed"
    this.changed()
  }

  cancel(reason: string): void {
    this.snapshot.status = "canceled"
    for (const node of this.snapshot.nodes) {
      if (["pending", "decomposing", "boundary", "implementing", "joining"].includes(node.status)) {
        node.status = "canceled"
        node.failure = reason
        node.completedAt = Date.now()
      }
    }
    this.changed()
  }

  abandon(cleanup: NonNullable<RunSnapshot["cleanup"]>): void {
    this.snapshot.status = "abandoned"
    this.snapshot.cleanup = cleanup
    this.changed()
  }

  applied(appliedCommit: string, cleanup: NonNullable<RunSnapshot["cleanup"]>): void {
    this.snapshot.status = "applied"
    this.snapshot.appliedCommit = appliedCommit
    this.snapshot.cleanup = cleanup
    this.changed()
  }

  render(): string {
    return renderRunSnapshot(this.snapshot)
  }

  private changed(): void {
    this.snapshot.updatedAt = Date.now()
    for (const listener of this.listeners) listener(this.snapshot)
  }
}

export function renderRunSnapshot(snapshot: RunSnapshot): string {
    const children = new Map<string, GraphNodeState[]>()
    for (const node of snapshot.nodes) {
      if (!node.parentId) continue
      const siblings = children.get(node.parentId) ?? []
      siblings.push(node)
      children.set(node.parentId, siblings)
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.id.localeCompare(b.id))

    const root = snapshot.nodes.find((node) => node.id === snapshot.rootNodeId)
    if (!root) return `${snapshot.id} · ${snapshot.status}`
    const lines = [`${root.scope} · ${snapshot.status}`, ""]
    const renderNode = (node: GraphNodeState, prefix: string, last: boolean): void => {
      const connector = last ? "└─" : "├─"
      const commit = node.headCommit ? ` · ${node.headCommit.slice(0, 7)}` : ""
      const failure = node.failure ? ` · ${node.failure}` : ""
      const recoverable = node.recoverableCommit ? ` · recoverable ${node.recoverableCommit.slice(0, 7)}` : ""
      const cache = node.cacheGroup
        ? node.usage
          ? ` · cache ${node.usage.cacheRead}r/${node.usage.cacheWrite}w`
          : " · cache eligible"
        : ""
      const attempts = node.attempts && node.attempts > 1 ? ` · ${node.attempts} attempts` : ""
      const depth = node.actualDepth === undefined ? "" : ` · depth ${node.actualDepth}`
      const evidence = node.evidence?.length ? ` · ${node.evidence.length} checks` : ""
      lines.push(`${prefix}${connector} ${node.role} · ${node.scope} · ${node.status}${commit}${recoverable}${attempts}${depth}${evidence}${cache}${failure}`)
      const nested = children.get(node.id) ?? []
      nested.forEach((child, index) => renderNode(child, `${prefix}${last ? "   " : "│  "}`, index === nested.length - 1))
    }
    const first = children.get(root.id) ?? []
    first.forEach((node, index) => renderNode(node, "", index === first.length - 1))
    const counts = new Map<NodeStatus, number>()
    for (const node of snapshot.nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1)
    lines.push("", [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · "))
    const usage = snapshot.nodes.reduce(
      (total, node) => ({
        input: total.input + (node.usage?.input ?? 0),
        output: total.output + (node.usage?.output ?? 0),
        reasoning: total.reasoning + (node.usage?.reasoning ?? 0),
        cacheRead: total.cacheRead + (node.usage?.cacheRead ?? 0),
        cacheWrite: total.cacheWrite + (node.usage?.cacheWrite ?? 0),
        cost: total.cost + (node.usage?.cost ?? 0),
      }),
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    )
    if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost) {
      lines.push(
        `tokens ${usage.input} in · ${usage.output} out · ${usage.reasoning} reasoning · cache ${usage.cacheRead} read/${usage.cacheWrite} write · cost $${usage.cost.toFixed(4)}`,
      )
    }
    if (snapshot.resultCommit) lines.push(`result ${snapshot.resultCommit}`)
    if (snapshot.appliedCommit) lines.push(`applied ${snapshot.appliedCommit}`)
    if (snapshot.cleanup?.failures.length) lines.push(`cleanup warning · ${snapshot.cleanup.failures.join(" · ")}`)
    return lines.join("\n")
}

export function renderRunEvidence(snapshot: RunSnapshot, nodeId?: string): string {
  const nodes = snapshot.nodes.filter((node) => !nodeId || node.id === nodeId)
  if (nodeId && nodes.length === 0) throw new Error(`Unknown graph node ${nodeId}`)
  const lines = [`${snapshot.id} · ${snapshot.status} · evidence`, ""]
  for (const node of nodes) {
    if (!node.evidence?.length && !node.usage) continue
    lines.push(`${node.id} · ${node.role} · ${node.status} · attempts ${node.attempts ?? 1} · depth ${node.actualDepth ?? "unknown"}`)
    if (node.usage) {
      lines.push(
        `usage ${node.usage.input} in/${node.usage.output} out/${node.usage.reasoning} reasoning · cache ${node.usage.cacheRead} read/${node.usage.cacheWrite} write · $${node.usage.cost.toFixed(4)}`,
      )
    }
    for (const item of node.evidence ?? []) {
      lines.push(`  [${item.exitCode}] ${item.command} · source ${item.source ?? "unknown"}`)
      if (item.output) lines.push(item.output.slice(-4_000))
    }
    lines.push("")
  }
  if (lines.length === 2) lines.push("No command or verification evidence has been recorded.")
  return lines.join("\n").trimEnd()
}
