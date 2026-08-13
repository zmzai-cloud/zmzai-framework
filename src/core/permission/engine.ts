import { newPermissionRequestId } from "../session/ids.js";
import { evaluateRules, type Action, type Ruleset } from "../permission/ruleset.js";

/** Permission engine (spec §5.2/§5.3). The single choke point for every
 *  dangerous operation: SessionRunner wires `ask()` into PI's beforeToolCall.
 *
 *  - allow-all patterns short-circuit without emitting any event
 *  - otherwise a PermissionRequest is published (`permission.asked`) and the
 *    caller is suspended on a Deferred until `reply()` resolves it
 *  - "always" stamps an allow rule onto the session ruleset and auto-resolves
 *    other pending requests in the same session now covered by it
 *  - "reject" throws RejectedError back into the tool call (fed to the model)
 */

export type Reply = "once" | "always" | "reject";

export type PermissionRequest = {
  id: string; // per_...
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata?: unknown;
  always: string[]; // patterns stamped into the session ruleset on "always"
  tool?: { messageId: string; callId: string };
};

export class RejectedError extends Error {
  constructor(
    message: string,
    readonly feedback?: string,
  ) {
    super(feedback ? `${message}（用户反馈：${feedback}）` : message);
    this.name = "RejectedError";
  }
}

export type AskInput = {
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata?: unknown;
  always?: string[];
  tool?: { messageId: string; callId: string };
};

type PendingEntry = {
  request: PermissionRequest;
  resolve: (reply: { reply: Reply; feedback?: string }) => void;
};

export type PermissionEngineOptions = {
  /** Called after a request is created; typically publishes permission.asked. */
  onAsked?: (request: PermissionRequest) => void | Promise<void>;
  /** Called when a request resolves; typically publishes permission.replied. */
  onReplied?: (request: PermissionRequest, reply: Reply) => void | Promise<void>;
  /** Persist a session-scoped rule produced by an "always" reply. */
  onSessionRuleAdded?: (sessionId: string, rule: { permission: string; pattern: string; action: Action }) => void | Promise<void>;
};

export class PermissionEngine {
  /** Rulesets in ascending precedence: built-in defaults → agent preset → session. */
  private readonly rulesets: Ruleset[];
  private readonly sessionRules: Ruleset = [];
  private readonly pending = new Map<string, PendingEntry>();
  private disposed = false;
  /** 临时允许缓存：once 批准后同一 run 内相同模式直接放行（F1，避免 Agent
   *  二次调用相同命令时重复打断用户）。run 结束（dispose）时清空，下次 run
   *  重新询问。键 = permission + pattern（bash 的 pattern 即命令原文）。 */
  private readonly onceAllowed = new Set<string>();

  constructor(
    private readonly sessionId: string,
    baseRulesets: Ruleset[],
    sessionRules: Ruleset = [],
    private readonly options: PermissionEngineOptions = {},
  ) {
    this.rulesets = [...baseRulesets, this.sessionRules];
    this.sessionRules.push(...sessionRules);
  }

  private onceKey(permission: string, pattern: string): string {
    return `${permission}\u0000${pattern}`;
  }

  evaluate(permission: string, pattern: string): Action {
    return evaluateRules(this.rulesets, permission, pattern);
  }

  /** Snapshot of the effective session rules (for persistence on reply "always"). */
  get sessionRuleset(): Ruleset {
    return [...this.sessionRules];
  }

  get pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  async ask(input: AskInput): Promise<Reply> {
    if (this.disposed) throw new RejectedError("权限引擎已关闭（服务重启或会话结束），请重试");
    const patterns = input.patterns.length ? input.patterns : ["*"];
    // 已 once 批准的相同模式直接放行，不重复询问。
    const undecided = patterns.filter(
      (pattern) => this.evaluate(input.permission, pattern) !== "allow" && !this.onceAllowed.has(this.onceKey(input.permission, pattern)),
    );
    if (undecided.length === 0) return "once";

    const request: PermissionRequest = {
      id: newPermissionRequestId(),
      sessionId: input.sessionId,
      permission: input.permission,
      patterns: undecided,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      always: input.always ?? [...undecided],
      ...(input.tool ? { tool: input.tool } : {}),
    };

    const decision = new Promise<{ reply: Reply; feedback?: string }>((resolve) => {
      this.pending.set(request.id, { request, resolve });
    });
    await this.options.onAsked?.(request);

    const { reply, feedback } = await decision;
    await this.options.onReplied?.(request, reply);

    if (reply === "reject") {
      throw new RejectedError(`权限被拒绝：${input.permission} ${undecided.join(", ")}`, feedback);
    }
    if (reply === "once") {
      // F1：本 run 内相同命令/模式不再询问。
      for (const pattern of request.patterns) this.onceAllowed.add(this.onceKey(input.permission, pattern));
    }
    if (reply === "always") {
      for (const pattern of request.always) {
        const rule = { permission: input.permission, pattern, action: "allow" as const };
        this.sessionRules.push(rule);
        await this.options.onSessionRuleAdded?.(input.sessionId, rule);
      }
      // Auto-resolve other pending requests in this session now fully covered.
      for (const [id, entry] of [...this.pending]) {
        const covered = entry.request.patterns.every((pattern) => this.evaluate(entry.request.permission, pattern) === "allow");
        if (covered) {
          this.pending.delete(id);
          entry.resolve({ reply: "always" });
          await this.options.onReplied?.(entry.request, "always");
        }
      }
    }
    return reply;
  }

  /** Resolves a pending request. Returns false when the id is unknown (already
   *  resolved or session restarted — callers map that to a 404/conflict). */
  reply(requestId: string, reply: Reply, feedback?: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve({ reply, feedback });
    return true;
  }

  /** Rejects everything still pending — used on abort and process teardown so
   *  tool calls never hang forever (spec §5.4: restart semantics). Also clears
   *  the once-allowed cache so the next run asks again. */
  dispose(reason = "会话已中止或服务重启，请重试"): void {
    this.disposed = true;
    for (const [, entry] of [...this.pending]) {
      entry.resolve({ reply: "reject", feedback: reason });
    }
    this.pending.clear();
    this.onceAllowed.clear();
  }
}
