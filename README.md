# Quackery

Quackery is an experimental Git-native recursive parallel implementation plugin for OpenCode.

Its execution rule is:

> Freeze the world. Fill one hole.

The selected Pharmacist creates only a high-level, Nurse-only root boundary from the current checkout. Parallel Nurses recursively delegate atomic holes to Surgeons and ambiguous deltas to more Nurses. Each cheap Surgeon receives a WIT world whose imports are treated as already implemented and fills exactly one export in an isolated Git worktree.

## Install

Add the npm package to the global OpenCode configuration at `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["quackery-opencode"]
}
```

OpenCode resolves and caches npm plugins from this list. No Quackery-specific `npx`, install script, slash command, or custom TUI is required. Provider authentication plugins may remain alongside Quackery; they are transports, not agent harnesses.

Restart OpenCode, select `Psychiatrist` or `Pharmacist` with `Tab`/`Shift+Tab`, and run `quackery_doctor` before the first implementation QA.

## Development

```bash
bun install
bun run verify
```

## OpenCode configuration

For published-package use, add the package name to `opencode.json`:

```json
{
  "plugin": ["quackery-opencode"]
}
```

The repository intentionally does not include an auto-loaded `.opencode/plugins` shim, so running OpenCode from this checkout tests the configured npm package instead of silently loading source code. When developing the plugin itself, use an explicit temporary `file://` plugin entry.

The plugin registers visible `psychiatrist` and `pharmacist` primary agents and hidden `nurse` and `surgeon` subagents. Pharmacist uses `quackery_doctor`, `quackery_start`, `quackery_status`, `quackery_wait`, and `quackery_apply`; users do not need a slash-command entrypoint. `quackery_doctor` checks every local prerequisite while reporting provider reachability and cache behavior as `UNKNOWN` until a live run measures them.

## `.quack` configuration

Tracked project policy lives in `.quack/config.jsonc`. Concrete provider model IDs can stay machine-local:

```bash
cp .quack/config.local.example.jsonc .quack/config.local.jsonc
```

The example is a ready-to-use OpenAI ladder; replace its IDs if another OpenCode provider should be used:

```jsonc
{
  "models": {
    "frontier": { "model": "openai/gpt-5.6-sol", "variant": "max" },
    "strong": { "model": "openai/gpt-5.6-sol", "variant": "high" },
    "balanced": { "model": "openai/gpt-5.6-terra", "variant": "high" },
    "economy": { "model": "openai/gpt-5.6-luna", "variant": "medium" }
  }
}
```

The default `balanced` profile routes Psychiatrist → frontier, Pharmacist → strong, Nurse → balanced, and Surgeon → economy. The `quality` profile routes them to frontier, frontier, strong, and balanced. Missing mappings inherit the existing OpenCode agent/current model. `quackery_model_status` shows the effective routing.

Configuration precedence is plugin options < `.quack/config.jsonc` < `.quack/config.local.jsonc`. Mutable run snapshots stay under `.git/quackery/runs`; temporary worktrees stay outside the repository.

Depth, node count, leaf-to-Nurse bounce count, whole-run time, individual OpenCode request time, and verification-command time are bounded in `limits`. Agent shell access is denied; implementation writes go through path-audited edit tools, while verification commands are executed only by the runtime after the implementation commit is frozen.

Prompt caching is grouped by frozen parent boundary and role. Eligible same-role siblings share a deterministic stable system prefix without waiting for a cache-primer barrier. The text graph reports provider-returned cache read/write tokens and cost; a configured cache key is not itself proof of a provider cache hit.

## Current boundary

The core runtime, checkout-free synthetic root boundary, Nurse-only root fan-out, Git child-worktree topology, balanced recursive fan-out, ownership validation, canonical WIT parsing plus Quackery's one-export world policy, revisioned Intent Contract handoff, isolated Nurse boundary writing, leaf- and integration-local `NEEDS_NURSE` decomposition, product-only result commits, recursive join, role model routing, cache grouping/telemetry, text graph, restart-safe status/apply, and post-apply cleanup are implemented and testable without a model provider. A child starts as soon as its own worktree is ready; creation of later sibling worktrees is not a decomposition barrier. CI repeats type checking, the fake-provider/real-Git suite, build, and package inspection.

An interrupted process is recovered as inspectable `interrupted` state with its branches and worktrees preserved; it is not automatically resumed. The current WIT policy intentionally supports local interfaces; broader package-qualified worlds are future work. Live OpenCode model execution, provider/model reachability, actual provider cache hits, strict provider-side token/cost caps, and crash-time session resumption remain `UNKNOWN` or future work until measured.
