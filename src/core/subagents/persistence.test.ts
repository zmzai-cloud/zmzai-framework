import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { AgentRegistry } from "../agent/registry.js";
import { createFrameworkSession } from "../runtime/runner.js";
import { SubagentCoordinator, type ChildRunOutcome, type SubagentCoordinatorDeps } from "./coordinator.js";
import { isSubagentTerminal } from "./types.js";

/** T04（production-chain-closure）：持久队列/邮箱/唤醒与断点恢复（PC05–PC07
 *  的存储与调度接口）。内存队列只是缓存——同 store 上重建协调器（= 进程重启
 *  的等价物）后：queued 凭记录里的 prompt 恢复执行、running 落 blocked 进
 *  恢复审查、终态结算 + to_parent 结果邮件同事务、agent_send 按状态真正
 *  进入子上下文。 */

function registryWith(): AgentRegistry {
  return new AgentRegistry().derive([
    { name: "explorer", description: "探索", mode: "subagent", steps: 8, prompt: "你是探索代理。", permission: [], model: { providerId: "faux", modelId: "m" } } as never,
  ]);
}

type Boot = {
  store: ReturnType<typeof createSqliteSessionStore>;
  parent: Awaited<ReturnType<typeof createFrameworkSession>>;
  coordinator: SubagentCoordinator;
  launches: { childId: string; prompt: string }[];
  terminalEvents: { childId: string; parentSessionId: string }[];
  deliveries: { childSessionId: string; text: string; requestId: string }[];
  dataDir: string;
};

async function bootCoordinator(opts: {
  runMs?: number;
  outcome?: (childId: string) => ChildRunOutcome;
  limits?: { perRoot: number; global: number };
} = {}): Promise<Boot> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "t04-"));
  const store = createSqliteSessionStore({ dataDir });
  const parent = await createFrameworkSession({ store, userId: "u", workspaceId: "ws", model: { providerId: "faux", modelId: "m" } });
  const launches: { childId: string; prompt: string }[] = [];
  const terminalEvents: { childId: string; parentSessionId: string }[] = [];
  const deliveries: { childSessionId: string; text: string; requestId: string }[] = [];
  const deps: SubagentCoordinatorDeps = {
    store,
    registry: registryWith(),
    createChildSession: async ({ parent: p, agentType, description, spawnRequestId }) => ({
      id: `ses_c_${spawnRequestId.slice(-10)}`, parentId: p.id, userId: p.userId, workspaceId: p.workspaceId, agent: agentType, title: description,
    } as never),
    runChild: async (childId, prompt) => {
      launches.push({ childId, prompt });
      await new Promise((r) => setTimeout(r, opts.runMs ?? 80));
      return opts.outcome?.(childId) ?? { state: "completed", summary: `结论:${childId}` };
    },
    abortChild: async () => {},
    onChildTerminal: (child, parentSessionId) => terminalEvents.push({ childId: child.childId, parentSessionId }),
    deliverToChild: async (childSessionId, text, requestId) => { deliveries.push({ childSessionId, text, requestId }); },
    limits: opts.limits,
  };
  return { store, parent, coordinator: new SubagentCoordinator(deps), launches, terminalEvents, deliveries, dataDir };
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("T04：持久队列与断点恢复（PC06 存储接口）", () => {
  it("重启（同 store 重建协调器）：queued 凭 prompt 恢复执行，running 落 blocked 恢复审查，不重放", async () => {
    const first = await bootCoordinator({ runMs: 10_000, limits: { perRoot: 1, global: 1 } });
    try {
      // 两个子：一个启动（running，卡住），一个排队（queued，从未开始）
      await first.coordinator.spawn(first.parent, "task_p", "root_r", { description: "执行中", prompt: "P-running", subagentType: "explorer", spawnRequestId: "t04-run" });
      await first.coordinator.spawn(first.parent, "task_p", "root_r", { description: "排队中", prompt: "P-queued", subagentType: "explorer", spawnRequestId: "t04-queue" });
      await waitUntil(async () => first.launches.length >= 1);
      const statuses = async () => (await first.coordinator.list("root_r")).map((r) => `${r.childId.slice(-10)}:${r.status}`).sort();
      expect((await statuses()).join(" ")).toContain("queued"); // perRoot=1 卡住第二个

      // 模拟进程重启：同 store 上重建协调器（新内存队列/活跃表；宿主须保证
      // 同一 store 每进程只建一个协调器——这里是重启后的那一个）
      const rebootLaunches: { childId: string; prompt: string }[] = [];
      const rebootTerminal: { childId: string; parentSessionId: string }[] = [];
      const rebootDeps: SubagentCoordinatorDeps = {
        store: first.store,
        registry: registryWith(),
        runChild: async (childId, prompt) => {
          rebootLaunches.push({ childId, prompt });
          await new Promise((r) => setTimeout(r, 30));
          return { state: "completed", summary: "恢复执行完成" };
        },
        abortChild: async () => {},
        onChildTerminal: (child, parentSessionId) => rebootTerminal.push({ childId: child.childId, parentSessionId }),
      };
      const reboot = new SubagentCoordinator(rebootDeps);

      // queued 恢复执行（凭记录里的 prompt），running 不重放 → blocked 恢复审查
      await waitUntil(async () => rebootLaunches.some((l) => l.prompt.includes("P-queued")));
      await waitUntil(async () => (await reboot.list("root_r")).some((r) => r.status === "blocked"));
      const records = await reboot.list("root_r");
      const blocked = records.find((r) => r.status === "blocked")!;
      expect(blocked.blockerReason ?? "").toContain("宿主重启");
      // 恢复执行的 queued 子带原 prompt 完成，终态+结果邮件+唤醒钩子齐活
      await waitUntil(async () => (await reboot.list("root_r")).some((r) => r.status === "completed"));
      const completed = (await reboot.list("root_r")).find((r) => r.status === "completed")!;
      expect(rebootLaunches.find((l) => l.childId === completed.childId)?.prompt).toContain("P-queued");
      const messages = await first.store.subagents!.listMessages(completed.childId);
      expect(messages.some((m) => m.direction === "to_parent" && m.kind === "result" && m.payload.includes("恢复执行完成"))).toBe(true);
      expect(rebootTerminal.some((e) => e.childId === completed.childId && e.parentSessionId === first.parent.id)).toBe(true);
      // running 的子没有被重启后的协调器重新执行（副作用不重放）
      expect(rebootLaunches.some((l) => l.prompt.includes("P-running"))).toBe(false);
    } finally {
      await rm(first.dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("终态结算 + to_parent 结果邮件同事务（settleSubagent）：两者同时可见，messageId 幂等", async () => {
    const ctx = await bootCoordinator({ outcome: () => ({ state: "failed", errorMessage: "boom" }) });
    try {
      await ctx.coordinator.spawn(ctx.parent, "task_p", "root_tx", { description: "失败子", prompt: "P", subagentType: "explorer" });
      await waitUntil(async () => (await ctx.coordinator.list("root_tx")).some((r) => isSubagentTerminal(r.status)));
      const rec = (await ctx.coordinator.list("root_tx"))[0]!;
      expect(rec.status).toBe("failed");
      // 同事务：终态落库的同时结果邮件已在邮箱（不会出现终态已写、邮件丢失）
      const messages = await ctx.store.subagents!.listMessages(rec.childId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ direction: "to_parent", kind: "result" });
      // messageId 幂等：重放 settle 不产生第二封
      await ctx.store.subagents!.appendMessage({ ...messages[0]!, createdAt: new Date().toISOString() });
      expect(await ctx.store.subagents!.listMessages(rec.childId)).toHaveLength(1);
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });
});

describe("T04：agent_send 进入子上下文（PC07 存储与调度接口）", () => {
  it("queued：launch 时随原始 prompt 注入；running：走 deliverToChild（安全边界投递）", async () => {
    const ctx = await bootCoordinator({ runMs: 8_000 });
    try {
      // queued 阶段 send：消息落邮箱，launch 时拼进 prompt
      const queuedChild = await ctx.coordinator.spawn(ctx.parent, "task_p", "root_send", { description: "派生", prompt: "原始任务", subagentType: "explorer", spawnRequestId: "t04-send-q" });
      const sentEarly = await ctx.coordinator.send(queuedChild.childId, "只读 src 目录", "constraint", "44444444-4444-4444-8444-444444444444");
      expect(sentEarly).toMatchObject({ delivered: true });
      await waitUntil(async () => ctx.launches.length >= 1);
      expect(ctx.launches[0]!.prompt).toContain("原始任务");
      expect(ctx.launches[0]!.prompt).toContain("只读 src 目录");
      expect(ctx.launches[0]!.prompt).toContain("[父代理追加输入");

      // running 阶段 send：走投递通道（requestId=messageId 幂等）
      const sentRunning = await ctx.coordinator.send(queuedChild.childId, "改看 tests 目录", "constraint", "55555555-5555-4555-8555-555555555555");
      expect(sentRunning).toMatchObject({ delivered: true });
      await waitUntil(async () => ctx.deliveries.length >= 1);
      expect(ctx.deliveries[0]).toMatchObject({ text: "改看 tests 目录", requestId: "55555555-5555-4555-8555-555555555555" });
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("waiting_input：send 重新入队，runChild 携带新消息续跑；waiting_permission 只落邮箱不唤醒", async () => {
    let run = 0;
    const ctx = await bootCoordinator({
      outcome: () => (run += 1) === 1 ? { state: "waiting_input" } : { state: "completed", summary: "带着补充输入完成" },
    });
    try {
      const child = await ctx.coordinator.spawn(ctx.parent, "task_p", "root_wait", { description: "等待输入", prompt: "需要补充", subagentType: "explorer", spawnRequestId: "t04-wait" });
      await waitUntil(async () => (await ctx.coordinator.list("root_wait")).some((r) => r.status === "waiting_input"));
      expect(ctx.launches).toHaveLength(1);

      // waiting_input 的 send → 重新入队 → 第二次 runChild 的 prompt 含新消息
      await ctx.coordinator.send(child.childId, "补充信息：看 docs/", "user_input", "66666666-6666-4666-8666-666666666666");
      await waitUntil(async () => ctx.launches.length >= 2);
      expect(ctx.launches[1]!.prompt).toContain("补充信息：看 docs/");
      await waitUntil(async () => (await ctx.coordinator.list("root_wait")).some((r) => r.status === "completed"));

      // waiting_permission：普通消息不解除等待（出口互不替代）——不重新入队
      let permissionRuns = 0;
      const ctx2 = await bootCoordinator({ outcome: () => (permissionRuns += 1) === 1 ? { state: "waiting_permission" } : { state: "completed" } });
      const pchild = await ctx2.coordinator.spawn(ctx2.parent, "task_p", "root_perm", { description: "等待授权", prompt: "P", subagentType: "explorer", spawnRequestId: "t04-perm" });
      await waitUntil(async () => (await ctx2.coordinator.list("root_perm")).some((r) => r.status === "waiting_permission"));
      const delivered = await ctx2.coordinator.send(pchild.childId, "催一下", "constraint", "77777777-7777-4777-8777-777777777777");
      expect(delivered).toMatchObject({ delivered: true });
      await new Promise((r) => setTimeout(r, 300));
      expect(ctx2.launches).toHaveLength(1); // 未重启执行
      expect(ctx2.deliveries).toHaveLength(0); // 无活跃 run，不走投递通道
      const mailbox = await ctx2.store.subagents!.listMessages(pchild.childId);
      expect(mailbox.some((m) => m.direction === "to_child" && m.payload === "催一下")).toBe(true);
      await rm(ctx2.dataDir, { recursive: true, force: true });
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});
