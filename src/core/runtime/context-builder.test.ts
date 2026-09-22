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

/** W7-S8 · CompactionStore 跨 Attempt（A30/A31 的 vitest 等价物）：
 *  前缀指纹一致 → 播种复用（不再重摘）；前缀变化 → 放弃复用重新摘要
 *  （宁重复摘要，不脏上下文）。 */
describe("ContextBuilder · CompactionStore 跨 Attempt", () => {
  async function setup() {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ctx-compaction-"));
    const store = createSqliteSessionStore({ dataDir });
    const session = {
      id: "s1", userId: "u", workspaceId: "w", agent: "default",
      model: { providerId: "faux", modelId: "m" }, permission: [], queuedPrompts: [],
      time: { created: "2026-09-01T00:00:00.000Z", updated: "2026-09-01T00:00:00.000Z" },
    } as never;
    await (store as SessionStore).createSession(session);
    let summaryCalls = 0;
    const builder = new ContextBuilder({
      store: store as unknown as SessionStore,
      modelFor: () => ({}) as never,
      streamFnFor: (() => async () => {
        summaryCalls += 1;
        return { result: async () => ({ content: `模拟摘要第${summaryCalls}次` }) };
      }) as never,
      compaction: { enabled: true, contextWindow: 100, summaryModel: { providerId: "faux", modelId: "sum" } as never },
    });
    const parts: { id: string; text: string }[] = [];
    for (let n = 0; n < 12; n += 1) {
      const uid = `u${n}`;
      const aid = `a${n}`;
      await store.appendMessage({ id: uid, sessionId: "s1", role: "user", agent: "default", model: { providerId: "faux", modelId: "m" }, time: { created: "2026-09-01T00:00:00.000Z" } });
      await store.appendPart({ id: `p-${uid}`, sessionId: "s1", messageId: uid, type: "text", text: `用户消息编号${n}的提问内容` });
      await store.appendMessage({ id: aid, sessionId: "s1", role: "assistant", parentId: uid, agent: "default", model: { providerId: "faux", modelId: "m" }, time: { created: "2026-09-01T00:00:01.000Z" } });
      const text = `助手回答编号${n}的处理内容`;
      await store.appendPart({ id: `p-${aid}`, sessionId: "s1", messageId: aid, type: "text", text });
      parts.push({ id: `p-${aid}`, text });
    }
    return { dataDir, store, builder, counter: () => summaryCalls, parts };
  }

  it("前缀一致时播种复用：第二个 Attempt 不再重摘（摘要调用数不增）", async () => {
    const { dataDir, store, builder, counter } = await setup();
    try {
      const attempt1 = await builder.buildAttemptContext({ id: "s1" } as never, { text: "第一轮" }, () => {});
      expect(attempt1.compactionTransform).toBeDefined();
      const out1 = await attempt1.compactionTransform!(attempt1.history);
      expect(counter()).toBe(1);
      expect(store.compaction).toBeDefined();
      const record = await store.compaction!.get("s1");
      expect(record?.anchor).toBeGreaterThan(0);
      expect(String((out1[0] as { content: unknown }).content)).toContain("【早期对话摘要】");

      // 第二个 Attempt：同一 store、无记忆注入 → 前缀逐字节一致 → 播种
      const attempt2 = await builder.buildAttemptContext({ id: "s1" } as never, { text: "第二轮" }, () => {});
      const out2 = await attempt2.compactionTransform!(attempt2.history);
      expect(counter()).toBe(1); // 复用生效：没有第二次摘要调用
      expect(String((out2[0] as { content: unknown }).content)).toContain("【早期对话摘要】");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("前缀变化（覆盖区消息被改）时放弃复用，重新摘要而非沿用脏投影", async () => {
    const { dataDir, store, builder, counter, parts } = await setup();
    try {
      const attempt1 = await builder.buildAttemptContext({ id: "s1" } as never, { text: "第一轮" }, () => {});
      await attempt1.compactionTransform!(attempt1.history);
      expect(counter()).toBe(1);

      // 覆盖区内的一条消息被外部修改（模拟 rewind 后重写/用户编辑）
      await store.updatePart({ id: parts[1]!.id, sessionId: "s1", messageId: "a1", type: "text", text: "被外部改写的回答内容" });

      const attempt3 = await builder.buildAttemptContext({ id: "s1" } as never, { text: "第三轮" }, () => {});
      const out3 = await attempt3.compactionTransform!(attempt3.history);
      expect(counter()).toBe(2); // 指纹失配 → 重新摘要
      expect(String((out3[0] as { content: unknown }).content)).toContain("模拟摘要第2次");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
