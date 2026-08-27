import { readFile } from "node:fs/promises"
import { isAbsolute, posix, relative, resolve } from "node:path"
import { types as generateWitTypes } from "@bytecodealliance/jco"
import * as ts from "typescript"
import type { NodePlan, OwnershipRule, SplitDecision } from "./model.js"

export interface BalancePolicy {
  maxDepthSkew: number
  maxWorkRatio: number
  allowJustifiedImbalance: boolean
}

export interface SplitMetrics {
  depthSkew: number
  workRatio: number
}

export class ContractValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "ContractValidationError"
  }
}

export function normalizeOwnedPath(value: string): string {
  if (isAbsolute(value)) {
    throw new ContractValidationError(`Ownership path must be repository-relative: ${value}`, "absolute-ownership")
  }
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "")
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ContractValidationError(`Ownership path escapes the repository: ${value}`, "escaping-ownership")
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    throw new ContractValidationError(`Git metadata cannot be owned by a node: ${value}`, "git-ownership")
  }
  return normalized
}

export function resolveRepositoryPath(worktree: string, value: string): string {
  return resolve(worktree, normalizeOwnedPath(value))
}

export function ownershipContains(rule: OwnershipRule, candidate: string): boolean {
  const owned = normalizeOwnedPath(rule.path)
  const path = normalizeOwnedPath(candidate)
  return rule.mode === "exact" ? path === owned : path === owned || path.startsWith(`${owned}/`)
}

function rulesOverlap(left: OwnershipRule, right: OwnershipRule): boolean {
  const a = normalizeOwnedPath(left.path)
  const b = normalizeOwnedPath(right.path)
  if (left.mode === "exact" && right.mode === "exact") return a === b
  if (left.mode === "prefix" && right.mode === "prefix") {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  }
  const prefix = left.mode === "prefix" ? a : b
  const exact = left.mode === "exact" ? a : b
  return exact === prefix || exact.startsWith(`${prefix}/`)
}

function ruleContains(parent: OwnershipRule, child: OwnershipRule): boolean {
  const parentPath = normalizeOwnedPath(parent.path)
  const childPath = normalizeOwnedPath(child.path)
  if (parent.mode === "exact") return child.mode === "exact" && parentPath === childPath
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`)
}

export function assertOwnershipWithinParent(parent: OwnershipRule[], child: OwnershipRule[], childId: string): void {
  for (const rule of child) {
    if (!parent.some((candidate) => ruleContains(candidate, rule))) {
      throw new ContractValidationError(
        `Child ${childId} ownership ${rule.path} escapes its parent reservation`,
        "ownership-escape",
      )
    }
  }
}

export function assertDisjointOwnership(children: NodePlan[], joinRules: OwnershipRule[] = []): void {
  for (let leftIndex = 0; leftIndex < children.length; leftIndex += 1) {
    const left = children[leftIndex]
    if (!left) continue
    for (let rightIndex = leftIndex + 1; rightIndex < children.length; rightIndex += 1) {
      const right = children[rightIndex]
      if (!right) continue
      for (const a of left.owns) {
        for (const b of right.owns) {
          if (rulesOverlap(a, b)) {
            throw new ContractValidationError(
              `Ownership overlaps between ${left.id}:${a.path} and ${right.id}:${b.path}`,
              "ownership-overlap",
            )
          }
        }
      }
    }
    for (const childRule of left.owns) {
      for (const joinRule of joinRules) {
        if (rulesOverlap(childRule, joinRule)) {
          throw new ContractValidationError(
            `Join ownership ${joinRule.path} overlaps child ${left.id}:${childRule.path}`,
            "join-ownership-overlap",
          )
        }
      }
    }
  }
}

export function splitMetrics(children: NodePlan[]): SplitMetrics {
  const depths = children.map((child) => child.estimatedRemainingDepth)
  const works = children.map((child) => child.estimatedWork)
  const minWork = Math.min(...works)
  return {
    depthSkew: Math.max(...depths) - Math.min(...depths),
    workRatio: minWork === 0 ? Number.POSITIVE_INFINITY : Math.max(...works) / minWork,
  }
}

export function assertBalancedSplit(decision: SplitDecision, policy: BalancePolicy): SplitMetrics {
  const metrics = splitMetrics(decision.children)
  const violates = metrics.depthSkew > policy.maxDepthSkew || metrics.workRatio > policy.maxWorkRatio
  if (violates && !(policy.allowJustifiedImbalance && decision.imbalanceJustification)) {
    throw new ContractValidationError(
      `Unbalanced split: depth skew ${metrics.depthSkew}, work ratio ${metrics.workRatio.toFixed(2)}`,
      "unbalanced-split",
    )
  }
  return metrics
}

export function assertWorldWiring(parent: NodePlan | undefined, children: NodePlan[]): void {
  const exportedBy = new Map<string, string>()
  for (const child of children) {
    const exported = child.exports[0]
    if (!exported) {
      throw new ContractValidationError(`Child ${child.id} must export exactly one interface`, "missing-export")
    }
    const previous = exportedBy.get(exported)
    if (previous) {
      throw new ContractValidationError(
        `Interface ${exported} is exported by both ${previous} and ${child.id}`,
        "duplicate-export",
      )
    }
    exportedBy.set(exported, child.id)
  }

  const inherited = new Set(parent?.imports ?? [])
  for (const child of children) {
    for (const imported of child.imports) {
      if (!exportedBy.has(imported) && !inherited.has(imported)) {
        throw new ContractValidationError(
          `Child ${child.id} imports unresolved interface ${imported}`,
          "unresolved-import",
        )
      }
    }
  }
}

export function assertChangedPathsOwned(changedPaths: string[], owns: OwnershipRule[]): void {
  const unowned = changedPaths.filter((path) => !owns.some((rule) => ownershipContains(rule, path)))
  if (unowned.length > 0) {
    throw new ContractValidationError(`Node changed unowned paths: ${unowned.join(", ")}`, "unowned-write")
  }
}

export interface WitWorldShape {
  interfaces: Set<string>
  worlds: Map<string, { imports: string[]; exports: string[] }>
}

const behaviorHeadings = [
  "Responsibility",
  "Inputs",
  "Outputs",
  "Preconditions",
  "Postconditions",
  "Invariants",
  "Errors",
  "Effects",
  "Constraints",
  "Non-goals",
] as const

export async function assertBehaviorContract(worktree: string, plan: NodePlan): Promise<void> {
  const path = resolveRepositoryPath(worktree, plan.world.behaviorPath)
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    throw new ContractValidationError(
      `Behavior contract ${plan.world.behaviorPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      "missing-behavior",
    )
  }
  const missing = behaviorHeadings.filter((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return !new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").test(source)
  })
  if (missing.length > 0) {
    throw new ContractValidationError(
      `Behavior contract ${plan.world.behaviorPath} is missing headings: ${missing.join(", ")}`,
      "incomplete-behavior",
    )
  }
  const empty = behaviorHeadings.filter((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "im").exec(source)
    if (!match || match.index === undefined) return false
    const start = match.index + match[0].length
    const remainder = source.slice(start)
    const nextHeading = /^#{1,6}\s+/m.exec(remainder)
    return remainder.slice(0, nextHeading?.index ?? remainder.length).trim().length === 0
  })
  if (empty.length > 0) {
    throw new ContractValidationError(
      `Behavior contract ${plan.world.behaviorPath} has empty sections: ${empty.join(", ")}`,
      "incomplete-behavior",
    )
  }
}

async function readBoundaryAsset(worktree: string, path: string, label: string): Promise<string> {
  try {
    const source = await readFile(resolveRepositoryPath(worktree, path), "utf8")
    if (!source.trim()) throw new Error("file is empty")
    return source
  } catch (error) {
    throw new ContractValidationError(
      `${label} ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      "incomplete-world",
    )
  }
}

export async function assertBoundaryAssets(worktree: string, plan: NodePlan): Promise<void> {
  const projectionSource = await readBoundaryAsset(worktree, plan.world.projectionPath, "Projection")
  const expectedImports = [...plan.imports].sort()
  const stubImports = plan.world.stubs.map((stub) => stub.interface).sort()
  if (new Set(stubImports).size !== stubImports.length || JSON.stringify(stubImports) !== JSON.stringify(expectedImports)) {
    throw new ContractValidationError(
      `World ${plan.world.world} must provide exactly one stub for each import (${expectedImports.join(", ") || "none"})`,
      "incomplete-world",
    )
  }
  const stubSources = new Map(await Promise.all(plan.world.stubs.map(async (stub) => [
    stub.interface,
    await readBoundaryAsset(worktree, stub.path, `Stub for ${stub.interface}`),
  ] as const)))
  const typeScriptAssets = [...new Set([plan.world.projectionPath, ...plan.world.stubs.map((stub) => stub.path)])]
    .filter((path) => /\.[cm]?tsx?$/.test(path))
    .map((path) => resolveRepositoryPath(worktree, path))
  let typeScriptProgram: ts.Program | undefined
  if (typeScriptAssets.length > 0) {
    typeScriptProgram = ts.createProgram({
      rootNames: typeScriptAssets,
      options: {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: [],
      },
    })
    const errors = ts.getPreEmitDiagnostics(typeScriptProgram)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    if (errors.length > 0) {
      const detail = errors.slice(0, 5).map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
        if (!diagnostic.file || diagnostic.start === undefined) return message
        const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        return `${relative(worktree, diagnostic.file.fileName)}:${location.line + 1}:${location.character + 1} ${message}`
      }).join("; ")
      throw new ContractValidationError(`TypeScript boundary projection failed: ${detail}`, "invalid-projection")
    }
  }

  const bindingSource = await readBoundaryAsset(worktree, plan.world.bindingPath, "Binding")
  let binding: unknown
  try {
    binding = JSON.parse(bindingSource)
  } catch (error) {
    throw new ContractValidationError(
      `Binding ${plan.world.bindingPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      "invalid-binding",
    )
  }
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new ContractValidationError(`Binding ${plan.world.bindingPath} must be an object`, "invalid-binding")
  }
  const value = binding as Record<string, unknown>
  const exported = value.export
  const imports = value.imports
  const exportInterface = exported && typeof exported === "object" && !Array.isArray(exported)
    ? (exported as Record<string, unknown>).interface
    : undefined
  const exportSymbol = exported && typeof exported === "object" && !Array.isArray(exported)
    ? (exported as Record<string, unknown>).symbol
    : undefined
  const bindingImports = Array.isArray(imports)
    ? imports.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : undefined)
    : []
  const bindingImportNames = bindingImports.map((item) => item?.interface).filter((item): item is string => typeof item === "string").sort()
  const importsHaveSymbols = bindingImports.every((item) => typeof item?.symbol === "string" && item.symbol.length > 0)
  if (
    value.version !== 1
    || value.world !== plan.world.world
    || exportInterface !== plan.exports[0]
    || typeof exportSymbol !== "string"
    || exportSymbol.length === 0
    || !Array.isArray(imports)
    || bindingImportNames.length !== bindingImports.length
    || !importsHaveSymbols
    || JSON.stringify(bindingImportNames) !== JSON.stringify(expectedImports)
  ) {
    throw new ContractValidationError(
      `Binding ${plan.world.bindingPath} must declare version 1, world ${plan.world.world}, export ${plan.exports[0]}, and exact imports`,
      "invalid-binding",
    )
  }
  const declaresSymbol = (path: string, source: string, symbol: string): boolean => {
    if (typeScriptProgram && /\.[cm]?tsx?$/.test(path)) {
      const sourceFile = typeScriptProgram.getSourceFile(resolveRepositoryPath(worktree, path))
      const moduleSymbol = sourceFile ? typeScriptProgram.getTypeChecker().getSymbolAtLocation(sourceFile) : undefined
      return moduleSymbol
        ? typeScriptProgram.getTypeChecker().getExportsOfModule(moduleSymbol).some((item) => item.getName() === symbol)
        : false
    }
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:$|[^A-Za-z0-9_$])`, "m").test(source)
  }
  if (!declaresSymbol(plan.world.projectionPath, projectionSource, exportSymbol)) {
    throw new ContractValidationError(
      `Projection ${plan.world.projectionPath} does not declare bound export symbol ${exportSymbol}`,
      "invalid-binding",
    )
  }
  for (const imported of bindingImports) {
    const interfaceName = imported?.interface as string
    const symbol = imported?.symbol as string
    const source = stubSources.get(interfaceName)
    const stub = plan.world.stubs.find((item) => item.interface === interfaceName)
    if (!source || !stub || !declaresSymbol(stub.path, source, symbol)) {
      throw new ContractValidationError(
        `Stub for ${interfaceName} does not declare bound import symbol ${symbol}`,
        "invalid-binding",
      )
    }
  }
}

// Quackery v0.1 deliberately accepts the local-interface WIT profile only.
// jco is the canonical syntax/type authority; this extractor adds Quackery's
// stricter one-world/one-hole and exact import/export policy.
export function extractLocalWitWorlds(source: string): WitWorldShape {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  const interfaces = new Set<string>()
  for (const match of withoutComments.matchAll(/\binterface\s+([a-z][a-z0-9-]*)\s*\{/g)) {
    const name = match[1]
    if (name) interfaces.add(name)
  }

  const worlds = new Map<string, { imports: string[]; exports: string[] }>()
  for (const match of withoutComments.matchAll(/\bworld\s+([a-z][a-z0-9-]*)\s*\{([^{}]*)\}/g)) {
    const name = match[1]
    const body = match[2]
    if (!name || body === undefined) continue
    const imports = [...body.matchAll(/\bimport\s+([a-z][a-z0-9-]*)\s*;/g)].map((item) => item[1]).filter(Boolean) as string[]
    const exports = [...body.matchAll(/\bexport\s+([a-z][a-z0-9-]*)\s*;/g)].map((item) => item[1]).filter(Boolean) as string[]
    worlds.set(name, { imports, exports })
  }
  return { interfaces, worlds }
}

export async function assertNodeWorldMatchesWit(worktree: string, plan: NodePlan): Promise<void> {
  const witPath = resolveRepositoryPath(worktree, plan.world.witPath)
  try {
    const generated = await generateWitTypes(witPath, {
      worldName: plan.world.world,
      strict: true,
    })
    if (Object.keys(generated).length === 0) throw new Error("WIT projection produced no declarations")
  } catch (error) {
    throw new ContractValidationError(
      `Canonical WIT validation failed for ${plan.world.witPath}#${plan.world.world}: ${error instanceof Error ? error.message : String(error)}`,
      "invalid-wit",
    )
  }

  const source = await readFile(witPath, "utf8")
  const shape = extractLocalWitWorlds(source)
  const world = shape.worlds.get(plan.world.world)
  if (!world) {
    throw new ContractValidationError(`WIT world ${plan.world.world} was not found`, "missing-world")
  }
  if (world.exports.length !== 1 || world.exports[0] !== plan.exports[0]) {
    throw new ContractValidationError(
      `WIT world ${plan.world.world} must export exactly ${plan.exports[0] ?? "one interface"}`,
      "world-export-mismatch",
    )
  }
  const expectedImports = [...plan.imports].sort()
  const actualImports = [...world.imports].sort()
  if (JSON.stringify(expectedImports) !== JSON.stringify(actualImports)) {
    throw new ContractValidationError(
      `WIT world ${plan.world.world} imports ${actualImports.join(", ")} instead of ${expectedImports.join(", ")}`,
      "world-import-mismatch",
    )
  }
  for (const name of [...world.imports, ...world.exports]) {
    if (!shape.interfaces.has(name)) {
      throw new ContractValidationError(`WIT world ${plan.world.world} references missing interface ${name}`, "missing-interface")
    }
  }
  await assertBehaviorContract(worktree, plan)
  await assertBoundaryAssets(worktree, plan)
}
