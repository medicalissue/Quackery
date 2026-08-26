import type { GraphNodeState, NodeContext, NodeStatus, RunSnapshot } from "./model.js"

export class RunGraph {
  readonly snapshot: RunSnapshot
  private readonly listeners = new Set<(snapshot: RunSnapshot) => void>()

  constructor(input: { id: string; repository: string; root: NodeContext; invocationBase: string }) {
    const now = Date.now()
    this.snapshot = {
      id: input.id,
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
    }
    this.snapshot.nodes.push(state)
    this.changed()
  }

  transition(id: string, status: NodeStatus, patch: Partial<GraphNodeState> = {}): void {
    const state = this.snapshot.nodes.find((node) => node.id === id)
    if (!state) throw new Error(`Unknown graph node ${id}`)
    Object.assign(state, patch, { status })
    if (!state.startedAt && status !== "pending") state.startedAt = Date.now()
    if (["verified", "failed", "refused"].includes(status)) state.completedAt = Date.now()
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

  render(): string {
    const children = new Map<string, GraphNodeState[]>()
    for (const node of this.snapshot.nodes) {
      if (!node.parentId) continue
      const siblings = children.get(node.parentId) ?? []
      siblings.push(node)
      children.set(node.parentId, siblings)
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.id.localeCompare(b.id))

    const root = this.snapshot.nodes.find((node) => node.id === this.snapshot.rootNodeId)
    if (!root) return `${this.snapshot.id} · ${this.snapshot.status}`
    const lines = [`${root.scope} · ${this.snapshot.status}`, ""]
    const renderNode = (node: GraphNodeState, prefix: string, last: boolean): void => {
      const connector = last ? "└─" : "├─"
      const commit = node.headCommit ? ` · ${node.headCommit.slice(0, 7)}` : ""
      const failure = node.failure ? ` · ${node.failure}` : ""
      lines.push(`${prefix}${connector} ${node.role} · ${node.scope} · ${node.status}${commit}${failure}`)
      const nested = children.get(node.id) ?? []
      nested.forEach((child, index) => renderNode(child, `${prefix}${last ? "   " : "│  "}`, index === nested.length - 1))
    }
    const first = children.get(root.id) ?? []
    first.forEach((node, index) => renderNode(node, "", index === first.length - 1))
    const counts = new Map<NodeStatus, number>()
    for (const node of this.snapshot.nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1)
    lines.push("", [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · "))
    return lines.join("\n")
  }

  private changed(): void {
    this.snapshot.updatedAt = Date.now()
    for (const listener of this.listeners) listener(this.snapshot)
  }
}
