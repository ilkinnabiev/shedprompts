import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  buildAgentInvocation,
  findExecutable,
  isAgentAvailable,
  runAgent,
} from "../src/agents.js";

test("builds the supported agent invocations without a shell", () => {
  const base = {
    cwd: "/tmp/project",
    prompt: "review this",
    args: ["--flag"],
  } as const;

  assert.deepEqual(buildAgentInvocation({ ...base, agent: "codex" }), {
    command: "codex",
    args: ["exec", "--flag", "-"],
    stdin: "review this",
  });
  assert.deepEqual(buildAgentInvocation({ ...base, agent: "opencode" }), {
    command: "opencode",
    args: ["run", "--flag"],
    stdin: "review this",
  });
  assert.deepEqual(buildAgentInvocation({ ...base, agent: "pi" }), {
    command: "pi",
    args: ["--flag", "--print"],
    stdin: "review this",
  });
});

test("finds executable files on PATH and rejects non-executable files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shed-agent-path-"));
  const executable = join(directory, "codex");
  const plainFile = join(directory, "opencode");

  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  await writeFile(plainFile, "not executable\n");

  assert.equal(await findExecutable("codex", { path: directory }), executable);
  assert.equal(await findExecutable("opencode", { path: directory }), null);
  assert.equal(await isAgentAvailable("codex", { path: directory }), true);
  assert.equal(await isAgentAvailable("pi", { path: directory }), false);
});

test("runs codex with argv and prompt on stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shed-agent-run-"));
  const executable = join(directory, "codex");
  const argsFile = join(directory, "args");
  const stdinFile = join(directory, "stdin");
  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.SHED_TEST_ARGS_FILE;
  const previousStdinFile = process.env.SHED_TEST_STDIN_FILE;

  await writeFile(
    executable,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$SHED_TEST_ARGS_FILE"',
      'cat > "$SHED_TEST_STDIN_FILE"',
      "exit 7",
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);

  process.env.PATH = `${directory}${delimiter}${previousPath ?? ""}`;
  process.env.SHED_TEST_ARGS_FILE = argsFile;
  process.env.SHED_TEST_STDIN_FILE = stdinFile;

  try {
    const result = await runAgent({
      agent: "codex",
      cwd: directory,
      prompt: "hello agent",
      args: ["--sandbox", "workspace-write"],
    });

    assert.deepEqual(result, { code: 7, signal: null });
    assert.equal(
      await readFile(argsFile, "utf8"),
      "exec\n--sandbox\nworkspace-write\n-\n",
    );
    assert.equal(await readFile(stdinFile, "utf8"), "hello agent");
  } finally {
    restoreEnvironment("PATH", previousPath);
    restoreEnvironment("SHED_TEST_ARGS_FILE", previousArgsFile);
    restoreEnvironment("SHED_TEST_STDIN_FILE", previousStdinFile);
  }
});

test("returns spawn errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shed-agent-error-"));
  const previousPath = process.env.PATH;
  process.env.PATH = directory;

  try {
    const result = await runAgent({
      agent: "pi",
      cwd: directory,
      prompt: "hello",
    });

    assert.equal(result.code, null);
    assert.equal(result.signal, null);
    assert.ok(result.error instanceof Error);
  } finally {
    restoreEnvironment("PATH", previousPath);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
