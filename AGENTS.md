# Project instructions

## Mission

Build `shed`, a minimal local scheduler for one-shot prompts executed by
Codex, OpenCode, pi, and Claude Code.

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
- Bind the UI to loopback only. It may append tasks to YAML and read runtime
  state, but it must never launch an agent.
- Let `ui` create a missing config as `version: 1` with an empty task mapping;
  other commands must continue to reject a missing config.
- Require the per-process UI capability for every API request and reject
  non-loopback hosts and cross-origin mutations.

## Engineering

- Use TypeScript on Node.js.
- Prefer Node's standard library and keep runtime dependencies to the minimum
  needed for strict YAML parsing.
- Keep the Codex, OpenCode, pi, and Claude Code adapters small and independent.
- Add focused tests for every behavior change.
- Keep the v1 UI additive: no editing, deleting, run-now controls, remote
  access, or user accounts.
- Do not introduce cron, workflows, plugins, arbitrary commands, or service
  installation in v1.
