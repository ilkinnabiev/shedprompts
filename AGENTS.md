# Project instructions

## Mission

Build `shed`, a minimal local scheduler for one-shot prompts executed by
Codex, OpenCode, and pi.

## Source of truth

`SPEC.md` defines v1 behavior. Do not add features outside that scope without
explicit approval.

## Invariants

- Parse YAML strictly and reject duplicate keys and unknown fields.
- Require timezone-aware RFC 3339 timestamps.
- Identify an event by canonical config path, task ID, and normalized `at`.
- Resolve relative `cwd` values from the configuration directory.
- Spawn agents directly; never execute configuration through a shell.
- Keep runtime state outside the YAML file.
- Persist `running` before starting an agent.
- Convert stale `running` state to `unknown` after a crash and never retry it
  automatically.
- Run scheduled events sequentially and run pending overdue events on startup.
- Inherit agent authentication; never store secrets in YAML.
- Keep `serve` in the foreground and leave supervision to the operating
  system.

## Engineering

- Use TypeScript on Node.js.
- Prefer Node's standard library and keep runtime dependencies to the minimum
  needed for strict YAML parsing.
- Keep the Codex, OpenCode, and pi adapters small and independent.
- Add focused tests for every behavior change.
- Do not introduce cron, workflows, plugins, a UI, custom commands, or service
  installation in v1.
