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

The plugin registers visible `psychiatrist` and `pharmacist` primary agents and hidden `nurse` and `surgeon` subagents. Configure their models in the normal OpenCode agent configuration. Pharmacist uses `quackery_start`, `quackery_status`, `quackery_wait`, and `quackery_apply`; users do not need a slash-command entrypoint.

## Current boundary

The core runtime, Git worktree topology, balanced recursive fan-out, ownership validation, canonical WIT parsing plus Quackery's one-export world policy, result commits, recursive join, and text graph are implemented and testable without OpenCode. The current WIT policy intentionally supports local interfaces; broader package-qualified worlds are future work. Live OpenCode model execution depends on the configured provider and repository and must be validated in an installed host.
