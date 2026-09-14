import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isAgentAvailable } from "./agents.js";
import {
  addTask,
  ConfigConflictError,
  ConfigError,
  loadConfig,
  type AgentName,
  type ShedConfig,
  type TaskDraft,
} from "./config.js";
import { StateStore, type StateOptions } from "./state.js";

const HOST = "127.0.0.1";
const AGENTS: AgentName[] = ["codex", "opencode", "pi"];
const MAX_BODY_BYTES = 64 * 1024;

interface StaticAsset {
  body: string;
  contentType: string;
}

interface RequestContext {
  configPath: string;
  host: string;
  origin: string;
  token: string;
  assets: Map<string, StaticAsset>;
  state: StateOptions;
  agentAvailable: (agent: AgentName) => Promise<boolean>;
  enqueueWrite: (
    operation: () => Promise<ShedConfig>,
  ) => Promise<ShedConfig>;
}

export interface UiOptions {
  port?: number;
  token?: string;
  state?: StateOptions;
  agentAvailable?: (agent: AgentName) => Promise<boolean>;
}

export interface UiServer {
  origin: string;
  url: string;
  done: Promise<void>;
  close(): Promise<void>;
}

export async function startUi(
  inputPath: string,
  options: UiOptions = {},
): Promise<UiServer> {
  const port = options.port ?? 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid UI port: ${String(port)}`);
  }
  await createConfigIfMissing(inputPath);
  const initial = await loadConfig(inputPath);

  const token = options.token ?? randomBytes(24).toString("base64url");
  const assets = await loadAssets();
  let writeQueue: Promise<void> = Promise.resolve();
  const enqueueWrite = (
    operation: () => Promise<ShedConfig>,
  ): Promise<ShedConfig> => {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const context: RequestContext = {
    configPath: initial.path,
    host: "",
    origin: "",
    token,
    assets,
    state: options.state ?? {},
    agentAvailable: options.agentAvailable ?? isAgentAvailable,
    enqueueWrite,
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response, context).catch((error: unknown) => {
      sendError(response, error);
    });
  });
  await listen(server, port);

  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("UI server did not receive a TCP address");
  }
  context.host = `${HOST}:${address.port}`;
  context.origin = `http://${context.host}`;

  return {
    origin: context.origin,
    url: `${context.origin}/#${token}`,
    done: new Promise((resolveDone) => server.once("close", resolveDone)),
    close: () => close(server),
  };
}

async function createConfigIfMissing(path: string): Promise<void> {
  try {
    await writeFile(path, "version: 1\ntasks: {}\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      throw error;
    }
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  if (request.headers.host !== context.host) {
    throw new HttpError(403, "Invalid Host header");
  }
  const url = new URL(request.url ?? "/", `http://${HOST}`);

  if (
    url.pathname.startsWith("/api/") &&
    request.headers["x-shed-token"] !== context.token
  ) {
    throw new HttpError(403, "Invalid UI session token");
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(
      response,
      200,
      await snapshot(
        context.configPath,
        context.state,
        context.agentAvailable,
      ),
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    if (request.headers.origin !== context.origin) {
      throw new HttpError(403, "Invalid Origin header");
    }
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.trim() !==
      "application/json"
    ) {
      throw new HttpError(415, "Expected application/json");
    }

    const { draft, revision } = parseCreateRequest(await readJson(request));
    const scheduledAt = new Date(draft.at);
    if (
      Number.isNaN(scheduledAt.valueOf()) ||
      scheduledAt.getTime() <= Date.now()
    ) {
      throw new HttpError(400, "at must be a future timestamp");
    }
    if (!(await context.agentAvailable(draft.agent))) {
      throw new HttpError(
        400,
        `Agent executable not found on PATH: ${draft.agent}`,
      );
    }

    const config = await context.enqueueWrite(() =>
      addTask(context.configPath, draft, revision),
    );
    const task = config.tasks[draft.id];
    if (!task) {
      throw new Error("Task was written but could not be loaded");
    }
    sendJson(response, 201, {
      revision: config.revision,
      task: {
        ...task,
        at: task.atIso,
        status: "pending",
      },
    });
    return;
  }

  if (url.pathname === "/api/tasks") {
    response.setHeader("Allow", "GET, POST");
    throw new HttpError(405, "Method not allowed");
  }

  if (request.method === "GET") {
    const asset = context.assets.get(url.pathname);
    if (asset) {
      send(response, 200, asset.body, asset.contentType);
      return;
    }
  }

  throw new HttpError(404, "Not found");
}

async function snapshot(
  configPath: string,
  stateOptions: StateOptions,
  agentAvailable: (agent: AgentName) => Promise<boolean>,
) {
  const config = await loadConfig(configPath);
  const [state, availability] = await Promise.all([
    StateStore.open(config.path, stateOptions),
    Promise.all(
      AGENTS.map(async (agent) => [agent, await agentAvailable(agent)] as const),
    ),
  ]);

  return {
    config: {
      path: config.path,
      directory: config.directory,
      revision: config.revision,
    },
    agents: Object.fromEntries(availability),
    now: new Date().toISOString(),
    tasks: Object.values(config.tasks)
      .sort(
        (left, right) =>
          left.at.getTime() - right.at.getTime() ||
          left.id.localeCompare(right.id),
      )
      .map((task) => {
        const event = state.get(task.id, task.atIso);
        return {
          id: task.id,
          at: task.atIso,
          agent: task.agent,
          cwd: task.cwd,
          prompt: task.prompt,
          args: task.args,
          status: event?.status ?? "pending",
          ...(event?.error !== undefined ? { error: event.error } : {}),
        };
      }),
  };
}

function parseCreateRequest(value: unknown): {
  draft: TaskDraft;
  revision: string;
} {
  if (!isRecord(value)) {
    throw new HttpError(400, "Request body must be an object");
  }

  const allowed = new Set([
    "revision",
    "id",
    "at",
    "agent",
    "cwd",
    "prompt",
    "args",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new HttpError(400, `Unknown field ${JSON.stringify(key)}`);
    }
  }

  const { revision, id, at, agent, cwd, prompt, args } = value;
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new HttpError(400, "revision must be a configuration revision");
  }
  if (typeof id !== "string") {
    throw new HttpError(400, "id must be a string");
  }
  if (typeof at !== "string") {
    throw new HttpError(400, "at must be a string");
  }
  if (agent !== "codex" && agent !== "opencode" && agent !== "pi") {
    throw new HttpError(400, "agent must be codex, opencode, or pi");
  }
  if (typeof prompt !== "string") {
    throw new HttpError(400, "prompt must be a string");
  }
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new HttpError(400, "cwd must be a string");
  }
  if (
    args !== undefined &&
    (!Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string"))
  ) {
    throw new HttpError(400, "args must be an array of strings");
  }

  const draft: TaskDraft = { id, at, agent, prompt };
  if (cwd !== undefined) {
    draft.cwd = cwd;
  }
  if (args !== undefined) {
    draft.args = [...args];
  }
  return { draft, revision };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

async function loadAssets(): Promise<Map<string, StaticAsset>> {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "ui",
  );
  const [html, css, javascript] = await Promise.all([
    readFile(resolve(root, "index.html"), "utf8"),
    readFile(resolve(root, "styles.css"), "utf8"),
    readFile(resolve(root, "app.js"), "utf8"),
  ]);

  return new Map([
    [
      "/",
      {
        body: html,
        contentType: "text/html; charset=utf-8",
      },
    ],
    [
      "/styles.css",
      { body: css, contentType: "text/css; charset=utf-8" },
    ],
    [
      "/app.js",
      {
        body: javascript,
        contentType: "text/javascript; charset=utf-8",
      },
    ],
  ]);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  let status = 500;
  if (error instanceof HttpError) {
    status = error.status;
  } else if (error instanceof ConfigConflictError) {
    status = 409;
  } else if (error instanceof ConfigError) {
    status = 400;
  }
  sendJson(response, status, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  send(
    response,
    status,
    `${JSON.stringify(value)}\n`,
    "application/json; charset=utf-8",
  );
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("Content-Type", contentType);
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
      } else {
        resolveClose();
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
