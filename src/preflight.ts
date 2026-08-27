import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { resolve } from "node:path"
import type { ModelRole, QuackConfig, ResolvedRoleModel } from "./config.js"
import { assertCleanRepository, git, repositoryRoot } from "./git.js"

export type PreflightStatus = "PASS" | "WARN" | "UNKNOWN" | "FAIL"

export interface PreflightCheck {
  name: string
  status: PreflightStatus
  detail: string
}

export interface PreflightReport {
  ready: boolean
  checks: PreflightCheck[]
}

const roles: ModelRole[] = ["psychiatrist", "pharmacist", "nurse", "surgeon"]

export async function runPreflight(
  directory: string,
  config: QuackConfig,
  routing: Record<ModelRole, ResolvedRoleModel>,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = []
  let repository: string | undefined
  try {
    repository = await repositoryRoot(directory)
    checks.push({ name: "git repository", status: "PASS", detail: repository })
  } catch (error) {
    checks.push({ name: "git repository", status: "FAIL", detail: message(error) })
  }

  if (repository) {
    try {
      await assertCleanRepository(repository)
      checks.push({ name: "invocation worktree", status: "PASS", detail: "clean" })
    } catch (error) {
      checks.push({ name: "invocation worktree", status: "FAIL", detail: message(error) })
    }
    try {
      const common = await git(repository, ["rev-parse", "--git-common-dir"])
      await access(resolve(repository, common), constants.R_OK | constants.W_OK)
      checks.push({ name: "Git metadata", status: "PASS", detail: "run state is writable" })
    } catch (error) {
      checks.push({ name: "Git metadata", status: "FAIL", detail: message(error) })
    }
    try {
      checks.push({ name: "Git executable", status: "PASS", detail: await git(repository, ["--version"]) })
    } catch (error) {
      checks.push({ name: "Git executable", status: "FAIL", detail: message(error) })
    }
  }

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10)
  checks.push({
    name: "Node runtime",
    status: nodeMajor >= 20 ? "PASS" : "FAIL",
    detail: `v${process.versions.node}; requires >=20`,
  })
  checks.push({
    name: "Quackery policy",
    status: "PASS",
    detail: `profile ${config.profile}; depth ${config.limits.maxDepth}; nodes ${config.limits.maxNodes}; concurrency ${config.limits.maxConcurrency}; observed cost ${config.limits.maxObservedCost || "unbounded"}; run ${config.limits.maxRunSeconds}s; prompt ${config.limits.maxPromptSeconds}s`,
  })
  for (const role of roles) {
    const target = routing[role]
    checks.push({
      name: `${role} model`,
      status: target.model ? "PASS" : "WARN",
      detail: target.model
        ? `${target.model}${target.variant ? ` #${target.variant}` : ""} via ${target.source}`
        : `inherits the OpenCode current model at ${target.tier} tier`,
    })
  }
  checks.push({
    name: "live provider protocol",
    status: "UNKNOWN",
    detail: "run quackery_doctor with live=true to measure",
  })
  checks.push({
    name: "provider cache",
    status: "UNKNOWN",
    detail: "requires a live same-boundary fan-out run",
  })
  return { ready: !checks.some((check) => check.status === "FAIL"), checks }
}

export function renderPreflight(report: PreflightReport): string {
  const livePassed = report.checks.some((check) => check.name === "live provider protocol" && check.status === "PASS")
  return [
    report.ready
      ? livePassed ? "READY (live provider protocol passed; cache not measured)" : "READY (provider execution not measured)"
      : "NOT READY",
    "",
    ...report.checks.map((check) => `${check.status.padEnd(7)} ${check.name} · ${check.detail}`),
  ].join("\n")
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
