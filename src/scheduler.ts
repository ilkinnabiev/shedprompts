import { setTimeout as delay } from "node:timers/promises";

import {
  isAgentAvailable,
  runAgent,
  type AgentRunResult,
} from "./agents.js";
import {
  loadConfig,
  type ShedConfig,
  type TaskConfig,
} from "./config.js";
import {
  acquireServeLock,
  StateStore,
  type StateOptions,
} from "./state.js";

export type AgentRunner = (task: TaskConfig) => Promise<AgentRunResult>;

export async function assertAgentsAvailable(config: ShedConfig): Promise<void> {
  const missing: string[] = [];
  for (const agent of new Set(
    Object.values(config.tasks).map((task) => task.agent),
  )) {
    if (!(await isAgentAvailable(agent))) {
      missing.push(agent);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Agent executable${missing.length === 1 ? "" : "s"} not found on PATH: ${missing.join(", ")}`,
    );
  }
}

export function dueTasks(
  config: ShedConfig,
  state: StateStore,
  now = new Date(),
): TaskConfig[] {
  return Object.values(config.tasks)
    .filter(
      (task) =>
        task.at.getTime() <= now.getTime() &&
        state.get(task.id, task.atIso) === undefined,
    )
    .sort(
      (left, right) =>
        left.at.getTime() - right.at.getTime() ||
        left.id.localeCompare(right.id),
    );
}

export async function executeScheduledEvent(
  task: TaskConfig,
  state: StateStore,
  runner: AgentRunner = runAgent,
): Promise<AgentRunResult> {
  await state.markRunning(task.id, task.atIso);

  let result: AgentRunResult;
  try {
    result = await runner(task);
  } catch (error) {
    result = {
      code: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  const succeeded = result.code === 0 && result.signal === null && !result.error;
  await state.markFinished(task.id, task.atIso, {
    status: succeeded ? "succeeded" : "failed",
    exitCode: result.code,
    signal: result.signal,
    ...(result.error ? { error: result.error.message } : {}),
  });
  return result;
}

export interface ServeOptions {
  pollIntervalMs?: number;
  signal?: AbortSignal;
  state?: StateOptions;
  log?: (message: string) => void;
}

export async function serve(
  inputPath: string,
  options: ServeOptions = {},
): Promise<void> {
  const initial = await loadConfig(inputPath);
  await assertAgentsAvailable(initial);

  const lock = await acquireServeLock(initial.path, options.state);
  try {
    const state = await StateStore.open(initial.path, options.state);
    const recovered = await state.recoverInterrupted();
    const log = options.log ?? console.log;
    if (recovered > 0) {
      log(`Recovered ${recovered} interrupted event(s) as unknown`);
    }
    log(`Serving ${initial.path}`);

    let lastReloadError = "";
    while (!options.signal?.aborted) {
      let config: ShedConfig;
      try {
        config = await loadConfig(inputPath);
        if (config.path !== initial.path) {
          throw new Error(
            "The canonical config path changed while serve was running",
          );
        }
        await assertAgentsAvailable(config);
        lastReloadError = "";
      } catch (error) {
        const message = messageOf(error);
        if (message !== lastReloadError) {
          log(`Configuration unavailable; launches paused: ${message}`);
          lastReloadError = message;
        }
        await wait(options.pollIntervalMs ?? 1_000, options.signal);
        continue;
      }

      for (const task of dueTasks(config, state)) {
        log(`Running ${task.id} with ${task.agent}`);
        const result = await executeScheduledEvent(task, state);
        if (result.code === 0 && result.signal === null && !result.error) {
          log(`Succeeded ${task.id}`);
        } else {
          log(`Failed ${task.id}: ${resultDescription(result)}`);
        }
      }

      await wait(options.pollIntervalMs ?? 1_000, options.signal);
    }
  } finally {
    await lock.release();
  }
}

export function resultDescription(result: AgentRunResult): string {
  if (result.error) {
    return result.error.message;
  }
  if (result.signal) {
    return `terminated by ${result.signal}`;
  }
  return `exit status ${String(result.code)}`;
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
