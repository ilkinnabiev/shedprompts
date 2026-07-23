import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";

export type AgentName = "codex" | "opencode" | "pi";

export interface AgentTask {
  agent: AgentName;
  cwd: string;
  prompt: string;
  args?: readonly string[];
}

export interface AgentInvocation {
  command: AgentName;
  args: string[];
  stdin?: string;
}

export interface AgentRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface ExecutableLookupOptions {
  path?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
}

export function buildAgentInvocation(task: AgentTask): AgentInvocation {
  const extra = [...(task.args ?? [])];

  switch (task.agent) {
    case "codex":
      return {
        command: "codex",
        args: ["exec", ...extra, "-"],
        stdin: task.prompt,
      };
    case "opencode":
      return {
        command: "opencode",
        args: ["run", ...extra],
        stdin: task.prompt,
      };
    case "pi":
      return {
        command: "pi",
        args: [...extra, "--print"],
        stdin: task.prompt,
      };
  }
}

export function runAgent(task: AgentTask): Promise<AgentRunResult> {
  const invocation = buildAgentInvocation(task);

  return new Promise((resolve) => {
    let settled = false;
    let inputError: Error | undefined;
    const finish = (result: AgentRunResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    try {
      const child = spawn(invocation.command, invocation.args, {
        cwd: task.cwd,
        env: process.env,
        shell: false,
        stdio: [
          invocation.stdin === undefined ? "inherit" : "pipe",
          "inherit",
          "inherit",
        ],
      });

      child.once("error", (error) => {
        finish({ code: null, signal: null, error });
      });
      child.once("close", (code, signal) => {
        finish({
          code,
          signal,
          ...(inputError ? { error: inputError } : {}),
        });
      });

      if (invocation.stdin !== undefined) {
        child.stdin?.once("error", (error) => {
          inputError = error;
          child.kill();
        });
        child.stdin?.end(invocation.stdin);
      }
    } catch (error) {
      finish({
        code: null,
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  });
}

export async function findExecutable(
  command: string,
  options: ExecutableLookupOptions = {},
): Promise<string | null> {
  if (command.length === 0) {
    return null;
  }

  const platform = options.platform ?? process.platform;
  const configuredPath = options.path ?? process.env.PATH ?? "";
  const hasDirectory = command.includes("/") || command.includes("\\");
  const directories = hasDirectory
    ? [""]
    : configuredPath === ""
      ? []
      : configuredPath.split(platform === "win32" ? ";" : ":");
  const extensions =
    platform === "win32" && extname(command) === ""
      ? (options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const filename = `${command}${extension}`;
      const candidate = directory === "" ? filename : join(directory, filename);

      try {
        await access(
          candidate,
          platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        if ((await stat(candidate)).isFile()) {
          return candidate;
        }
      } catch {
        // Keep searching PATH.
      }
    }
  }

  return null;
}

export async function isAgentAvailable(
  agent: AgentName,
  options: ExecutableLookupOptions = {},
): Promise<boolean> {
  return (await findExecutable(agent, options)) !== null;
}
