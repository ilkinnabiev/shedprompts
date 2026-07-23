import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { serve } from "../src/scheduler.js";
import { StateStore } from "../src/state.js";

test(
  "serve runs an overdue event once and leaves it terminal after restart",
  { skip: process.platform === "win32", timeout: 5_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "shed-serve-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const stateRoot = join(directory, "state");
    const configPath = join(directory, "shed.yml");
    const codexPath = join(directory, "codex");
    const countPath = join(directory, "count");
    const previousPath = process.env.PATH;
    const previousCountPath = process.env.SHED_TEST_COUNT;

    await writeFile(
      codexPath,
      `#!/bin/sh
cat >/dev/null
printf "run\\n" >> "$SHED_TEST_COUNT"
`,
    );
    await chmod(codexPath, 0o755);
    await writeFile(
      configPath,
      `version: 1
tasks:
  review:
    at: 2020-01-01T00:00:00Z
    agent: codex
    prompt: Review this
`,
    );
    process.env.PATH = `${directory}${delimiter}${previousPath ?? ""}`;
    process.env.SHED_TEST_COUNT = countPath;

    try {
      const first = new AbortController();
      await serve(configPath, {
        pollIntervalMs: 5,
        signal: first.signal,
        state: { root: stateRoot },
        log(message) {
          if (message === "Succeeded review") {
            first.abort();
          }
        },
      });

      assert.equal(await readFile(countPath, "utf8"), "run\n");
      const loaded = await loadConfig(configPath);
      const task = loaded.tasks.review;
      assert.ok(task);
      assert.equal(
        (
          await StateStore.open(loaded.path, { root: stateRoot })
        ).get(task.id, task.atIso)?.status,
        "succeeded",
      );

      const second = new AbortController();
      const timer = setTimeout(() => second.abort(), 30);
      await serve(configPath, {
        pollIntervalMs: 5,
        signal: second.signal,
        state: { root: stateRoot },
        log() {},
      });
      clearTimeout(timer);

      assert.equal(await readFile(countPath, "utf8"), "run\n");
    } finally {
      restoreEnvironment("PATH", previousPath);
      restoreEnvironment("SHED_TEST_COUNT", previousCountPath);
    }
  },
);

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
