# Shed v1 specification

## Purpose

Shed is a small local scheduler for one-shot prompts executed by Codex,
OpenCode, or pi. Version 1 intentionally does not provide recurring schedules,
workflows, retries, notifications, remote access, or arbitrary commands.

## Configuration

Shed reads YAML. The default file is `shed.yml` in the current directory; `-c`
selects another file.

```yaml
version: 1

tasks:
  review-api:
    at: "2026-07-24T09:30:00+03:00"
    agent: codex
    cwd: ./api
    prompt: |
      Review the current diff.
      Fix clear regressions and run the tests.
    args:
      - --sandbox
      - workspace-write
```

The root value must be a mapping with exactly these fields:

- `version`: required; must be the integer `1`.
- `tasks`: required; must be a mapping from task IDs to task definitions.

A task ID must match `[A-Za-z0-9][A-Za-z0-9._-]*` and is stable within the
configuration. A task definition is a mapping with these fields:

- `at`: required; a valid RFC 3339 timestamp with an explicit UTC offset or
  `Z`. Fractional seconds may contain at most three digits. It represents one
  instant and one scheduled run.
- `agent`: required; one of `codex`, `opencode`, or `pi`.
- `prompt`: required; a non-empty string.
- `cwd`: optional; a directory in which the agent runs. A relative path is
  resolved from the configuration file's directory. The default is that
  directory.
- `args`: optional; a sequence of strings passed as additional arguments to
  the selected agent. The default is an empty sequence.

Parsing is strict. Duplicate keys, unknown fields, unknown agents, invalid
types, invalid timestamps, empty IDs or prompts, and a missing or non-directory
`cwd` are errors. YAML values are data only: Shed does not expand environment
variables, evaluate templates, or perform shell substitution.

## Command line

```text
shed [-c FILE] validate
shed [-c FILE] status
shed [-c FILE] run TASK_ID
shed [-c FILE] serve
shed [-c FILE] [--port PORT] ui
```

- `validate` checks the complete configuration, every `cwd`, and availability
  of every agent executable referenced by a task. It does not run an agent.
- `status` reports each configured scheduled event as `pending`, `running`,
  `succeeded`, `failed`, or `unknown`.
- `run TASK_ID` invokes that task immediately for testing. It does not consume
  or change the status of its scheduled event.
- `serve` validates the configuration, recovers state, and waits for due
  events. It stays in the foreground; operating-system service managers are
  responsible for background execution and restart.
- `ui` serves the local management interface on `127.0.0.1`. The default port
  is `4317`; `--port` selects another port. It shows configured tasks and
  runtime status and can append a new task to the YAML file. If the selected
  file does not exist, `ui` creates `version: 1` with an empty task mapping
  before starting. It does not run agents; `serve` remains the scheduler
  process.

Invalid input, an unavailable executable, failure to acquire the scheduler
lock, or a failed `run` invocation must produce a non-zero exit status. A
failed scheduled event is recorded as `failed`; `serve` stays alive and
continues with later events.

## Local UI

The UI is a loopback-only convenience over the same configuration and state
used by the CLI. YAML remains the source of truth. Each refresh reparses the
current YAML and reopens the state file so manual edits and scheduler results
appear without restarting the UI.

Only `ui` bootstraps a missing configuration. It creates the selected path
with mode `0600` on POSIX and the equivalent of `version: 1` plus
`tasks: {}`. The parent directory must already exist. Other commands continue
to reject a missing configuration.

The UI may append a new task only. It cannot edit or delete tasks, invoke
`run`, or start `serve`. It accepts only timestamps later than the request
time, so adding a task through the UI cannot intentionally act as `run now`.
A creation request includes the revision of the YAML that the user viewed.
Shed serializes its configuration writers and rejects a stale revision after
acquiring the write lock. Immediately before replacement it compares the
on-disk revision again. A successful write uses a temporary file, durable
flush, and atomic replacement while preserving YAML comments and file mode.
UI updates require a regular configuration file with one hard link.

Only agents whose executable is currently available on `PATH` may be selected
for a new task. Every HTTP API request requires a random per-process
capability included only in the fragment of the URL printed by `shed ui`.
Requests must use the exact loopback `Host`, and mutations must also use the
same `Origin`. Shed does not enable cross-origin access.

## Event identity and time

A scheduled event is uniquely identified by:

1. the canonical absolute configuration path,
2. the task ID, and
3. the `at` value normalized to its UTC instant.

Equivalent RFC 3339 offsets therefore identify the same event. Moving the
configuration file, renaming the task, or changing `at` creates a new event.
Changing `prompt`, `agent`, `cwd`, or `args` does not create a new event.

When `serve` starts, every overdue event with no terminal or indeterminate
state is run as soon as possible. A completed, failed, or unknown event is not
run automatically again.

## Execution

Shed invokes each agent through its supported non-interactive interface:
Codex through `codex exec`, OpenCode through `opencode run`, and pi through
`pi --print`. Configured arguments are passed as process arguments and the
prompt is passed on standard input.

Processes are spawned directly with an argument vector. Shed never invokes a
shell. Agent authentication and agent-specific configuration are inherited
from the environment; Shed does not store credentials.

Scheduled events run sequentially, including overdue events found at startup.
At most one scheduled agent process is active for a configuration. If several
events are due, they are ordered first by normalized `at`, then by task ID.

An invocation that exits with status zero becomes `succeeded`. A non-zero
exit, signal termination, or spawn error becomes `failed`. Shed never retries
an event automatically. A failed event does not terminate `serve`.

## Persistent state and recovery

Runtime state is stored separately from the YAML configuration. Shed must
never rewrite the configuration to record execution state.

Before spawning an agent, Shed durably records the event as `running`. After
the agent terminates, Shed durably records `succeeded` or `failed`. On startup,
a persisted `running` event left by a previous scheduler process becomes
`unknown`; it is not automatically retried because the agent may already have
changed the working tree.

Only one `serve` process may own a configuration at a time. A second process
must fail to acquire the configuration lock and exit without running events.

## Out of scope for v1

- recurring or cron schedules;
- dependencies or workflows between tasks;
- parallel scheduled execution;
- automatic retries or backoff;
- notifications;
- remote or multi-user UI access;
- editing, deleting, or immediately running tasks from the UI;
- secrets in YAML;
- arbitrary shell commands;
- installation or supervision of a background service.
