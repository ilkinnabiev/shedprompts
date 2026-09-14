import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addTask,
  ConfigConflictError,
  ConfigError,
  loadConfig,
} from "../src/config.js";

test("atomically appends a valid task while preserving YAML comments", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "shed-config-write-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "shed.yml");
  await writeFile(
    path,
    `# keep this operator note
version: 1
tasks:
  existing:
    at: 2099-07-24T09:30:00Z
    agent: pi
    prompt: Existing work
`,
  );
  if (process.platform !== "win32") {
    await chmod(path, 0o640);
  }
  const before = await loadConfig(path);

  const after = await addTask(
    path,
    {
      id: "review-api",
      at: "2099-08-01T10:15:00.000Z",
      agent: "codex",
      prompt: "Review the current diff.",
      args: ["--sandbox", "workspace-write"],
    },
    before.revision,
  );

  assert.match(await readFile(path, "utf8"), /# keep this operator note/);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(Object.keys(after.tasks), ["existing", "review-api"]);
  assert.deepEqual(after.tasks["review-api"]?.args, [
    "--sandbox",
    "workspace-write",
  ]);
  assert.equal((await loadConfig(path)).tasks["review-api"]?.agent, "codex");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o640);
  }
});

test("failed additions leave the configuration byte-for-byte unchanged", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "shed-config-conflict-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "shed.yml");
  const source = `version: 1
tasks:
  existing:
    at: 2099-07-24T09:30:00Z
    agent: pi
    prompt: Existing work
`;
  await writeFile(path, source);
  const config = await loadConfig(path);

  await assert.rejects(
    addTask(
      path,
      {
        id: "existing",
        at: "2099-08-01T10:15:00Z",
        agent: "pi",
        prompt: "Duplicate",
      },
      config.revision,
    ),
    ConfigConflictError,
  );
  await assert.rejects(
    addTask(
      path,
      {
        id: "bad-cwd",
        at: "2099-08-01T10:15:00Z",
        agent: "pi",
        cwd: "./missing",
        prompt: "Cannot run here",
      },
      config.revision,
    ),
    ConfigError,
  );
  await assert.rejects(
    addTask(
      path,
      {
        id: "stale",
        at: "2099-08-01T10:15:00Z",
        agent: "pi",
        prompt: "Stale edit",
      },
      "0".repeat(64),
    ),
    ConfigConflictError,
  );

  assert.equal(await readFile(path, "utf8"), source);
});

test("rejects a write while another Shed writer owns the config lock", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "shed-config-lock-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "shed.yml");
  const source = "version: 1\ntasks: {}\n";
  await writeFile(path, source);
  const config = await loadConfig(path);
  const locksDirectory = join(directory, ".shed.yml.shed-write-locks");
  await mkdir(locksDirectory);
  await writeFile(
    join(locksDirectory, "write-live.lock"),
    `${JSON.stringify({ pid: process.pid })}\n`,
  );

  await assert.rejects(
    addTask(
      path,
      {
        id: "blocked",
        at: "2099-08-01T10:15:00Z",
        agent: "pi",
        prompt: "Do not overwrite",
      },
      config.revision,
    ),
    (error: unknown) =>
      error instanceof ConfigConflictError &&
      /another configuration update is in progress/.test(error.message),
  );
  assert.equal(await readFile(path, "utf8"), source);
});
