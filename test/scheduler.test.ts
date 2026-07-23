import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ShedConfig, TaskConfig } from "../src/config.js";
import {
  dueTasks,
  executeScheduledEvent,
} from "../src/scheduler.js";
import { StateStore } from "../src/state.js";

const task = (
  id: string,
  at: string,
  agent: TaskConfig["agent"] = "codex",
): TaskConfig => ({
  id,
  at: new Date(at),
  atIso: new Date(at).toISOString(),
  agent,
  cwd: "/project",
  prompt: "Do the work",
  args: [],
});

const config = (...tasks: TaskConfig[]): ShedConfig => ({
  version: 1,
  path: "/project/shed.yml",
  directory: "/project",
  tasks: Object.fromEntries(tasks.map((value) => [value.id, value])),
});

test("selects only pending due events in time and ID order", async () => {
  const root = await mkdtemp(join(tmpdir(), "shed-scheduler-"));
  const state = await StateStore.open("/project/shed.yml", { root });
  const completed = task("completed", "2026-07-23T09:00:00Z");
  await state.markRunning(completed.id, completed.atIso);
  await state.markFinished(completed.id, completed.atIso, {
    status: "succeeded",
    exitCode: 0,
    signal: null,
  });

  const result = dueTasks(
    config(
      task("later", "2026-07-23T11:00:00Z"),
      task("b", "2026-07-23T10:00:00Z"),
      completed,
      task("a", "2026-07-23T10:00:00Z"),
      task("future", "2026-07-24T10:00:00Z"),
    ),
    state,
    new Date("2026-07-23T12:00:00Z"),
  );

  assert.deepEqual(
    result.map((value) => value.id),
    ["a", "b", "later"],
  );
});

test("persists running before invocation and records success", async () => {
  const root = await mkdtemp(join(tmpdir(), "shed-execute-"));
  const state = await StateStore.open("/project/shed.yml", { root });
  const scheduled = task("review", "2026-07-23T10:00:00Z");
  let observedStatus: string | undefined;

  const result = await executeScheduledEvent(scheduled, state, async () => {
    observedStatus = (
      await StateStore.open("/project/shed.yml", { root })
    ).get(scheduled.id, scheduled.atIso)?.status;
    return { code: 0, signal: null };
  });

  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(observedStatus, "running");
  assert.equal(state.get(scheduled.id, scheduled.atIso)?.status, "succeeded");
});

test("converts runner errors into a persisted failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "shed-execute-error-"));
  const state = await StateStore.open("/project/shed.yml", { root });
  const scheduled = task("review", "2026-07-23T10:00:00Z");

  const result = await executeScheduledEvent(scheduled, state, async () => {
    throw new Error("spawn failed");
  });

  assert.equal(result.error?.message, "spawn failed");
  assert.deepEqual(
    state.get(scheduled.id, scheduled.atIso)?.status,
    "failed",
  );
  assert.equal(
    state.get(scheduled.id, scheduled.atIso)?.error,
    "spawn failed",
  );
});
