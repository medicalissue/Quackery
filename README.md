# Quackery

Quackery is an experimental Git-native recursive parallel implementation plugin for OpenCode.

Its execution rule is:

> Freeze the world. Fill one hole.

Pharmacist creates only the root boundary. Parallel Nurses recursively create balanced immediate child worlds. Each cheap Surgeon receives a WIT world whose imports are treated as already implemented and fills exactly one export in an isolated Git worktree.

## Development

```bash
bun install
bun run check
bun test
bun run build
```

## OpenCode configuration

During local development, point OpenCode at the built package or publish it and add the package name to `opencode.json`:

```json
{
  "plugin": ["quackery-opencode"]
}
```

This checkout already includes `.opencode/plugins/quackery.ts` as a local development shim, so running OpenCode from the repository loads the source plugin directly.

The plugin registers visible `psychiatrist` and `pharmacist` primary agents and hidden `nurse` and `surgeon` subagents. Pharmacist uses `quackery_start`, `quackery_status`, `quackery_wait`, and `quackery_apply`; users do not need a slash-command entrypoint.

## `.quack` configuration

Tracked project policy lives in `.quack/config.jsonc`. Concrete provider model IDs can stay machine-local:

```bash
cp .quack/config.local.example.jsonc .quack/config.local.jsonc
```

Then replace the four placeholders with models available through your OpenCode providers:

```jsonc
{
  "models": {
    "frontier": { "model": "provider/frontier-model", "variant": "high" },
    "strong": { "model": "provider/strong-model", "variant": "high" },
    "balanced": { "model": "provider/balanced-model", "variant": "medium" },
    "economy": { "model": "provider/economy-model", "variant": "low" }
  }
}
```

The default `balanced` profile routes Psychiatrist → frontier, Pharmacist → strong, Nurse → balanced, and Surgeon → economy. The `quality` profile routes them to frontier, frontier, strong, and balanced. Missing mappings inherit the existing OpenCode agent/current model. `quackery_model_status` shows the effective routing.

Configuration precedence is plugin options < `.quack/config.jsonc` < `.quack/config.local.jsonc`. Mutable run snapshots stay under `.git/quackery/runs`; temporary worktrees stay outside the repository.

Prompt caching is grouped by frozen parent boundary and role. Eligible same-role siblings share a deterministic stable system prefix without waiting for a cache-primer barrier. The text graph reports provider-returned cache read/write tokens and cost; a configured cache key is not itself proof of a provider cache hit.

## Current boundary

The core runtime, Git worktree topology, balanced recursive fan-out, ownership validation, canonical WIT parsing plus Quackery's one-export world policy, revisioned Intent Contract handoff, isolated boundary writing, leaf-local `NEEDS_NURSE` decomposition, result commits, recursive join, role model routing, cache grouping/telemetry, and text graph are implemented and testable without OpenCode. A child starts as soon as its own worktree is ready; creation of later sibling worktrees is not a decomposition barrier. The current WIT policy intentionally supports local interfaces; broader package-qualified worlds are future work. Restart recovery, automatic cleanup, integration-leaf `NEEDS_NURSE`, live OpenCode execution, and actual provider cache hits remain unverified or future work.
