import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBuilder } from "./context-builder.js";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import type { SessionStore } from "../session/store.js";

/** W7-S6 的 TOCTOU 钉死测试（设计 §2.2）：排除集与消息必须同拍读取。
 *  旧代码在 runLoop 里先读 workflowRuns、下一拍才 getMessages——两拍之间的
 *  新提交会泄入运行中 run 的上下文（W6 §8 插桩证实）。本测试钉住机制而不是
 *  时序：快照之后的提交对「用该快照重建的上下文」天然不可见。 */
describe("ContextBuilder.historySnapshot（同拍快照）", () => {
  it("快照之后的提交不泄入本次重建；快照自身则覆盖新提交", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ctx-toctou-"));
    try {
      const store = createSqliteSessionStore({ dataDir });
      const session = {
        id: "s1", userId: "u", workspaceId: "w", agent: "default",
        model: { providerId: "faux", modelId: "m" }, permission: [], queuedPrompts: [],
        time: { created: "2026-09-01T00:00:00.000Z", updated: "2026-09-01T00:00:00.000Z" },
      } as never;
      await (store as SessionStore).createSession(session);
      const msg = (id: string) => ({
        id, sessionId: "s1", role: "user" as const, agent: "default",
        model: { providerId: "faux", modelId: "m" },
        time: { created: "2026-09-01T00:00:00.000Z" },
      });
      await store.workflow!.acceptPrompt("s1", { requestId: "r1", text: "first" }, { message: msg("m1"), parts: [] });

      const builder = new ContextBuilder({
        store: store as unknown as SessionStore,
        modelFor: () => ({}) as never,
        streamFnFor: () => {
          throw new Error("no stream");
        },
      });
      const snap = await builder.historySnapshot("s1");
      // 快照之后落库的第二条提交（两拍实现里这正是泄漏窗口）
      await store.workflow!.acceptPrompt("s1", { requestId: "r2", text: "future queued user" }, { message: msg("m2"), parts: [] });

      // 用快照重建：新提交不可见——重建消费的是不可变条目集，不重读库
      const history = await builder.rebuildMessages("s1", snap.entries, snap.excludedUserIds);
      expect(JSON.stringify(history)).not.toContain("future queued user");
      expect(JSON.stringify(history)).not.toContain("first");

      // 重新快照则同拍覆盖两条：排除集各含其 user 消息
      const snap2 = await builder.historySnapshot("s1");
      expect([...snap2.excludedUserIds].sort()).toEqual(["m1", "m2"]);
      const history2 = await builder.rebuildMessages("s1", snap2.entries, snap2.excludedUserIds);
      expect(history2).toHaveLength(0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
