import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { startUi } from "../src/ui.js";

test("creates a minimal config when the UI starts without one", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "shed-ui-create-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "shed.yml");

  const server = await startUi(path, {
    port: 0,
    token: "test-token",
    agentAvailable: async () => true,
  });
  context.after(() => server.close());

  assert.equal(await readFile(path, "utf8"), "version: 1\ntasks: {}\n");
  assert.deepEqual(Object.keys((await loadConfig(path)).tasks), []);
});

test("serves the local UI, creates a task, and reloads event state", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "shed-ui-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "shed.yml");
  const stateRoot = join(directory, "state");
  await writeFile(path, "version: 1\ntasks: {}\n");

  const server = await startUi(path, {
    port: 0,
    token: "test-token",
    state: { root: stateRoot },
    agentAvailable: async () => true,
  });
  context.after(() => server.close());

  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Prompt now\./);
  const pattern = /pattern="([^"]+)"/.exec(html)?.[1];
  assert.ok(pattern);
  const taskId = new RegExp(`^(?:${pattern})$`, "v");
  assert.equal(taskId.test("review-api_2.0"), true);
  assert.equal(taskId.test("bad/id"), false);
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /default-src 'none'/,
  );
  assert.doesNotMatch(await (await fetch(server.origin)).text(), /test-token/);

  const unauthenticated = await fetch(`${server.origin}/api/tasks`);
  assert.equal(unauthenticated.status, 403);

  const initialResponse = await fetch(`${server.origin}/api/tasks`, {
    headers: { "X-Shed-Token": "test-token" },
  });
  assert.equal(initialResponse.status, 200);
  const initial = (await initialResponse.json()) as {
    config: { revision: string };
    tasks: unknown[];
  };
  assert.deepEqual(initial.tasks, []);

  const payload = {
    revision: initial.config.revision,
    id: "review-api",
    at: "2099-08-01T10:15:00.000Z",
    agent: "codex",
    prompt: "Review the current diff.",
  };
  const forbidden = await fetch(`${server.origin}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.origin,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(Object.keys((await loadConfig(path)).tasks), []);

  const invalidOrigin = await fetch(`${server.origin}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shed-Token": "test-token",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(invalidOrigin.status, 403);

  const overdue = await fetch(`${server.origin}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.origin,
      "X-Shed-Token": "test-token",
    },
    body: JSON.stringify({
      ...payload,
      id: "too-late",
      at: "2020-01-01T00:00:00.000Z",
    }),
  });
  assert.equal(overdue.status, 400);
  assert.deepEqual(Object.keys((await loadConfig(path)).tasks), []);

  const created = await fetch(`${server.origin}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.origin,
      "X-Shed-Token": "test-token",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(created.status, 201);

  const config = await loadConfig(path);
  const task = config.tasks["review-api"];
  assert.ok(task);
  const state = await StateStore.open(config.path, { root: stateRoot });
  await state.markRunning(task.id, task.atIso);
  await state.markFinished(task.id, task.atIso, {
    status: "succeeded",
    exitCode: 0,
    signal: null,
  });

  const refreshed = (await (
    await fetch(`${server.origin}/api/tasks`, {
      headers: { "X-Shed-Token": "test-token" },
    })
  ).json()) as { tasks: Array<{ id: string; status: string }> };
  assert.deepEqual(
    refreshed.tasks.map(({ id, status }) => ({ id, status })),
    [{ id: "review-api", status: "succeeded" }],
  );
});
