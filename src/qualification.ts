import type { RunSnapshot } from "./model.js"

export interface QualificationCheck {
  name: string
  status: "PASS" | "FAIL"
  detail: string
}

export interface SelfHostQualification {
  passed: boolean
  runId: string
  resultCommit?: string
  changedPaths: string[]
  checks: QualificationCheck[]
}

export function evaluateSelfHostQualification(
  snapshot: RunSnapshot,
  changedPaths: string[],
  resultCommitCount: number,
): SelfHostQualification {
  const evidence = (snapshot.nodes.find((node) => node.id === snapshot.rootNodeId)?.evidence ?? [])
    .filter((item) => item.source === "runtime-join")
  const workerUsage = snapshot.nodes
    .filter((node) => node.role === "nurse" || node.role === "surgeon")
    .reduce((total, node) => total + (node.usage?.input ?? 0) + (node.usage?.output ?? 0), 0)
  const commands = new Map(evidence.map((item) => [item.command.trim(), item]))
  const terminalNodes = snapshot.nodes.filter((node) => node.id !== snapshot.rootNodeId)
  const checks: QualificationCheck[] = [
    check("verified run", snapshot.status === "verified" || snapshot.status === "applied", `status ${snapshot.status}`),
    check("result commit", Boolean(snapshot.resultCommit), snapshot.resultCommit ?? "missing"),
    check("normalized result", resultCommitCount === 1, `${resultCommitCount} commits from invocation base`),
    check("source change", changedPaths.some((path) => path.startsWith("src/")), pathDetail(changedPaths, "src/")),
    check("regression test", changedPaths.some((path) => path.startsWith("tests/") && /\.test\.[cm]?[jt]sx?$/.test(path)), pathDetail(changedPaths, "tests/")),
    check(
      "product-only diff",
      !changedPaths.some((path) => path.startsWith(".quack/contracts/")),
      "no .quack/contracts paths",
    ),
    check(
      "recursive roles",
      snapshot.nodes.some((node) => node.role === "nurse") && snapshot.nodes.some((node) => node.role === "surgeon"),
      "Nurse and Surgeon nodes both recorded",
    ),
    check(
      "verified graph",
      terminalNodes.length > 0 && terminalNodes.every((node) => node.status === "verified"),
      `${terminalNodes.filter((node) => node.status === "verified").length}/${terminalNodes.length} non-root nodes verified`,
    ),
    check("live provider telemetry", workerUsage > 0, `${workerUsage} worker input/output tokens`),
    commandCheck(commands, "bun run verify", "full verification"),
    commandCheck(commands, "npm pack --dry-run", "package inspection"),
  ]
  return {
    passed: checks.every((item) => item.status === "PASS"),
    runId: snapshot.id,
    ...(snapshot.resultCommit ? { resultCommit: snapshot.resultCommit } : {}),
    changedPaths,
    checks,
  }
}

export function renderSelfHostQualification(qualification: SelfHostQualification): string {
  return [
    qualification.passed ? "QUALIFIED" : "NOT QUALIFIED",
    `run ${qualification.runId}`,
    ...(qualification.resultCommit ? [`result ${qualification.resultCommit}`] : []),
    "",
    ...qualification.checks.map((item) => `${item.status.padEnd(4)} ${item.name} · ${item.detail}`),
    "",
    `changed ${qualification.changedPaths.length} paths`,
  ].join("\n")
}

function check(name: string, passed: boolean, detail: string): QualificationCheck {
  return { name, status: passed ? "PASS" : "FAIL", detail }
}

function commandCheck(
  commands: Map<string, { exitCode: number }>,
  command: string,
  name: string,
): QualificationCheck {
  const evidence = commands.get(command)
  return check(name, evidence?.exitCode === 0, evidence ? `${command} exited ${evidence.exitCode}` : `${command} not recorded`)
}

function pathDetail(paths: string[], prefix: string): string {
  const matched = paths.filter((path) => path.startsWith(prefix))
  return matched.length ? matched.join(", ") : `no ${prefix} path changed`
}
