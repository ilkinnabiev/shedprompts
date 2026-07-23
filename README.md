# Shed

Shed schedules one-shot prompts for Codex, OpenCode, and pi from a strict YAML
file. It runs locally, invokes agents without a shell, and keeps execution
state outside the configuration.

## Development

Requires a current Node.js LTS release.

```sh
npm install
npm run build
npm test
npm install --global .
```

The last command makes the local `shed` CLI available on your `PATH`.

## Configuration

Create `shed.yml`:

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

`at` must be an RFC 3339 timestamp with a timezone. Relative `cwd` paths are
resolved from the YAML file. Supported agents are `codex`, `opencode`, and
`pi`.

## Usage

```sh
shed validate
shed status
shed run review-api
shed serve
```

Use `-c path/to/tasks.yml` to select another configuration. `run` is an
immediate test run and does not consume the scheduled event. `serve` remains
in the foreground, runs due tasks sequentially, and runs pending overdue tasks
after restart.

Use `launchd`, `systemd`, or another process supervisor when Shed should run in
the background. Shed does not install or manage a service.

See [SPEC.md](./SPEC.md) for the complete v1 contract.
