import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type EventStatus = "running" | "succeeded" | "failed" | "unknown";

export interface EventRecord {
  taskId: string;
  at: string;
  status: EventStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}

interface StateFile {
  version: 1;
  events: Record<string, EventRecord>;
}

export interface StateOptions {
  root?: string;
}

const emptyState = (): StateFile => ({ version: 1, events: {} });

export function defaultStateRoot(): string {
  const xdgState = process.env.XDG_STATE_HOME;
  return xdgState
    ? join(xdgState, "shed")
    : join(homedir(), ".local", "state", "shed");
}

export function stateDirectory(
  configPath: string,
  options: StateOptions = {},
): string {
  const configHash = createHash("sha256")
    .update(configPath)
    .digest("hex")
    .slice(0, 32);
  return join(options.root ?? defaultStateRoot(), configHash);
}

export function eventKey(taskId: string, at: string): string {
  return createHash("sha256")
    .update(taskId)
    .update("\0")
    .update(at)
    .digest("hex");
}

export class StateStore {
  readonly directory: string;
  readonly path: string;
  private data: StateFile;

  private constructor(directory: string, data: StateFile) {
    this.directory = directory;
    this.path = join(directory, "state.json");
    this.data = data;
  }

  static async open(
    configPath: string,
    options: StateOptions = {},
  ): Promise<StateStore> {
    const directory = stateDirectory(configPath, options);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "state.json");

    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return new StateStore(directory, parseState(parsed, path));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return new StateStore(directory, emptyState());
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid state file ${path}: ${error.message}`);
      }
      throw error;
    }
  }

  get(taskId: string, at: string): EventRecord | undefined {
    return this.data.events[eventKey(taskId, at)];
  }

  async markRunning(
    taskId: string,
    at: string,
    now = new Date(),
  ): Promise<void> {
    this.data.events[eventKey(taskId, at)] = {
      taskId,
      at,
      status: "running",
      startedAt: now.toISOString(),
    };
    await this.save();
  }

  async markFinished(
    taskId: string,
    at: string,
    result: {
      status: "succeeded" | "failed";
      exitCode: number | null;
      signal: string | null;
      error?: string;
    },
    now = new Date(),
  ): Promise<void> {
    const key = eventKey(taskId, at);
    const previous = this.data.events[key];
    const record: EventRecord = {
      taskId,
      at,
      status: result.status,
      startedAt: previous?.startedAt ?? now.toISOString(),
      finishedAt: now.toISOString(),
      exitCode: result.exitCode,
      signal: result.signal,
    };
    if (result.error !== undefined) {
      record.error = result.error;
    }
    this.data.events[key] = record;
    await this.save();
  }

  async recoverInterrupted(now = new Date()): Promise<number> {
    let recovered = 0;
    for (const record of Object.values(this.data.events)) {
      if (record.status === "running") {
        record.status = "unknown";
        record.finishedAt = now.toISOString();
        record.error = "Scheduler stopped before recording the agent result";
        recovered += 1;
      }
    }
    if (recovered > 0) {
      await this.save();
    }
    return recovered;
  }

  private async save(): Promise<void> {
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );

    try {
      await handle.writeFile(`${JSON.stringify(this.data, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      await rename(temporary, this.path);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export interface ServeLock {
  release(): Promise<void>;
}

export async function acquireServeLock(
  configPath: string,
  options: StateOptions = {},
): Promise<ServeLock> {
  const directory = stateDirectory(configPath, options);
  const locksDirectory = join(directory, "locks");
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const path = join(locksDirectory, `serve-${process.pid}-${token}.lock`);
  const handle = await open(path, "wx", 0o600);

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
    );
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }

  try {
    for (const filename of await readdir(locksDirectory)) {
      const otherPath = join(locksDirectory, filename);
      if (
        otherPath === path ||
        !filename.startsWith("serve-") ||
        !filename.endsWith(".lock")
      ) {
        continue;
      }

      const owner = await readLockOwner(otherPath);
      if (owner === null) {
        continue;
      }
      if (
        (owner.pid !== null && isProcessAlive(owner.pid)) ||
        (owner.pid === null && owner.ageMs < 30_000)
      ) {
        throw new Error(
          `Another shed serve process already owns ${configPath}` +
            (owner.pid === null ? "" : ` (pid ${owner.pid})`),
        );
      }

      // Lock names contain a UUID and are never reused, so deleting this
      // specific dead owner's file cannot remove a newer owner's lock.
      await rm(otherPath, { force: true });
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    async release(): Promise<void> {
      await rm(path, { force: true });
    },
  };
}

async function readLockOwner(
  path: string,
): Promise<{ pid: number | null; ageMs: number } | null> {
  try {
    const [source, metadata] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    let pid: number | null = null;
    try {
      const value = JSON.parse(source) as { pid?: unknown };
      if (Number.isInteger(value.pid) && Number(value.pid) > 0) {
        pid = Number(value.pid);
      }
    } catch {
      // A newly created lock may not have its owner metadata yet.
    }
    return { pid, ageMs: Math.max(0, Date.now() - metadata.mtimeMs) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseState(value: unknown, path: string): StateFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.events)) {
    throw new Error(`Invalid state file ${path}: expected version 1 state`);
  }

  const events: Record<string, EventRecord> = {};
  for (const [key, raw] of Object.entries(value.events)) {
    if (
      !isRecord(raw) ||
      typeof raw.taskId !== "string" ||
      typeof raw.at !== "string" ||
      !isEventStatus(raw.status) ||
      typeof raw.startedAt !== "string" ||
      (raw.finishedAt !== undefined && typeof raw.finishedAt !== "string") ||
      (raw.exitCode !== undefined &&
        raw.exitCode !== null &&
        typeof raw.exitCode !== "number") ||
      (raw.signal !== undefined &&
        raw.signal !== null &&
        typeof raw.signal !== "string") ||
      (raw.error !== undefined && typeof raw.error !== "string")
    ) {
      throw new Error(`Invalid state file ${path}: malformed event ${key}`);
    }
    events[key] = raw as unknown as EventRecord;
  }

  return { version: 1, events };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventStatus(value: unknown): value is EventStatus {
  return (
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "unknown"
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
