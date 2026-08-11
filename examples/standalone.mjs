/**
 * Standalone demo (M5 §7): a third party boots the framework with zero product
 * coupling — JSONL store, FS workspace, subprocess sandbox, OpenAI provider.
 *
 *   OPENAI_BASE_URL=... OPENAI_API_KEY=... node examples/standalone.mjs
 *
 * Prints the framework's answer to a prompt, streaming tokens to stdout.
 */
import {
  createServer,
  createJsonlSessionStore,
  createMemoryEventLog,
  createFsWorkspaceFiles,
  createOpenAiModelProvider,
  createSubprocessSandbox,
  subscribeEventLog,
} from "@zmzai/agent-framework";

// 1. Pick backends (all provided by the package; products swap their own).
const store = createJsonlSessionStore({ dataDir: "./.fw-data" });
const eventLog = createMemoryEventLog();
const modelProvider = createOpenAiModelProvider();
const workspaceFor = () => createFsWorkspaceFiles({ root: "./.fw-workspace" });

// 2. Assemble the framework.
const fw = createServer({
  store,
  eventLog,
  modelProvider,
  workspaceFor,
  sandbox: createSubprocessSandbox(),
  subagentDepth: 1,
});

// 3. Create a session and stream the run.
const session = await fw.createSession({
  userId: "demo",
  workspaceId: "demo",
  model: { providerId: "openai", modelId: process.env.OPENAI_MODEL ?? "gpt-4o" },
});

console.log(`[session] ${session.id}`);

const settle = (async () => {
  for await (const event of subscribeEventLog(eventLog, session.id)) {
    if (event.type === "message.part.delta") {
      const delta = (event.data as { delta?: string }).delta ?? "";
      if (delta) process.stdout.write(delta);
    }
    if (event.type === "session.status" && (event.data as { status?: string }).status === "idle") return;
    if (event.type === "session.error") return;
  }
})();

await fw.runner.prompt(session.id, { text: "你好！用一句话介绍你自己。" });
await settle;
console.log("\n[done]");
process.exit(0);
