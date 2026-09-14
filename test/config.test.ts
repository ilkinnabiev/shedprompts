import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";

async function fixture(
  context: TestContext,
  yaml: string,
): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "shed-config-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "shed.yml");
  await writeFile(path, yaml);
  return { directory, path };
}

test("loads and normalizes a valid config from its canonical path", async (context) => {
  const { directory, path } = await fixture(
    context,
    `version: 1
tasks:
  review-api:
    at: 2026-07-24T09:30:00+03:00
    agent: codex
    prompt: |
      Review the diff.
    args: [--sandbox, workspace-write]
`,
  );
  const alias = join(directory, "alias.yml");
  await symlink(path, alias);

  const config = await loadConfig(alias);

  assert.equal(config.version, 1);
  assert.equal(config.path, await realpath(path));
  assert.equal(config.directory, dirname(await realpath(path)));
  assert.deepEqual(Object.keys(config.tasks), ["review-api"]);
  assert.deepEqual(config.tasks["review-api"], {
    id: "review-api",
    at: new Date("2026-07-24T06:30:00.000Z"),
    atIso: "2026-07-24T06:30:00.000Z",
    agent: "codex",
    cwd: await realpath(directory),
    prompt: "Review the diff.\n",
    args: ["--sandbox", "workspace-write"],
  });
});

test("resolves a relative cwd from the canonical config directory", async (context) => {
  const { directory, path } = await fixture(
    context,
    `version: 1
tasks:
  test:
    at: 2026-07-24T09:30:00Z
    agent: pi
    cwd: ./project
    prompt: Run tests
`,
  );
  await mkdir(join(directory, "project"));

  const config = await loadConfig(path);
  const task = config.tasks.test;

  assert.ok(task);
  assert.equal(task.cwd, await realpath(join(directory, "project")));
  assert.deepEqual(task.args, []);
});

test("rejects duplicate keys and malformed YAML", async (context) => {
  const duplicate = await fixture(
    context,
    `version: 1
version: 1
tasks: {}
`,
  );
  await assert.rejects(
    loadConfig(duplicate.path),
    (error: unknown) =>
      error instanceof ConfigError && /invalid YAML.*unique/i.test(error.message),
  );

  const malformed = await fixture(context, "version: 1\ntasks: [\n");
  await assert.rejects(
    loadConfig(malformed.path),
    (error: unknown) =>
      error instanceof ConfigError && /invalid YAML/i.test(error.message),
  );
});

test("rejects invalid root values", async (context) => {
  const cases = [
    ["wrong version", 'version: "1"\ntasks: {}\n', /version.*exactly 1/i],
    ["missing tasks", "version: 1\n", /missing required field "tasks"/i],
    ["null tasks", "version: 1\ntasks: null\n", /tasks.*non-null mapping/i],
    [
      "unknown root field",
      "version: 1\ntasks: {}\nextra: true\n",
      /config contains unknown field "extra"/i,
    ],
  ] as const;

  for (const [name, yaml, expected] of cases) {
    await context.test(name, async (subcontext) => {
      const { path } = await fixture(subcontext, yaml);
      await assert.rejects(loadConfig(path), expected);
    });
  }
});

test("rejects unresolved YAML tags instead of silently accepting them", async (context) => {
  const { path } = await fixture(context, "version: 1\ntasks: !unknown {}\n");
  await assert.rejects(loadConfig(path), /invalid YAML.*Unresolved tag/i);
});

test("task lookup contains only configured IDs, including prototype names", async (context) => {
  const { path } = await fixture(context, `version: 1
tasks:
  constructor:
    at: 2099-01-01T00:00:00Z
    agent: pi
    prompt: Review this
`);
  const config = await loadConfig(path);
  assert.equal(config.tasks["constructor"]?.id, "constructor");
  assert.equal(config.tasks.toString, undefined);
});

test("rejects invalid task IDs, shapes, and fields", async (context) => {
  const cases = [
    [
      "invalid ID",
      `tasks:
  bad/id: {}
`,
      /task ID "bad\/id" must match/i,
    ],
    [
      "non-string ID",
      `tasks:
  7: {}
`,
      /task ID 7 must match/i,
    ],
    [
      "null task",
      `tasks:
  task: null
`,
      /task "task" must be a non-null mapping/i,
    ],
    [
      "unknown task field",
      `tasks:
  task:
    extra: true
`,
      /task "task" contains unknown field "extra"/i,
    ],
  ] as const;

  for (const [name, tasks, expected] of cases) {
    await context.test(name, async (subcontext) => {
      const { path } = await fixture(subcontext, `version: 1\n${tasks}`);
      await assert.rejects(loadConfig(path), expected);
    });
  }
});

test("rejects invalid required task fields", async (context) => {
  const valid = {
    at: "2026-07-24T09:30:00Z",
    agent: "opencode",
    prompt: "Do the work",
  };
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["missing at", { agent: valid.agent, prompt: valid.prompt }, /missing.*"at"/i],
    ["at type", { ...valid, at: 7 }, /\.at must be a string/i],
    ["missing offset", { ...valid, at: "2026-07-24T09:30:00" }, /RFC 3339/i],
    ["excess precision", { ...valid, at: "2026-07-24T09:30:00.0001Z" }, /RFC 3339/i],
    ["invalid date", { ...valid, at: "2026-02-30T09:30:00Z" }, /not a valid/i],
    ["invalid offset", { ...valid, at: "2026-07-24T09:30:00+24:00" }, /not a valid/i],
    ["bad agent", { ...valid, agent: "unknown" }, /one of codex, opencode, pi, claude/i],
    ["empty prompt", { ...valid, prompt: " \n" }, /prompt must not be empty/i],
    ["args type", { ...valid, args: "--yes" }, /args must be an array/i],
    ["args item", { ...valid, args: ["--yes", 1] }, /array of strings/i],
  ];

  for (const [name, task, expected] of cases) {
    await context.test(name, async (subcontext) => {
      const lines = Object.entries(task)
        .map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)
        .join("\n");
      const { path } = await fixture(
        subcontext,
        `version: 1
tasks:
  task:
${lines}
`,
      );
      await assert.rejects(loadConfig(path), expected);
    });
  }
});

test("rejects a cwd that is missing or not a directory", async (context) => {
  const missing = await fixture(
    context,
    `version: 1
tasks:
  task:
    at: 2026-07-24T09:30:00Z
    agent: codex
    cwd: ./missing
    prompt: Work
`,
  );
  await assert.rejects(loadConfig(missing.path), /cwd must reference an existing directory/i);

  const notDirectory = join(missing.directory, "file");
  await writeFile(notDirectory, "");
  const fileConfig = await fixture(
    context,
    `version: 1
tasks:
  task:
    at: 2026-07-24T09:30:00Z
    agent: codex
    cwd: ${JSON.stringify(notDirectory)}
    prompt: Work
`,
  );
  await assert.rejects(
    loadConfig(fileConfig.path),
    /cwd must reference an existing directory.*not a directory/i,
  );
});
