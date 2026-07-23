import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseDocument } from "yaml";

export type AgentName = "codex" | "opencode" | "pi";

export interface TaskConfig {
  id: string;
  at: Date;
  atIso: string;
  agent: AgentName;
  cwd: string;
  prompt: string;
  args: string[];
}

export interface ShedConfig {
  version: 1;
  path: string;
  directory: string;
  tasks: Record<string, TaskConfig>;
}

export class ConfigError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ConfigError";
  }
}

const ROOT_KEYS = new Set(["version", "tasks"]);
const TASK_KEYS = new Set(["at", "agent", "cwd", "prompt", "args"]);
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;

export async function loadConfig(inputPath: string): Promise<ShedConfig> {
  let path: string;
  try {
    path = await realpath(inputPath);
  } catch (error) {
    throw new ConfigError(inputPath, `cannot resolve config file: ${messageOf(error)}`);
  }

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(path, `cannot read config file: ${messageOf(error)}`);
  }

  const document = parseDocument(source, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new ConfigError(
      path,
      `invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ mapAsMap: true });
  } catch (error) {
    throw new ConfigError(path, `invalid YAML: ${messageOf(error)}`);
  }

  const root = mapping(value, "config", path);
  rejectUnknownKeys(root, ROOT_KEYS, "config", path);

  if (root.get("version") !== 1) {
    throw new ConfigError(path, 'field "version" must be exactly 1');
  }
  if (!root.has("tasks")) {
    throw new ConfigError(path, 'missing required field "tasks"');
  }

  const rawTasks = mapping(root.get("tasks"), 'field "tasks"', path);
  const directory = dirname(path);
  const tasks: Record<string, TaskConfig> = {};

  for (const [rawId, rawTask] of rawTasks) {
    if (typeof rawId !== "string" || !TASK_ID.test(rawId)) {
      throw new ConfigError(
        path,
        `task ID ${describe(rawId)} must match ${TASK_ID.source}`,
      );
    }

    const label = `task "${rawId}"`;
    const task = mapping(rawTask, label, path);
    rejectUnknownKeys(task, TASK_KEYS, label, path);

    const atText = requiredString(task, "at", label, path);
    const at = timestamp(atText, `${label}.at`, path);
    const agent = requiredString(task, "agent", label, path);
    if (agent !== "codex" && agent !== "opencode" && agent !== "pi") {
      throw new ConfigError(
        path,
        `${label}.agent must be one of codex, opencode, pi`,
      );
    }

    const prompt = requiredString(task, "prompt", label, path);
    if (prompt.trim() === "") {
      throw new ConfigError(path, `${label}.prompt must not be empty`);
    }

    let cwd = directory;
    if (task.has("cwd")) {
      const configuredCwd = requiredString(task, "cwd", label, path);
      if (configuredCwd === "") {
        throw new ConfigError(path, `${label}.cwd must not be empty`);
      }
      cwd = resolve(directory, configuredCwd);
    }
    try {
      cwd = await realpath(cwd);
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error("path is not a directory");
      }
    } catch (error) {
      throw new ConfigError(
        path,
        `${label}.cwd must reference an existing directory: ${messageOf(error)}`,
      );
    }

    let args: string[] = [];
    if (task.has("args")) {
      const rawArgs = task.get("args");
      if (
        !Array.isArray(rawArgs) ||
        rawArgs.some((argument) => typeof argument !== "string")
      ) {
        throw new ConfigError(path, `${label}.args must be an array of strings`);
      }
      args = [...rawArgs];
    }

    tasks[rawId] = {
      id: rawId,
      at,
      atIso: at.toISOString(),
      agent,
      cwd,
      prompt,
      args,
    };
  }

  return { version: 1, path, directory, tasks };
}

function mapping(value: unknown, label: string, path: string): Map<unknown, unknown> {
  if (!(value instanceof Map)) {
    throw new ConfigError(path, `${label} must be a non-null mapping`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Map<unknown, unknown>,
  allowed: Set<string>,
  label: string,
  path: string,
): void {
  for (const key of value.keys()) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new ConfigError(path, `${label} contains unknown field ${describe(key)}`);
    }
  }
}

function requiredString(
  value: Map<unknown, unknown>,
  field: string,
  label: string,
  path: string,
): string {
  if (!value.has(field)) {
    throw new ConfigError(path, `${label} is missing required field "${field}"`);
  }
  const result = value.get(field);
  if (typeof result !== "string") {
    throw new ConfigError(path, `${label}.${field} must be a string`);
  }
  return result;
}

function timestamp(value: string, label: string, path: string): Date {
  const match = RFC3339.exec(value);
  if (!match) {
    throw new ConfigError(
      path,
      `${label} must be an RFC 3339 timestamp with Z or an explicit offset`,
    );
  }

  const [, year, month, day, hour, minute, second, zone, offsetHour, offsetMinute] =
    match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const validCalendarDate =
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    dayNumber >= 1 &&
    dayNumber <= daysInMonth(yearNumber, monthNumber);
  const validTime =
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59;
  const validOffset =
    zone === "Z" ||
    (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59);
  const result = new Date(value);

  if (!validCalendarDate || !validTime || !validOffset || Number.isNaN(result.valueOf())) {
    throw new ConfigError(path, `${label} is not a valid RFC 3339 timestamp`);
  }
  return result;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return String(value);
  }
  return Array.isArray(value) ? "<sequence>" : "<mapping>";
}
