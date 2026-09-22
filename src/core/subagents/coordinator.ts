import { randomUUID } from "node:crypto";
import type { AgentRegistry } from "../agent/registry.js";
import type { SessionInfo } from "../session/types.js";
import type { SessionRunner } from "../runtime/runner.js";
import type { WorkflowState } from "../session/workflow.js";
import { isSubagentTerminal, type SubagentRecord, type SubagentStore, type SubagentStatus } from "./types.js";

/** SubagentCoordinator（spec §8.1/§8.2，M3-S18）。
 *
 *  职责：限额队列调度子 run、五工具的可执行面（spawn/list/send/wait/cancel）、
 *  子 run 生命周期与 SubagentRecord 状态同步。不负责：父 parked/唤醒合并
 *  （S19 TaskLifecycle 接线）、权限交集展开（S20，spawn 时由 caller 传入
 *  已 stamp 好的 childSession）。
 *
 *  队列语义（spec §8.1）：每根 Task 最多 3 并发、全局最多 6；根间轮转、
 *  根内 FIFO——防某任务占满全部额度。 */

export type CoordinatorLimits = { perRoot: number; global: number };

export const DEFAULT_LIMITS: CoordinatorLimits = { perRoot: 3, global: 6 };

export type SpawnInput = {
  description: string;
  prompt: string;
  subagentType: string;
  /** 幂等键（工具层透传 requestId）；同键返回既有 child。 */
  spawnRequestId?: string;
  mode?: "read_only" | "workspace_write";
};

export type SubagentCoordinatorDeps = {
  store: { subagents?: SubagentStore };
  registry: AgentRegistry;
  /** 子会话创建（caller 负责 permission stamp/writePath 圈禁——S20）；
   *  幂等：同 spawnRequestId 已有 child 时不会被调用。 */
  createChildSession(input: { parent: SessionInfo; agentType: string; prompt: string; description: string; mode: "read_only" | "workspace_write" }): Promise<SessionInfo>;
  /** 子 run 执行（SessionRunner.prompt 或 runAttempt）；返回终态。 */
  runChild(childSessionId: string, prompt: string): Promise<WorkflowState>;
  /** 取消子 run（runner.abort）。 */
  abortChild(childSessionId: string): Promise<void>;
  limits?: CoordinatorLimits;
};

export class SubagentCoordinator {
  private readonly limits: CoordinatorLimits;
  /** 排队等待额度的 childId（FIFO per root 由 pickNext 实现）。 */
  private readonly queue: { childId: string; rootTaskId: string; prompt: string }[] = [];
  /** 活跃子 run 的取消句柄（childId → abort）。 */
  private readonly active = new Map<string, { abort(): void; done: Promise<void> }>();
  /** wait 的轮询唤醒（子终态时 resolve）。 */
  private readonly waiters = new Set<() => void>();

  constructor(private readonly deps: SubagentCoordinatorDeps) {
    this.limits = deps.limits ?? DEFAULT_LIMITS;
  }

  private get store(): SubagentStore {
    if (!this.deps.store.subagents) throw new Error("SUBAGENTS_UNSUPPORTED（store 未提供 subagents 面）");
    return this.deps.store.subagents;
  }

  /** agent_spawn：登记（幂等）→ 入队 → 立即返回 childId（不等待执行）。 */
  async spawn(parent: SessionInfo, parentTaskId: string, rootTaskId: string, input: SpawnInput & { childSessionId?: string }): Promise<SubagentRecord> {
    const spawnRequestId = input.spawnRequestId ?? randomUUID();
    const prior = await this.store.findSubagentBySpawnRequest(parent.id, spawnRequestId);
    if (prior) return prior; // A14：重试返回同一 child

    // runner 协调路径预建了权限 stamp 的子会话（registry/engine 在 runner 侧）——
    // 直接采用，不再自建（自建会绕过 stamp 造成第二个孤儿会话）
    const child = input.childSessionId
      ? ({ id: input.childSessionId, userId: parent.userId, workspaceId: parent.workspaceId } as SessionInfo)
      : await this.resolveViaRegistry(parent, input);
    const mode = input.mode ?? "read_only";
    const record: SubagentRecord = {
      childId: child.id,
      childSessionId: child.id,
      parentSessionId: parent.id,
      rootTaskId,
      parentTaskId,
      spawnRequestId,
      agentType: input.subagentType,
      goal: input.description,
      mode,
      workspaceId: child.workspaceId,
      status: "queued",
      revision: 1,
      traceId: randomUUID(),
      times: { spawnedAt: new Date().toISOString() },
    };
    const created = await this.store.createSubagent(record);
    this.queue.push({ childId: created.childId, rootTaskId, prompt: input.prompt });
    this.pump();
    return created;
  }

  /** 无预建会话时的原路径：registry 类型检查 + deps.createChildSession。 */
  private async resolveViaRegistry(parent: SessionInfo, input: SpawnInput): Promise<SessionInfo> {
    const subagent = this.deps.registry.get(input.subagentType);
    if (!subagent || (subagent.mode !== "subagent" && subagent.mode !== "all")) {
      throw new Error(`未知或非子代理类型：${input.subagentType}`);
    }
    return this.deps.createChildSession({ parent, agentType: input.subagentType, prompt: input.prompt, description: input.description, mode: input.mode ?? "read_only" });
  }

  /** agent_list：当前树内子代理 + 最近进度。 */
  async list(rootTaskId: string): Promise<SubagentRecord[]> {
    const all = await this.store.listSubagents({ rootTaskId });
    return all.map((r) => ({ ...r }));
  }

  /** agent_send：幂等投递；waiting_input 唤醒；终态拒绝（CHILD_TERMINAL）。 */
  async send(childId: string, payload: string, kind: "constraint" | "user_input" = "constraint", messageId = randomUUID()): Promise<{ delivered: boolean; reason?: string }> {
    const rec = await this.store.getSubagent(childId);
    if (!rec) return { delivered: false, reason: "CHILD_NOT_FOUND" };
    if (isSubagentTerminal(rec.status)) return { delivered: false, reason: "CHILD_TERMINAL" }; // 不复活旧子代理（spec §8.2）
    await this.store.appendMessage({ messageId, childId, direction: "to_child", kind, payload, createdAt: new Date().toISOString() });
    return { delivered: true };
  }

  /** agent_wait：最多 timeoutMs；等首个终态或需处理状态；无变化返回仍在运行。
   *  非 async 挂死——用活跃 run 的 done promise + 轮询兜底。 */
  async wait(childIds: string[], timeoutMs = 30_000): Promise<{ changed: SubagentRecord[]; anyTerminal: boolean }> {
    const deadline = Date.now() + timeoutMs;
    const read = async () => {
      const out: SubagentRecord[] = [];
      for (const id of childIds) {
        const r = await this.store.getSubagent(id);
        if (r) out.push(r);
      }
      return out;
    };
    const isSettled = (records: SubagentRecord[]) =>
      records.some((r) => isSubagentTerminal(r.status) || r.status === "waiting_permission" || r.status === "waiting_input" || r.status === "waiting_external" || r.status === "blocked");
    for (;;) {
      const records = await read();
      if (isSettled(records)) return { changed: records, anyTerminal: records.some((r) => isSubagentTerminal(r.status)) };
      if (Date.now() >= deadline) return { changed: records, anyTerminal: false };
      {
        let wake: () => void = () => {};
        const notified = new Promise<void>((resolve) => { wake = resolve; this.waiters.add(wake); });
        const poll = new Promise<void>((resolve) => setTimeout(resolve, 500)); // 轮询兜底
        await Promise.race([notified, poll]).finally(() => this.waiters.delete(wake));
      }
    }
  }

  /** agent_cancel：幂等标记 cancelling → 停止 admission → 取消 run 与后代 →
   *  终态确认由状态回调落 cancelled。返回已登记。 */
  async cancel(childId: string): Promise<{ cancelling: boolean; reason?: string }> {
    for (;;) {
      const rec = await this.store.getSubagent(childId);
      if (!rec) return { cancelling: false, reason: "CHILD_NOT_FOUND" };
      if (isSubagentTerminal(rec.status)) return { cancelling: false, reason: `CHILD_TERMINAL:${rec.status}` };
      if (rec.status === "cancelling") return { cancelling: true };
      try {
        await this.store.updateSubagent(childId, rec.revision, { status: "cancelling" });
        break;
      } catch (error) {
        if (/SUBAGENT_REVISION_CONFLICT/.test(String(error))) continue; // CAS 重试
        throw error;
      }
    }
    // 出队未启动的
    const qi = this.queue.findIndex((q) => q.childId === childId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      const rec = await this.store.getSubagent(childId);
      if (rec) await this.store.updateSubagent(childId, rec.revision, { status: "cancelled" }).catch(() => undefined);
      this.notifyWaiters();
      return { cancelling: true };
    }
    // 活跃的：abort 子 run（终态回调会落 cancelled）
    const entry = this.active.get(childId);
    if (entry) {
      await this.deps.abortChild(childId);
      await entry.done.catch(() => undefined);
      return { cancelling: true };
    }
    // waiting_*（无活跃 run）：直接落终态
    const rec = await this.store.getSubagent(childId);
    if (rec && !isSubagentTerminal(rec.status)) {
      await this.store.updateSubagent(childId, rec.revision, { status: "cancelled" }).catch(() => undefined);
    }
    this.notifyWaiters();
    return { cancelling: true };
  }

  /** 根 Task 取消（§8.4 父取消→全部后代）：递归取消树。 */
  async cancelTree(rootTaskId: string): Promise<void> {
    const children = await this.store.listSubagents({ rootTaskId });
    for (const child of children) {
      if (!isSubagentTerminal(child.status) && child.status !== "cancelling") {
        await this.cancel(child.childId).catch(() => undefined);
      }
    }
  }

  // ---- 调度 ----

  /** 队列泵：按根轮转取额度可用的 child 启动。 */
  private pump(): void {
    void (async () => {
      for (;;) {
        const running = await this.store.listSubagents({ statuses: ["running", "waiting_permission", "waiting_input", "waiting_external"] });
        if (running.length >= this.limits.global) return;
        const next = this.pickNext(running);
        if (!next) return;
        this.queue.splice(this.queue.indexOf(next), 1);
        void this.launch(next);
      }
    })().catch(() => undefined);
  }

  /** 根间轮转 + 根内 FIFO：优先选「当前运行数最少」的根的队头。 */
  private pickNext(running: SubagentRecord[]): { childId: string; rootTaskId: string; prompt: string } | undefined {
    const perRoot = new Map<string, number>();
    for (const r of running) perRoot.set(r.rootTaskId, (perRoot.get(r.rootTaskId) ?? 0) + 1);
    let candidates = this.queue.filter((q) => (perRoot.get(q.rootTaskId) ?? 0) < this.limits.perRoot);
    if (candidates.length === 0) return undefined;
    // 根间轮转：按根分组取各组队头，再选运行数最少的根
    const heads = new Map<string, typeof candidates[number]>();
    for (const q of candidates) if (!heads.has(q.rootTaskId)) heads.set(q.rootTaskId, q);
    const ordered = [...heads.values()].sort((a, b) => (perRoot.get(a.rootTaskId) ?? 0) - (perRoot.get(b.rootTaskId) ?? 0));
    return ordered[0];
  }

  private async launch(item: { childId: string; prompt: string }): Promise<void> {
    let rec = await this.store.getSubagent(item.childId);
    if (!rec || isSubagentTerminal(rec.status) || rec.status === "cancelling") return;
    rec = await this.store.updateSubagent(item.childId, rec.revision, { status: "running", times: { ...rec.times, startedAt: new Date().toISOString() } });
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    this.active.set(item.childId, { abort: () => undefined, done });
    try {
      const state = await this.deps.runChild(item.childId, item.prompt);
      const latest = await this.store.getSubagent(item.childId);
      if (!latest) return;
      if (latest.status === "cancelling") {
        await this.store.updateSubagent(item.childId, latest.revision, { status: "cancelled", times: { ...latest.times, endedAt: new Date().toISOString() } });
      } else {
        const outcome = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed";
        await this.store.updateSubagent(item.childId, latest.revision, {
          status: outcome,
          times: { ...latest.times, endedAt: new Date().toISOString() },
          ...(outcome === "completed" ? {} : { blockerReason: state === "failed" ? `子运行失败（${state}）` : undefined }),
        });
      }
    } catch (error) {
      const latest = await this.store.getSubagent(item.childId);
      if (latest && !isSubagentTerminal(latest.status)) {
        await this.store.updateSubagent(item.childId, latest.revision, { status: "failed", blockerReason: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      }
    } finally {
      this.active.delete(item.childId);
      settle();
      this.notifyWaiters();
      this.pump(); // 腾出的额度给下一个排队者
    }
  }

  private notifyWaiters(): void {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }
}
