#!/usr/bin/env node

import { parseArgs } from "node:util";

import { isAgentAvailable, runAgent } from "./agents.js";
import { loadConfig, type ShedConfig } from "./config.js";
import {
  assertAgentsAvailable,
  resultDescription,
  serve,
} from "./scheduler.js";
import { StateStore } from "./state.js";
import { startUi } from "./ui.js";

const usage = `Usage:
  shed [-c FILE] validate
  shed [-c FILE] status
  shed [-c FILE] run TASK_ID
  shed [-c FILE] serve
  shed [-c FILE] [--port PORT] ui`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string", short: "c", default: "shed.yml" },
      help: { type: "boolean", short: "h", default: false },
      port: { type: "string" },
    },
  });

  if (values.help) {
    console.log(usage);
    return 0;
  }

  const [command, ...arguments_] = positionals;
  const configPath = values.config;
  if (!command || !configPath) {
    throw new UsageError(usage);
  }
  if (command !== "ui" && values.port !== undefined) {
    throw new UsageError("--port is only valid with ui");
  }

  switch (command) {
    case "validate": {
      requireArguments(command, arguments_, 0);
      const config = await loadConfig(configPath);
      await assertAgentsAvailable(config);
      console.log(
        `${config.path}: ${Object.keys(config.tasks).length} task(s) valid`,
      );
      return 0;
    }

    case "status": {
      requireArguments(command, arguments_, 0);
      const config = await loadConfig(configPath);
      await printStatus(config);
      return 0;
    }

    case "run": {
      requireArguments(command, arguments_, 1);
      const config = await loadConfig(configPath);
      const taskId = arguments_[0];
      const task = taskId ? config.tasks[taskId] : undefined;
      if (!task) {
        throw new UsageError(`Unknown task ${JSON.stringify(taskId)}`);
      }
      if (!(await isAgentAvailable(task.agent))) {
        throw new Error(`Agent executable not found on PATH: ${task.agent}`);
      }
      const result = await runAgent(task);
      if (result.code === 0 && result.signal === null && !result.error) {
        return 0;
      }
      throw new Error(`${task.id} failed: ${resultDescription(result)}`);
    }

    case "serve":
      requireArguments(command, arguments_, 0);
      await serve(configPath);
      return 0;

    case "ui": {
      requireArguments(command, arguments_, 0);
      const server = await startUi(configPath, {
        port: parsePort(values.port),
      });
      console.log(`Shed UI: ${server.url}`);
      console.log(`Config: ${configPath}`);
      console.log("Run `shed serve` in another terminal to execute due tasks.");
      await server.done;
      return 0;
    }

    default:
      throw new UsageError(`Unknown command ${JSON.stringify(command)}\n\n${usage}`);
  }
}

async function printStatus(config: ShedConfig): Promise<void> {
  const state = await StateStore.open(config.path);
  console.log("ID\tAT\tAGENT\tSTATUS");
  for (const task of Object.values(config.tasks).sort(
    (left, right) =>
      left.at.getTime() - right.at.getTime() ||
      left.id.localeCompare(right.id),
  )) {
    const status = state.get(task.id, task.atIso)?.status ?? "pending";
    console.log(`${task.id}\t${task.atIso}\t${task.agent}\t${status}`);
  }
}

function requireArguments(
  command: string,
  arguments_: string[],
  count: number,
): void {
  if (arguments_.length !== count) {
    throw new UsageError(
      `${command} expects ${count === 0 ? "no arguments" : "one TASK_ID"}`,
    );
  }
}

class UsageError extends Error {}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "4317");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError("--port must be an integer from 1 to 65535");
  }
  return port;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`shed: ${message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
