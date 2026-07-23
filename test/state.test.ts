import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireServeLock,
  stateDirectory,
  StateStore,
} from "../src/state.js";

test("persists event state and recovers interrupted runs as unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "shed-state-"));
  const configPath = "/project/shed.yml";
  const started = new Date("2026-07-23T10:00:00.000Z");
  const recoveredAt = new Date("2026-07-23T10:05:00.000Z");

  const state = await StateStore.open(configPath, { root });
  await state.markRunning("review", "2026-07-24T06:30:00.000Z", started);

  const reopened = await StateStore.open(configPath, { root });
  assert.equal(await reopened.recoverInterrupted(recoveredAt), 1);
  assert.deepEqual(
    reopened.get("review", "2026-07-24T06:30:00.000Z"),
    {
      taskId: "review",
      at: "2026-07-24T06:30:00.000Z",
      status: "unknown",
      startedAt: started.toISOString(),
      finishedAt: recoveredAt.toISOString(),
      error: "Scheduler stopped before recording the agent result",
    },
  );

  assert.equal(
    await (await StateStore.open(configPath, { root })).recoverInterrupted(),
    0,
  );
});

test("records successful and failed terminal results", async () => {
  const root = await mkdtemp(join(tmpdir(), "shed-state-result-"));
  const state = await StateStore.open("/project/shed.yml", { root });

  await state.markRunning("review", "2026-07-24T06:30:00.000Z");
  await state.markFinished("review", "2026-07-24T06:30:00.000Z", {
    status: "failed",
    exitCode: 7,
    signal: null,
    error: "agent exited with status 7",
  });

  const result = state.get("review", "2026-07-24T06:30:00.000Z");
  assert.equal(result?.status, "failed");
  assert.equal(result?.exitCode, 7);
  assert.equal(result?.error, "agent exited with status 7");
});

test("allows only one serve lock owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "shed-lock-"));
  const configPath = "/project/shed.yml";
  const lock = await acquireServeLock(configPath, { root });

  await assert.rejects(
    acquireServeLock(configPath, { root }),
    /already owns/,
  );
  await lock.release();

  const nextLock = await acquireServeLock(configPath, { root });
  await nextLock.release();
});

test("safely removes uniquely named locks left by dead processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "shed-stale-lock-"));
  const configPath = "/project/shed.yml";
  const locksDirectory = join(
    stateDirectory(configPath, { root }),
    "locks",
  );
  await mkdir(locksDirectory, { recursive: true });
  await writeFile(
    join(locksDirectory, "serve-dead-stale.lock"),
    `${JSON.stringify({ pid: 2_147_483_647, token: "stale" })}\n`,
  );

  const lock = await acquireServeLock(configPath, { root });
  assert.equal((await readdir(locksDirectory)).length, 1);
  await lock.release();
  assert.deepEqual(await readdir(locksDirectory), []);
});
