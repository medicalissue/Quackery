import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import { git, repositoryRoot } from "./git.js"

const persistedIntentFieldsSchema = z.object({
  goal: z.string().min(1),
  observableOutcomes: z.array(z.string().min(1)).default([]),
  inScope: z.array(z.string().min(1)).default([]),
  outOfScope: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
}).strict()

export const intentFieldsSchema = persistedIntentFieldsSchema.extend({
  observableOutcomes: z.array(z.string().min(1)).min(1),
  acceptance: z.array(z.string().min(1)).min(1),
})

export type IntentFields = z.infer<typeof intentFieldsSchema>

// Existing persisted v0.1 intents may predate the non-empty outcome/acceptance gate.
export const confirmedIntentSchema = persistedIntentFieldsSchema.extend({
  revision: z.string().min(1),
  source: z.enum(["psychiatrist", "pharmacist-direct"]),
  repository: z.string().min(1),
  repositoryBase: z.string().min(1),
  sessionId: z.string().min(1),
  confirmedAt: z.number().int().positive(),
}).strict()

export type ConfirmedIntent = z.infer<typeof confirmedIntentSchema>

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export class IntentRegistry {
  async confirm(
    directory: string,
    sessionId: string,
    source: ConfirmedIntent["source"],
    fields: IntentFields,
  ): Promise<ConfirmedIntent> {
    const repository = await repositoryRoot(directory)
    const repositoryBase = await git(repository, ["rev-parse", "HEAD"])
    const parsed = intentFieldsSchema.parse(fields)
    const confirmedAt = Date.now()
    const revision = `intent-${digest(JSON.stringify({ repositoryBase, source, parsed, confirmedAt })).slice(0, 12)}`
    const intent = confirmedIntentSchema.parse({
      ...parsed,
      revision,
      source,
      repository,
      repositoryBase,
      sessionId,
      confirmedAt,
    })
    const directoryPath = await this.directory(repository, sessionId)
    await mkdir(directoryPath, { recursive: true })
    const revisionPath = resolve(directoryPath, `${revision}.json`)
    await writeFile(revisionPath, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    const latestPath = resolve(directoryPath, "latest.json")
    const temporary = `${latestPath}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`, "utf8")
    await rename(temporary, latestPath)
    return intent
  }

  async resolve(directory: string, sessionId: string, revision?: string): Promise<ConfirmedIntent> {
    const repository = await repositoryRoot(directory)
    const directoryPath = await this.directory(repository, sessionId)
    const path = resolve(directoryPath, revision ? `${revision}.json` : "latest.json")
    let source: string
    try {
      source = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("No confirmed Intent Contract exists for this session; use Psychiatrist or directGoal")
      }
      throw error
    }
    const intent = confirmedIntentSchema.parse(JSON.parse(source))
    if (intent.repository !== repository) throw new Error("Intent Contract belongs to a different repository")
    if (revision && intent.revision !== revision) throw new Error(`Intent revision file mismatch for ${revision}`)
    const currentBase = await git(repository, ["rev-parse", "HEAD"])
    if (currentBase !== intent.repositoryBase) {
      throw new Error(`Intent base moved from ${intent.repositoryBase} to ${currentBase}; reconfirm the intent`)
    }
    return intent
  }

  private async directory(repository: string, sessionId: string): Promise<string> {
    const common = await git(repository, ["rev-parse", "--git-common-dir"])
    return resolve(repository, common, "quackery", "intents", digest(sessionId))
  }
}
