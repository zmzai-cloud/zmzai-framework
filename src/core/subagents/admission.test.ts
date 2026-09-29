import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { AgentRegistry } from "../agent/registry.js";
import { createFrameworkSession } from "../runtime/runner.js";
import { SubagentCoordinator, createSubagentAdmission, type ChildRunOutcome, type SubagentCoordinatorDeps } from "./coordinator.js";
import { isSubagentTerminal } from "./types.js";

/** T03（production-chain-closure）：子 outcome 结构化传播（PC02）、跨协调器
 *  Host 全局/根限额（PC03）、list/send/wait/cancel 任务树范围校验（PC03/PC07）。
 *
 *  两个协调器 + 两个独立 store 模拟两个项目 Runtime；共享同一个
 *  createSubagentAdmission 实例——「Host 总计 6」必须是全进程一份计数，
 *  不是每项目各 6。 */

function registryWith(): AgentRegistry {
  return new AgentRegistry().derive([
    { name: "explorer", description: "探索", mode: "subagent", steps: 8, prompt: "你是探索代理。", permission: [], model: { providerId: "faux", modelId: "m" } } as never,
  ]);
}

async function bootCoordinator(opts: {
  runMs?: number;
  outcome?: (childId: string) => ChildRunOutcome;
  admission?: SubagentCoordinatorDeps["admission"];
}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "t03-"));
  const store = createSqliteSessionStore({ dataDir });
  const parent = await createFrameworkSession({ store, userId: "u", workspaceId: "ws", model: { providerId: "faux", modelId: "m" } });
  const launches: string[] = [];
  const deps: SubagentCoordinatorDeps = {
    store,
    registry: registryWith(),
    createChildSession: async ({ parent: p, agentType, description, spawnRequestId }) => ({
      id: `ses_c_${spawnRequestId.slice(0, 12)}`, parentId: p.id, userId: p.userId, workspaceId: p.workspaceId, agent: agentType, title: description,
    } as never),
    runChild: async (childId) => {
      launches.push(childId);
      await new Promise((r) => setTimeout(r, opts.runMs ?? 100));
      return opts.outcome?.(childId) ?? { state: "completed", summary: `结论:${childId}` };
    },
    abortChild: async () => {},
    ...(opts.admission ? { admission: opts.admission } : {}),
  };
  return { store, parent, coordinator: new SubagentCoordinator(deps), launches, dataDir };
}

async function waitForStatus(coordinator: SubagentCoordinator, rootTaskId: string, predicate: (statuses: import("./types.js").SubagentStatus[]) => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const list = await coordinator.list(rootTaskId);
    if (predicate(list.map((r) => r.status))) return;
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("T03：子 outcome 传播（PC02）", () => {
  it("runChild 返回 failed → 协调记录落 failed + blockerReason + result.outcome=failed（不伪装 completed）", async () => {
    const ctx = await bootCoordinator({ outcome: () => ({ state: "failed", errorMessage: "401 Unauthorized", summary: "失败：401 Unauthorized" }) });
    try {
      await ctx.coordinator.spawn(ctx.parent, "task_p", "task_root", { description: "失败任务", prompt: "P", subagentType: "explorer" });
      await waitForStatus(ctx.coordinator, "task_root", (st) => st.every((s) => isSubagentTerminal(s)));
      const rec = (await ctx.coordinator.list("task_root"))[0]!;
      expect(rec.status).toBe("failed");
      expect(rec.blockerReason).toContain("401");
      expect(rec.result?.outcome).toBe("failed");
      expect(rec.result?.summary).toContain("401");
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });

  it("completed 带 summary/evidenceRefs 进 result；cancelled/blocked/waiting_* 各落对应状态", async () => {
    // completed + evidence
    const ok = await bootCoordinator({ outcome: () => ({ state: "completed", summary: "探索完成：A→B", evidenceRefs: ["evid://diff/1"] }) });
    try {
      await ok.coordinator.spawn(ok.parent, "task_p", "root_ok", { description: "成功任务", prompt: "P", subagentType: "explorer" });
      await waitForStatus(ok.coordinator, "root_ok", (st) => st.every((s) => isSubagentTerminal(s)));
      const rec = (await ok.coordinator.list("root_ok"))[0]!;
      expect(rec.status).toBe("completed");
      expect(rec.result).toMatchObject({ outcome: "completed", summary: "探索完成：A→B", evidenceRefs: ["evid://diff/1"] });
    } finally {
      await rm(ok.dataDir, { recursive: true, force: true });
    }
    // blocked（unknownSideEffect）：不进终态、blockerReason 明确
    const blocked = await bootCoordinator({ outcome: () => ({ state: "blocked", unknownSideEffect: true }) });
    try {
      await blocked.coordinator.spawn(blocked.parent, "task_p", "root_blocked", { description: "阻塞任务", prompt: "P", subagentType: "explorer" });
      await waitForStatus(blocked.coordinator, "root_blocked", (st) => st.includes("blocked"));
      const rec = (await blocked.coordinator.list("root_blocked"))[0]!;
      expect(rec.status).toBe("blocked");
      expect(rec.blockerReason).toBeTruthy();
      expect(isSubagentTerminal(rec.status)).toBe(false);
    } finally {
      await rm(blocked.dataDir, { recursive: true, force: true });
    }
    // waiting_input：非终态
    const waiting = await bootCoordinator({ outcome: () => ({ state: "waiting_input" }) });
    try {
      await waiting.coordinator.spawn(waiting.parent, "task_p", "root_wait", { description: "等待任务", prompt: "P", subagentType: "explorer" });
      await waitForStatus(waiting.coordinator, "root_wait", (st) => st.includes("waiting_input"));
      const rec = (await waiting.coordinator.list("root_wait"))[0]!;
      expect(rec.status).toBe("waiting_input");
      expect(isSubagentTerminal(rec.status)).toBe(false);
    } finally {
      await rm(waiting.dataDir, { recursive: true, force: true });
    }
  });
});

describe("T03：Host 全局/根限额（PC03，两项目共享 admission）", () => {
  it("两个协调器（两项目）共享全局上限：global=2 时第三个子不启动，释放后接力", async () => {
    const admission = createSubagentAdmission({ perRoot: 3, global: 2 });
    const a = await bootCoordinator({ runMs: 300, admission });
    const b = await bootCoordinator({ runMs: 300, admission });
    try {
      // 项目 A 两发 + 项目 B 一发：全局 2 已满，B 的排队
      await a.coordinator.spawn(a.parent, "task_a", "root_a", { description: "A1", prompt: "P", subagentType: "explorer", spawnRequestId: "t03-a1" });
      await a.coordinator.spawn(a.parent, "task_a", "root_a", { description: "A2", prompt: "P", subagentType: "explorer", spawnRequestId: "t03-a2" });
      await b.coordinator.spawn(b.parent, "task_b", "root_b", { description: "B1", prompt: "P", subagentType: "explorer", spawnRequestId: "t03-b1" });
      await new Promise((r) => setTimeout(r, 120));
      expect(a.launches).toHaveLength(2);
      expect(b.launches).toHaveLength(0); // 全局额度被 A 占满，B 的子排队
      expect(admission.counts().global).toBe(2);
      // 释放后 B 的排队者被 onRelease→pump 唤醒启动
      await waitForStatus(b.coordinator, "root_b", (st) => st.includes("completed"));
      expect(b.launches).toHaveLength(1);
      // 全部终态后计数归零
      await waitForStatus(a.coordinator, "root_a", (st) => st.every((s) => isSubagentTerminal(s)));
      expect(admission.counts().global).toBe(0);
    } finally {
      await rm(a.dataDir, { recursive: true, force: true });
      await rm(b.dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("perRoot 上限跨根计数：同根第 4 个排队，另一根不受影响", async () => {
    const admission = createSubagentAdmission({ perRoot: 2, global: 6 });
    const a = await bootCoordinator({ runMs: 250, admission });
    try {
      for (let i = 1; i <= 4; i += 1) {
        await a.coordinator.spawn(a.parent, "task_a", "root_main", { description: `M${i}`, prompt: "P", subagentType: "explorer", spawnRequestId: `t03-m${i}` });
      }
      await a.coordinator.spawn(a.parent, "task_b", "root_other", { description: "O1", prompt: "P", subagentType: "explorer", spawnRequestId: "t03-o1" });
      await new Promise((r) => setTimeout(r, 120));
      // perRoot=2：root_main 只跑 2 个；root_other 不占 root_main 的根额度
      const mainRunning = (await a.coordinator.list("root_main")).filter((r) => r.status === "running").length;
      const otherRunning = (await a.coordinator.list("root_other")).filter((r) => r.status === "running").length;
      expect(mainRunning).toBe(2);
      expect(otherRunning).toBe(1);
      // 全部落终态（排队的接力执行）
      await waitForStatus(a.coordinator, "root_main", (st) => st.every((s) => isSubagentTerminal(s)), 10_000);
      const main = await a.coordinator.list("root_main");
      expect(main).toHaveLength(4);
      expect(main.every((r) => r.status === "completed")).toBe(true);
    } finally {
      await rm(a.dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("T03：任务树范围校验（PC03/PC07）", () => {
  it("send/wait/cancel 拒绝树外 childId（CHILD_OUT_OF_SCOPE / SCOPE_VIOLATION）", async () => {
    const mine = await bootCoordinator({ runMs: 400 });
    try {
      // 同一 store 内的另一棵树（跨项目库本就互相不可见——CHILD_NOT_FOUND；
      // 范围校验针对的是同库不同根的越权访问）
      const foreign = await mine.coordinator.spawn(mine.parent, "task_x", "root_foreign", { description: "别的树", prompt: "P", subagentType: "explorer", spawnRequestId: "t03-foreign" });
      // send：树外拒绝
      const sent = await mine.coordinator.send(foreign.childId, "越权消息", "constraint", "11111111-1111-4111-8111-111111111111", { rootTaskId: "root_mine" });
      expect(sent).toMatchObject({ delivered: false, reason: "CHILD_OUT_OF_SCOPE" });
      // wait：树外抛 SCOPE_VIOLATION（不泄露其它树的状态）
      await expect(mine.coordinator.wait([foreign.childId], 100, { rootTaskId: "root_mine" })).rejects.toThrow("SCOPE_VIOLATION");
      // cancel：树外拒绝
      const cancelled = await mine.coordinator.cancel(foreign.childId, { rootTaskId: "root_mine" });
      expect(cancelled).toMatchObject({ cancelling: false, reason: "CHILD_OUT_OF_SCOPE" });
      // 对照：树内（同根）正常投递
      const own = await mine.coordinator.spawn(mine.parent, "task_m", "root_mine", { description: "本树", prompt: "P", subagentType: "explorer" });
      const ownSent = await mine.coordinator.send(own.childId, "约束", "constraint", "22222222-2222-4222-8222-222222222222", { rootTaskId: "root_mine" });
      expect(ownSent).toMatchObject({ delivered: true });
      // 不带 scope 的宿主直连调用保持兼容（cancelTree 等宿主侧操作）
      const unscoped = await mine.coordinator.send(own.childId, "直连补充", "constraint", "33333333-3333-4333-8333-333333333333");
      expect(unscoped).toMatchObject({ delivered: true });
    } finally {
      await rm(mine.dataDir, { recursive: true, force: true });
    }
  });
});
