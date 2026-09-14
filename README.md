# Shed

Shed schedules one-shot prompts for Codex, OpenCode, pi, and Claude Code from
a strict YAML file. It runs locally, invokes agents without a shell, and
keeps execution state outside the configuration.

## Install from source

Requires Node.js 20 or later and at least one supported agent installed and
authenticated on your `PATH`. macOS and Linux are the primary targets;
Windows agent shims that require a shell are not supported.

```sh
git clone https://github.com/ilkinnabiev/shedprompts.git
cd shedprompts
npm ci
npm run build
npm test
npm install --global .
```

The last command makes the local `shed` CLI available on your `PATH`.

## Configuration

Create `shed.yml`, or let `shed ui` create an empty one automatically:

```yaml
version: 1

tasks:
  review-api:
    at: "2099-01-01T09:30:00+03:00"
    agent: codex
    cwd: .
    prompt: |
      Review the current diff.
      Fix clear regressions and run the tests.
    args:
      - --sandbox
      - workspace-write
```

Replace `at` with your intended run time and `cwd` with your project directory.
`at` must be an RFC 3339 timestamp with a timezone. Relative `cwd` paths are
resolved from the YAML file. Supported agents are `codex`, `opencode`, `pi`,
and `claude` (Claude Code).

For Claude Code, set `agent: claude`. Shed invokes `claude --print` with the
prompt on stdin and inherits the installed CLI's authentication and permission
settings. Pass any additional CLI options through `args`; see the
[Claude Code automation guide](https://code.claude.com/docs/en/headless).

## Usage

```sh
shed validate
shed status
shed run review-api
shed serve
shed ui
```

Use `-c path/to/tasks.yml` to select another configuration. `run` is an
immediate test run and does not consume the scheduled event. `serve` remains
in the foreground, runs due tasks sequentially, and runs pending overdue tasks
after restart.

Use `launchd`, `systemd`, or another process supervisor when Shed should run in
the background. Shed does not install or manage a service.

## Local UI

Start the UI first. If the selected config does not exist, this creates a
minimal `shed.yml` in the current directory:

```sh
shed ui
```

Then run the scheduler in a second terminal:

```sh
shed serve
```

Open the printed capability URL. It starts with `http://127.0.0.1:4317/#`;
the fragment after `#` is the private key for that UI process. Use
`--port PORT` to select a different port.

The UI reads the same YAML and runtime state as the CLI. It can append a task,
but it cannot edit, delete, or immediately execute one. It binds to loopback
only, accepts future timestamps, and does not send prompts to a remote service.
Keep `shed serve` running to execute tasks when they become due.

## How it works

1. You define a one-shot task in YAML or add it through the local UI.
2. `shed serve` reparses the config, finds pending tasks whose `at` time has
   passed, and runs them sequentially.
3. Shed starts the selected agent directly, without a shell, and sends the
   prompt through standard input.
4. Execution state is durably stored outside the YAML as `running`,
   `succeeded`, `failed`, or `unknown`.
5. After a crash, an unfinished `running` event becomes `unknown` and is not
   retried automatically, avoiding accidental duplicate changes.

State lives under `$XDG_STATE_HOME/shed`, or `~/.local/state/shed` by default,
in a directory derived from the canonical config path. Keep it across
restarts: deleting state can cause overdue tasks to run again. Renaming a
task, changing its timestamp, or moving the config creates a new event.

Agent output goes to the terminal running `serve`. Agents inherit your
environment, authentication, and their own permission settings. The local UI
only writes YAML; the selected agent may contact its configured provider
when the scheduler runs a task.

The default `shed.yml`, environment files, and temporary files are ignored by
Git. Keep personal prompts and credentials out of commits.

See [SPEC.md](./SPEC.md) for the complete v1 contract.
