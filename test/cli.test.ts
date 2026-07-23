import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cliPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.js",
);

test(
  "validates, reports, and manually runs a configured task end to end",
  { skip: process.platform === "win32" },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "shed-cli-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const binaryDirectory = join(directory, "bin");
    const configPath = join(directory, "shed.yml");
    const promptPath = join(directory, "prompt");
    const codexPath = join(binaryDirectory, "codex");
    await mkdir(binaryDirectory);
    await writeFile(
      codexPath,
      `#!/bin/sh
test "$1" = "exec"
test "$2" = "-"
cat > "$SHED_TEST_PROMPT"
`,
    );
    await chmod(codexPath, 0o755);
    await writeFile(
      configPath,
      `version: 1
tasks:
  review:
    at: 2099-07-24T09:30:00Z
    agent: codex
    prompt: Review this
`,
    );

    const env = {
      ...process.env,
      PATH: `${binaryDirectory}${delimiter}${process.env.PATH ?? ""}`,
      SHED_TEST_PROMPT: promptPath,
      XDG_STATE_HOME: join(directory, "state"),
    };

    const validated = await execute(
      process.execPath,
      [cliPath, "-c", configPath, "validate"],
      { env },
    );
    assert.match(validated.stdout, /1 task\(s\) valid/);

    const status = await execute(
      process.execPath,
      [cliPath, "-c", configPath, "status"],
      { env },
    );
    assert.match(status.stdout, /review\t.*\tcodex\tpending/);

    await execute(
      process.execPath,
      [cliPath, "-c", configPath, "run", "review"],
      { env },
    );
    assert.equal(await readFile(promptPath, "utf8"), "Review this");

    const statusAfterRun = await execute(
      process.execPath,
      [cliPath, "-c", configPath, "status"],
      { env },
    );
    assert.match(statusAfterRun.stdout, /review\t.*\tcodex\tpending/);
  },
);
