#!/usr/bin/env node
/** zmzai-agent CLI (M5 §5): run the framework standalone with zero product
 *  coupling — JSONL store, FS workspace, subprocess sandbox, OpenAI provider.
 *
 *   zmzai-agent serve [--port 3011] [--data-dir ./.fw-data] [--workspace ./ws]
 *   zmzai-agent run "<prompt>" [--workspace ./ws] [--agent default] [--model gpt-4o]
 */
import { createServer, createJsonlSessionStore, createMemoryEventLog, subscribeEventLog } from "./index.js";
import { createFsWorkspaceFiles } from "./adapters/fs-workspace.js";
import { createOpenAiModelProvider } from "./adapters/openai-provider.js";
import { createSubprocessSandbox } from "./adapters/subprocess-sandbox.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      out[key] = next && !next.startsWith("--") ? next : "true";
      if (next && !next.startsWith("--")) index++;
    }
  }
  return out;
}

function buildServer(args: Record<string, string>) {
  const dataDir = args["data-dir"] ?? "./.fw-data";
  const workspaceRoot = args["workspace"] ?? "./.fw-workspace";
  const store = createJsonlSessionStore({ dataDir });
  const eventLog = createMemoryEventLog();
  const modelProvider = createOpenAiModelProvider();
  const workspaceFor = () => createFsWorkspaceFiles({ root: workspaceRoot });
  return createServer({
    store,
    eventLog,
    modelProvider,
    workspaceFor,
    sandbox: createSubprocessSandbox(),
    subagentDepth: 1,
  });
}

async function runOnce(args: Record<string, string>): Promise<void> {
  const prompt = args._prompt ?? args.prompt;
  if (!prompt) {
    console.error("用法: zmzai-agent run \"<prompt>\" [--workspace ./ws] [--agent default]");
    process.exit(1);
  }
  const fw = buildServer(args);
  const session = await fw.createSession({
    userId: "cli",
    workspaceId: "cli",
    agent: args.agent ?? "default",
    model: { providerId: "openai", modelId: args.model ?? process.env.OPENAI_MODEL ?? "gpt-4o" },
  });
  console.log(`[session] ${session.id}`);
  const events: string[] = [];
  const collectPromise = (async () => {
    for await (const event of subscribeEventLog(fw.eventLog, session.id)) {
      if (event.type === "message.part.delta") {
        const delta = (event.data as { delta?: string }).delta ?? "";
        if (delta) process.stdout.write(delta);
      }
      if (event.type === "session.status") {
        const status = (event.data as { status?: string }).status;
        if (status === "idle") events.push("idle");
      }
      if (event.type === "session.error") events.push("error");
    }
  })();
  await fw.runner.prompt(session.id, { text: prompt, agent: args.agent });
  // Wait for the run to settle: subscribeEventLog streams forever, so watch
  // for the idle/error status events, then let the collector finish flushing.
  while (!events.includes("idle") && !events.includes("error")) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  void collectPromise;
  console.log(events.includes("error") ? "\n[run] 失败" : "\n[run] 完成");
  process.exit(events.includes("error") ? 1 : 0);
}

async function serve(args: Record<string, string>): Promise<void> {
  const port = Number.parseInt(args.port ?? "3011", 10);
  const fw = buildServer(args);
  const { createServer: createHttp } = await import("node:http");

  const server = createHttp(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const sessionIdMatch = /^\/sessions\/([^/]+)$/.exec(url.pathname);
    const promptMatch = /^\/sessions\/([^/]+)\/prompt$/.exec(url.pathname);
    const eventsMatch = /^\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // POST /sessions { workspaceId, model, prompt? }
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = JSON.parse(await readBody(req)) as { workspaceId?: string; model?: string; prompt?: string; agent?: string };
      const session = await fw.createSession({
        userId: "cli",
        workspaceId: body.workspaceId ?? "cli",
        agent: body.agent,
        model: { providerId: "openai", modelId: body.model ?? process.env.OPENAI_MODEL ?? "gpt-4o" },
      });
      if (body.prompt) {
        await fw.runner.prompt(session.id, { text: body.prompt, agent: body.agent });
      }
      json(201, { session });
      return;
    }
    // GET /sessions/:id
    if (req.method === "GET" && sessionIdMatch) {
      const session = await fw.store.getSession(sessionIdMatch[1]!);
      const messages = await fw.store.getMessages(sessionIdMatch[1]!);
      json(200, { session, messages });
      return;
    }
    // POST /sessions/:id/prompt
    if (req.method === "POST" && promptMatch) {
      const body = JSON.parse(await readBody(req)) as { text: string; agent?: string };
      const result = await fw.runner.prompt(promptMatch[1]!, { text: body.text, agent: body.agent });
      json(202, result);
      return;
    }
    // GET /sessions/:id/events (SSE)
    if (req.method === "GET" && eventsMatch) {
      res.writeHead(200, {
        ...cors,
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const sessionId = eventsMatch[1]!;
      const controller = new AbortController();
      const signal = controller.signal;
      req.on("close", () => controller.abort());
      (async () => {
        for await (const event of subscribeEventLog(fw.eventLog, sessionId, { signal })) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
        res.end();
      })();
      return;
    }
    json(404, { error: "not found" });
  });

  server.listen(port, () => {
    console.log(`zmzai-agent serve: http://localhost:${port}`);
    console.log(`  数据目录: ${args["data-dir"] ?? "./.fw-data"}  workspace: ${args["workspace"] ?? "./.fw-workspace"}`);
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const positional = rest.find((arg) => !arg.startsWith("--"));
  if (positional) args["_prompt"] = positional;
  if (command === "serve") {
    await serve(args);
  } else if (command === "run") {
    await runOnce(args);
  } else {
    console.error("用法: zmzai-agent <serve|run> [options]");
    process.exit(1);
  }
}

void main();
