// 测试用最小 MCP stdio server（NDJSON JSON-RPC）。不依赖任何包。
// 行为：initialize 握手、tools/list 翻页（echo 在第 1 页、fail 在第 2 页）、
// tools/call：echo 返回 "echo:<msg>"，fail 返回 isError=true。
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "回显输入消息",
    inputSchema: {
      type: "object",
      properties: { msg: { type: "string", description: "要回显的内容" } },
      required: ["msg"],
    },
  },
  {
    name: "fail",
    description: "总是返回业务失败",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  },
];

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (frame.jsonrpc !== "2.0") return;
  // 通知（无 id）一律忽略。
  if (frame.id === undefined || frame.id === null) return;
  switch (frame.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: frame.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "echo-fixture", version: "0.0.1" },
        },
      });
      break;
    case "tools/list": {
      const page = frame.params?.cursor ? TOOLS.slice(1) : TOOLS.slice(0, 1);
      send({
        jsonrpc: "2.0",
        id: frame.id,
        result: { tools: page, ...(frame.params?.cursor ? {} : { nextCursor: "page-2" }) },
      });
      break;
    }
    case "tools/call": {
      if (frame.params?.name === "echo") {
        const msg = frame.params?.arguments?.msg;
        send({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            content: [{ type: "text", text: `echo:${String(msg)}` }],
            isError: false,
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id: frame.id,
          result: { content: [{ type: "text", text: "boom" }], isError: true },
        });
      }
      break;
    }
    default:
      send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } });
  }
});
process.on("SIGTERM", () => process.exit(0));
