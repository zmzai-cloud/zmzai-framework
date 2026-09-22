import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { AgentRegistry } from "../agent/registry.js";
import { SubagentCoordinator, type SubagentCoordinatorDeps } from "./coordinator.js";
import { isSubagentTerminal } from "./types.js";

/** M3-S18：协调器——并发重叠（A13）、spawn 幂等（A14）、取消树（A18）、
 *  根间轮转限额、agent_send 终态拒绝。 */
type Launch = { childId: string; startedAt: number; endedAt?: number; state: "completed" | "failed" | "cancelled" };

function makeDeps(opts: { runMs?: number; states?: Map<string, "completed" | "failed" | "cancelled"> } = {}) {
  const launches: Launch[] = [];
  const running = new Set<string>();
  // derive 注入 subagent 模式类型（registry 内建只有 default/generalist 主代理）
  const base = new AgentRegistry();
  const registry = base.derive([
    { name: "explorer", description: "探索", mode: "subagent", steps: 8, prompt: "你是探索代理。", permission: [], model: { providerId: "faux", modelId: "m" } } as never,
  ]);
  const deps: SubagentCoordinatorDeps = {
    store: {} as never, // 由测试注入真实 store
    registry,
    createChildSession: async ({ parent, agentType, description }) => {
      const id = `ses_child_${Math.random().toString(36).slice(2, 8)}`;
      return { id, parentId: parent.id, userId: parent.userId, workspaceId: parent.workspaceId, agent: agentType, title: description } as never;
    },
    runChild: async (childId) => {
      const startedAt = Date.now();
      running.add(childId);
      launches.push({ childId, startedAt, state: "completed" });
      await new Promise((r) => setTimeout(r, opts.runMs ?? 150));
      running.delete(childId);
      const l = launches.find((x) => x.childId === childId)!;
      l.endedAt = Date.now();
      return opts.states?.get(childId) ?? "completed";
    },
    abortChild: async () => {},
    limits: { perRoot: 3, global: 6 },
  };
  return { deps, launches, running };
}

async function boot() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "m3-s18-"));
  const store = createSqliteSessionStore({ dataDir });
  return { store, dataDir };
}

const parent = { id: "ses_parent", userId: "u", workspaceId: "ws", agent: "default" } as never;

describe("SubagentCoordinator（M3-S18）", () => {
  it("完整链路：注册类型后 spawn→并发重叠→终态落库", async () => {
    const { store, dataDir } = await boot();
    const { deps, launches } = makeDeps({ runMs: 200 });
    deps.store = store as never;
    // 注册子代理类型（AgentRegistry 的实际 API——按 runner.test 惯例 new AgentRegistry() 后 get("default")）
    const coord = new SubagentCoordinator(deps);
    try {
      const spawned = await Promise.all(
        [1, 2, 3].map((i) => coord.spawn(parent, "task_p", "task_root", { description: `探索${i}`, prompt: `P${i}`, subagentType: "explorer" })),
      );
      expect(launches.length).toBeGreaterThanOrEqual(0); // pump 异步启动
      // 等全部终态
      // wait 是「首个终态」语义（spec §8.1）；等齐全部用轮询
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await coord.list("task_root")).some((r) => !isSubagentTerminal(r.status))) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const result = await coord.wait(spawned.map((s) => s.childId), 1_000);
      expect(result.anyTerminal).toBe(true);
      expect(launches).toHaveLength(3);
      // A13：至少两个运行区间重叠
      const sorted = [...launches].sort((a, b) => a.startedAt - b.startedAt);
      const overlap = sorted[0]!.endedAt! > sorted[1]!.startedAt || sorted[1]!.endedAt! > sorted[2]!.startedAt;
      expect(overlap).toBe(true);
      for (const s of spawned) {
        const rec = await store.subagents!.getSubagent(s.childId);
        expect(rec!.status).toBe("completed");
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("A14：重试 spawn（同 spawnRequestId）返回同一 child 不重复派生", async () => {
    const { store, dataDir } = await boot();
    const { deps, launches } = makeDeps({ runMs: 100 });
    deps.store = store as never;
    const coord = new SubagentCoordinator(deps);
    try {
      const first = await coord.spawn(parent, "task_p", "task_root", { description: "探索", prompt: "P", subagentType: "explorer", spawnRequestId: "req-retry" });
      const retry = await coord.spawn(parent, "task_p", "task_root", { description: "探索", prompt: "P", subagentType: "explorer", spawnRequestId: "req-retry" });
      expect(retry.childId).toBe(first.childId);
      await coord.wait([first.childId], 3_000);
      expect(launches.filter((l) => l.childId === first.childId)).toHaveLength(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("A18：取消树——排队/运行/等待中的全部收尾，无孤儿", async () => {
    const { store, dataDir } = await boot();
    const { deps, launches } = makeDeps({ runMs: 300 });
    deps.store = store as never;
    const coord = new SubagentCoordinator(deps);
    try {
      const spawned = await Promise.all(
        [1, 2, 3].map((i) => coord.spawn(parent, "task_p", "task_root", { description: `子${i}`, prompt: `P${i}`, subagentType: "explorer" })),
      );
      await new Promise((r) => setTimeout(r, 50)); // 部分已启动
      await coord.cancelTree("task_root");
      const result = await coord.wait(spawned.map((s) => s.childId), 3_000);
      const all = await coord.list("task_root");
      expect(all.every((r) => isSubagentTerminal(r.status))).toBe(true);
      // pump 不再启动新 run
      const after = launches.length;
      await new Promise((r) => setTimeout(r, 200));
      expect(launches.length).toBeLessThanOrEqual(after + 1); // 允许取消瞬间的在途 launch
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("agent_send：终态子代理拒绝（CHILD_TERMINAL）；活动子代理投递成功", async () => {
    const { store, dataDir } = await boot();
    const { deps } = makeDeps({ runMs: 100 });
    deps.store = store as never;
    const coord = new SubagentCoordinator(deps);
    try {
      const spawned = await coord.spawn(parent, "task_p", "task_root", { description: "目标", prompt: "P", subagentType: "explorer" });
      const active = await coord.send(spawned.childId, "补一条约束");
      expect(active.delivered).toBe(true);
      await coord.wait([spawned.childId], 3_000);
      const terminal = await coord.send(spawned.childId, "再补一条");
      expect(terminal.delivered).toBe(false);
      expect(terminal.reason).toBe("CHILD_TERMINAL");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
