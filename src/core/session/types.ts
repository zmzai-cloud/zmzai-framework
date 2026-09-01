import type { Ruleset } from "../permission/ruleset.js";

/** v0 wire format (spec §2). These types are the framework's public contract:
 *  every client (web workbench, future TUI, SDK) renders from them. */

export type ModelRef = { providerId: string; modelId: string };

/** 推理力度档位（relay reasoning_effort）：off = 不发送该字段（默认，对所有模型安全）。 */
export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high";

export type QueuedPrompt = { text: string; agent?: string; effort?: ThinkingEffort; enqueuedAt: string };

export type SessionInfo = {
  id: string; // ses_...
  workspaceId: string; // §13.1: bound at creation, immutable
  userId: string;
  parentId?: string; // child session spawned by the task tool
  title: string; // prompt truncation initially; replaced async by cheap-model title (§13.2)
  agent: string; // current primary agent preset name
  /** Product control plane identity. Absent on M1-M5 sessions created before
   *  versioned agents; new cloud sessions should pin both fields. */
  agentId?: string;
  agentVersionId?: string;
  model: ModelRef;
  permission: Ruleset; // session-scoped rules ("always" replies land here)
  /** 子代理写路径白名单（WritePathSet，07-subagent retrofit）：声明后 write/edit
   *  被圈禁在白名单内（权限层 deny 兜底 + workspace 门面结构性抛错），
   *  未声明则不限制。 */
  writePaths?: string[];
  queuedPrompts: QueuedPrompt[]; // FIFO for prompts submitted while running (§13.3)
  /** 运行租约（spec §3.2）：runner 持有 run 时盖章（owner + 过期时间），run 结束清除。
   *  进程崩溃/重启后租约遗留，lease recovery 扫描过期租约并收尾中断的运行。 */
  leaseOwner?: string;
  leaseExpiresAt?: string;
  /** 最近一次 run 的终态（N5）：completed/aborted/error。run 收尾时写回，
   *  供会话列表渲染三态（完成/中断/失败）而无需逐会话查 eventLog。 */
  lastOutcome?: "completed" | "aborted" | "error";
  /** 会话置顶（N6）：列表置顶展示（true 时排最前）。 */
  pinned?: boolean;
  /** 会话归档（N6）：归档后从默认列表隐藏（列表切换「已归档」视图查看）。 */
  archived?: boolean;
  time: { created: string; updated: string; archived?: string };
};

export type MessageInfo =
  | {
      id: string; // msg_...
      sessionId: string;
      role: "user";
      agent: string;
      model: ModelRef;
      time: { created: string };
    }
  | {
      id: string;
      sessionId: string;
      role: "assistant";
      parentId: string; // the user message that triggered it
      agent: string;
      model: ModelRef;
      error?: { name: string; message: string };
      tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
      time: { created: string; completed?: string };
    };

export type ToolState =
  | { status: "pending"; input: unknown }
  | { status: "running"; input: unknown; title?: string; time: { start: string } }
  | {
      status: "completed";
      input: unknown;
      output: string;
      title: string;
      metadata?: Record<string, unknown>;
      time: { start: string; end: string };
    }
  | { status: "error"; input: unknown; error: string; metadata?: Record<string, unknown>; time: { start: string; end: string } };

type PartBase = { id: string; sessionId: string; messageId: string };

export type Part = PartBase &
  (
    | { type: "text"; text: string; synthetic?: boolean }
    | { type: "reasoning"; text: string }
    | { type: "tool"; callId: string; tool: string; state: ToolState }
    | { type: "step-start" }
    | { type: "step-finish"; tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }
    | { type: "subtask"; prompt: string; description: string; agent: string; childSessionId: string }
    | { type: "file"; mime: string; filename: string; url: string }
    | { type: "image"; url: string; mediaType: string; alt?: string }
    | { type: "compaction"; summary: string }
  );

export type MessageWithParts = { info: MessageInfo; parts: Part[] };

export type SessionStatus = "idle" | "running" | "waiting_permission" | "waiting_input";
