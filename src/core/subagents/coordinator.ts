import { createHash, randomUUID } from "node:crypto";
import { AgentRegistry } from "../agent/registry.js";
import type { SessionInfo } from "../session/types.js";
import type { SessionStore } from "../session/store.js";
import { createFrameworkSession } from "../runtime/runner.js";
import { writePathGuardRules } from "../permission/write-path.js";
import { isSubagentTerminal, newSubagentRecord, type SubagentRecord, type SubagentStore, type SubagentStatus } from "./types.js";

/** SubagentCoordinator（spec §8.1/§8.2，M3-S18；T02 统一子创建入口）。
 *
 *  职责：限额队列调度子 run、五工具的可执行面（spawn/list/send/wait/cancel）、
 *  子 run 生命周期与 SubagentRecord 状态同步。不负责：父 parked/唤醒合并
 *  （S19 TaskLifecycle 接线）、权限审批（runner 的 PermissionEngine 域）。
 *
 *  T02（spec 2026-09-28 §4.1）：子会话创建收敛到唯一 ChildSessionFactory——
 *  agent_spawn 与旧 task 两条路径共用；父身份从 store 解析（禁止只有 id 的
 *  伪 Session 直达工厂）；spawnRequestId 未显式提供时由工具层从持久工具调用
 *  身份派生，同键异 payload 拒绝；深度由服务端解析。
 *
 *  队列语义（spec §8.1）：每根 Task 最多 3 并发、全局最多 6；根间轮转、
 *  根内 FIFO——防某任务占满全部额度。 */

export type CoordinatorLimits = { perRoot: number; global: number };

export const DEFAULT_LIMITS: CoordinatorLimits = { perRoot: 3, global: 6 };

export type SpawnInput = {
  description: string;
  prompt: string;
  subagentType: string;
  /** 幂等键（工具层从 toolCallId 派生或模型显式提供）；同键返回既有 child，
   *  同键异 payload 抛 SPAWN_PAYLOAD_MISMATCH（spec §4.1）。 */
  spawnRequestId?: string;
  mode?: "read_only" | "workspace_write";
};

/** 统一子会话工厂（spec §4.1 唯一创建入口的契约）。宿主可注入自定义工厂，
 *  默认实现见 createDefaultChildSessionFactory。 */
export type ChildSessionFactory = (input: {
  parent: SessionInfo;
  agentType: string;
  prompt: string;
  description: string;
  mode: "read_only" | "workspace_write";
  spawnRequestId: string;
}) => Promise<SessionInfo>;

/** spawn payload 指纹：同 spawnRequestId 重试时校验 payload 一致性。
 *  SpawnInput（subagentType）与 ChildSessionFactory 输入（agentType）是同一
 *  字段的两种形态，归一后取 hash——协调器与工厂两侧必须得到相同指纹。 */
function spawnPayloadHashOf(input: { description: string; prompt: string; subagentType?: string; agentType?: string; mode?: "read_only" | "workspace_write" }): string {
  return createHash("sha256")
    .update(JSON.stringify({ description: input.description, prompt: input.prompt, subagentType: input.subagentType ?? input.agentType, mode: input.mode ?? "read_only" }))
    .digest("hex");
}

/** 确定性子会话 id：同 spawnRequestId 的创建中断重试落到同一 id（PC04 崩溃窗口）。 */
export function childSessionIdFor(spawnRequestId: string): string {
  return `ses_sub_${createHash("sha256").update(spawnRequestId).digest("hex").slice(0, 20)}`;
}

/** 框架默认 ChildSessionFactory：真实 registry + 父 Session 派生创建。
 *  - 权限上限：read_only 继承父权限（空集圈禁写路径）；workspace_write 追加
 *    preset writePaths 圈禁（白名单 allow + 全局 deny 兜底）。
 *  - 模型/身份继承：preset model ?? 父会话模型；userId/workspaceId 继承父
 *    （凭据引用随父用户，不复制凭据内容）。
 *  - 幂等：子 id 与 creationRequestId 均从 spawnRequestId 派生——创建中断后
 *    重试命中 store 的既有会话（同键同 hash no-op），不产生第二个 childSession。 */
export function createDefaultChildSessionFactory(deps: {
  store: SessionStore;
  registryFor: (session: SessionInfo) => Promise<AgentRegistry>;
}): ChildSessionFactory {
  return async (input) => {
    const registry = await deps.registryFor(input.parent);
    const subagent = registry.get(input.agentType);
    if (!subagent || (subagent.mode !== "subagent" && subagent.mode !== "all")) {
      throw new Error(`未知或非子代理类型：${input.agentType}`);
    }
    const guard = input.mode === "read_only" ? [] : writePathGuardRules(subagent.writePaths ?? []);
    return createFrameworkSession({
      store: deps.store,
      userId: input.parent.userId,
      workspaceId: input.parent.workspaceId,
      id: childSessionIdFor(input.spawnRequestId),
      agent: input.agentType,
      model: subagent.model ?? input.parent.model,
      prompt: input.prompt,
      parentId: input.parent.id,
      title: input.description,
      permission: [...input.parent.permission, ...guard],
      ...(input.mode !== "read_only" && subagent.writePaths?.length ? { writePaths: subagent.writePaths } : {}),
      creationRequestId: input.spawnRequestId,
      creationPayloadHash: spawnPayloadHashOf(input),
    });
  };
}

/** 子 run 的结构化结果（spec §4.1/T03：不能根据 Promise 正常返回推断成功）。
 *  runChild 必须读取执行器的真实终态并携带证据；failed/cancelled/blocked 与
 *  completed 一样是显式声明，缺省字段按「未知」处理而非「成功」。 */
export type ChildRunOutcome = {
  state: "completed" | "failed" | "cancelled" | "blocked" | "waiting_input" | "waiting_permission" | "waiting_external";
  /** 子代理最终结论文本（completed 时给父展示/验收用）。 */
  summary?: string;
  /** 证据引用（工具产物/文件版本等，父验收核对用）。 */
  evidenceRefs?: string[];
  /** 副作用不确定（unsafe_replay 类）：只能进入 blocked，不得报 completed。 */
  unknownSideEffect?: boolean;
  /** failed/blocked 的原因说明。 */
  errorMessage?: string;
};

/** 子代理运行许可（T03，spec §4.1 统一 AdmissionController）：Host 进程内
 *  跨项目 Runtime 共享的计数面。每项目各建一个协调器会让「Host 总计 6」
 *  变成「每项目 6」，全局上限必须由所有协调器共享的同一实例计数。 */
export type SubagentAdmission = {
  /** 原子申请一个运行槽（rootKey 维度施加 perRoot 上限）；超限返回 false。 */
  tryAcquire(rootKey: string): boolean;
  release(rootKey: string): void;
  /** 释放时通知（跨协调器重试排队者：A 项目释放要能唤醒 B 项目的泵）。 */
  onRelease(listener: () => void): void;
  /** 诊断快照。 */
  counts(): { global: number; perRoot: Record<string, number> };
};

/** 进程内 AdmissionController 参考实现（Host 直接复用或替换为持久实现）。 */
export function createSubagentAdmission(limits: CoordinatorLimits): SubagentAdmission {
  let global = 0;
  const perRoot = new Map<string, number>();
  const listeners = new Set<() => void>();
  return {
    tryAcquire(rootKey) {
      if (global >= limits.global) return false;
      if ((perRoot.get(rootKey) ?? 0) >= limits.perRoot) return false;
      global += 1;
      perRoot.set(rootKey, (perRoot.get(rootKey) ?? 0) + 1);
      return true;
    },
    release(rootKey) {
      if ((perRoot.get(rootKey) ?? 0) <= 0) return;
      perRoot.set(rootKey, perRoot.get(rootKey)! - 1);
      global = Math.max(0, global - 1);
      for (const listener of listeners) listener();
    },
    onRelease(listener) {
      listeners.add(listener);
    },
    counts() {
      return { global, perRoot: Object.fromEntries(perRoot) };
    },
  };
}

/** runChild 结构化 outcome → 协调记录状态投影（T03，PC02）。
 *  failed/cancelled/blocked/waiting_* 与 completed 一样进入记录——子失败不得
 *  伪装完成；waiting_* 是非终态（出口互不替代，spec §8.2），终态才写 result。 */
function projectChildRunOutcome(outcome: ChildRunOutcome): { status: SubagentStatus; result?: SubagentRecord["result"]; blockerReason?: string } {
  const evidence = outcome.evidenceRefs?.length ? { evidenceRefs: outcome.evidenceRefs } : {};
  switch (outcome.state) {
    case "completed":
      return { status: "completed", result: { outcome: "completed", summary: outcome.summary ?? "（无文本结果）", ...evidence } };
    case "failed":
      return {
        status: "failed",
        blockerReason: outcome.errorMessage ?? "子运行失败",
        result: { outcome: "failed", summary: outcome.summary ?? (outcome.errorMessage ? `失败：${outcome.errorMessage}` : "子运行失败"), ...evidence },
      };
    case "cancelled":
      return { status: "cancelled", result: { outcome: "cancelled", summary: outcome.summary ?? "（已取消）", ...evidence } };
    case "blocked":
      return { status: "blocked", blockerReason: outcome.errorMessage ?? (outcome.unknownSideEffect ? "副作用结果未知，需恢复核对" : "子运行阻塞") };
    default:
      // waiting_input / waiting_permission / waiting_external：非终态
      return { status: outcome.state };
  }
}

export type SubagentCoordinatorDeps = {
  store: SessionStore;
  /** 直连构造时的静态 registry 基线。经 createServer 装配时由 bindRuntimeServices
   *  绑定 runner 同源的会话级解析（含 .zmzai/agents 工作区自定义 Agent），
   *  绑定后优先于本字段。 */
  registry?: AgentRegistry;
  /** 会话级 registry 解析（宿主直连构造时注入）。 */
  registryFor?: (session: SessionInfo) => Promise<AgentRegistry>;
  /** 子会话创建工厂；缺省用框架默认实现（见 createDefaultChildSessionFactory）。 */
  createChildSession?: ChildSessionFactory;
  /** 子 run 执行（SessionRunner.runAttempt 等）；必须返回结构化 outcome——
   *  Promise 正常返回不构成成功（spec §4.1，T03）。 */
  runChild(childSessionId: string, prompt: string): Promise<ChildRunOutcome>;
  /** 取消子 run（runner.abort）。 */
  abortChild(childSessionId: string): Promise<void>;
  limits?: CoordinatorLimits;
  /** 嵌套深度上限（默认 1）；createServer 装配时与 runner 同源绑定。 */
  subagentDepth?: number;
  /** 跨协调器共享的运行许可（T03，PC03：多项目共用 Host 全局/根上限）。
   *  缺省时仅按本协调器 store 内的运行计数限额。 */
  admission?: SubagentAdmission;
};

export class SubagentCoordinator {
  private readonly limits: CoordinatorLimits;
  private readonly queue: { childId: string; rootTaskId: string; prompt: string }[] = [];
  /** 活跃子 run 的取消句柄（childId → abort）。 */
  private readonly active = new Map<string, { abort(): void; done: Promise<void> }>();
  /** wait 的轮询唤醒（子终态时 resolve）。 */
  private readonly waiters = new Set<() => void>();
  /** createServer 绑定的运行期服务（会话级 registry + 深度）。 */
  private bound: { registryFor: (session: SessionInfo) => Promise<AgentRegistry>; subagentDepth: number } | null = null;
  private readonly createChildSession: ChildSessionFactory;

  constructor(private readonly deps: SubagentCoordinatorDeps) {
    this.limits = deps.limits ?? DEFAULT_LIMITS;
    this.createChildSession = deps.createChildSession
      ?? createDefaultChildSessionFactory({ store: deps.store, registryFor: (session) => this.resolveRegistry(session) });
    // 共享许可的释放要能唤醒本协调器的队列泵（另一项目的协调器释放槽位后，
    // 本项目排队者才能启动，PC03）。
    deps.admission?.onRelease(() => this.pump());
  }

  private get store(): SubagentStore {
    if (!this.deps.store.subagents) throw new Error("SUBAGENTS_UNSUPPORTED（store 未提供 subagents 面）");
    return this.deps.store.subagents;
  }

  private get subagentDepth(): number {
    return this.bound?.subagentDepth ?? this.deps.subagentDepth ?? 1;
  }

  /** 会话级 registry 解析：绑定（createServer，含 workspace Agent）> 宿主注入 >
   *  静态基线 > 空注册表。 */
  private async resolveRegistry(session: SessionInfo): Promise<AgentRegistry> {
    if (this.bound) return this.bound.registryFor(session);
    if (this.deps.registryFor) return this.deps.registryFor(session);
    if (this.deps.registry) return this.deps.registry;
    return new AgentRegistry();
  }

  /** createServer 装配时绑定 runner 同源的运行期服务。重复绑定拒绝——
   *  多 runner 场景共享一个协调器时换源必须显式，不能悄悄生效。 */
  bindRuntimeServices(services: { registryFor: (session: SessionInfo) => Promise<AgentRegistry>; subagentDepth: number }): void {
    if (this.bound) throw new Error("SUBAGENT_SERVICES_ALREADY_BOUND：协调器运行期服务已绑定");
    this.bound = { registryFor: services.registryFor, subagentDepth: services.subagentDepth };
  }

  /** 父身份解析（spec §4.1：禁止只有 id 的伪 Session 抵达创建工厂）。
   *  工具层只带 { id }（ToolContext 没有 SessionInfo 全量）；缺失身份时从
   *  store 解析完整父会话——userId 为 undefined 的伪 Session 会让 SQLite
   *  参数绑定直接崩（实测 "Provided value cannot be bound to SQLite parameter"）。 */
  private async resolveParent(parentRef: SessionInfo | { id: string }): Promise<SessionInfo> {
    const ref = parentRef as Partial<SessionInfo>;
    if (ref.userId != null && ref.workspaceId != null) return parentRef as SessionInfo;
    const stored = await this.deps.store.getSession(parentRef.id);
    if (!stored) throw new Error(`父会话不存在或不可解析：${parentRef.id}`);
    return stored;
  }

  /** 父链深度：服务端从 store 解析（不信任调用方声明，spec §4.1）。 */
  private async parentDepth(session: SessionInfo): Promise<number> {
    let depth = 0;
    let current: SessionInfo | null = session;
    while (current?.parentId) {
      depth += 1;
      current = await this.deps.store.getSession(current.parentId);
    }
    return depth;
  }

  /** agent_spawn：父身份解析 → 幂等校验 → 深度/类型检查 → 唯一工厂创建 →
   *  登记（幂等）→ 入队 → 立即返回 childId（不等待执行）。 */
  async spawn(parentRef: SessionInfo | { id: string }, parentTaskId: string, rootTaskId: string, input: SpawnInput): Promise<SubagentRecord> {
    const parent = await this.resolveParent(parentRef);
    const spawnRequestId = input.spawnRequestId ?? `spawn:${randomUUID()}`;
    const spawnPayloadHash = spawnPayloadHashOf(input);
    const prior = await this.store.findSubagentBySpawnRequest(parent.id, spawnRequestId);
    if (prior) {
      if (prior.spawnPayloadHash && prior.spawnPayloadHash !== spawnPayloadHash) {
        throw new Error(`SPAWN_PAYLOAD_MISMATCH：spawnRequestId=${spawnRequestId} 已用于不同 payload 的派生，拒绝重放`);
      }
      return prior; // A14：重试返回同一 child
    }

    const depth = await this.parentDepth(parent);
    if (depth >= this.subagentDepth) throw new Error(`子代理嵌套深度超过限制（${this.subagentDepth}）`);

    // 类型守卫（对所有工厂生效）：agentType 必须是 registry 声明的子代理类型，
    // 模型编造的类型在这里拒绝（spec §4.1 不能信任模型给任意 childId/类型）。
    const registry = await this.resolveRegistry(parent);
    const subagent = registry.get(input.subagentType);
    if (!subagent || (subagent.mode !== "subagent" && subagent.mode !== "all")) {
      throw new Error(`未知或非子代理类型：${input.subagentType}`);
    }

    const child = await this.createChildSession({
      parent,
      agentType: input.subagentType,
      prompt: input.prompt,
      description: input.description,
      mode: input.mode ?? "read_only",
      spawnRequestId,
    });
    const record: SubagentRecord = {
      ...newSubagentRecord({
        childSessionId: child.id,
        parentSessionId: parent.id,
        rootTaskId,
        parentTaskId,
        spawnRequestId,
        agentType: input.subagentType,
        goal: input.description,
        mode: input.mode ?? "read_only",
        workspaceId: child.workspaceId,
        traceId: randomUUID(),
      }),
      spawnPayloadHash,
    };
    const created = await this.createSubagentIdempotent(record);
    this.queue.push({ childId: created.childId, rootTaskId, prompt: input.prompt });
    this.pump();
    return created;
  }

  /** 登记幂等：并发同键 spawn 撞唯一索引（parent_session_id, spawn_request_id）
   *  时回落到既有记录，不重复入队。 */
  private async createSubagentIdempotent(record: SubagentRecord): Promise<SubagentRecord> {
    try {
      return await this.store.createSubagent(record);
    } catch (error) {
      const prior = await this.store.findSubagentBySpawnRequest(record.parentSessionId, record.spawnRequestId).catch(() => null);
      if (prior) return prior;
      throw error;
    }
  }

  /** agent_list：当前树内子代理 + 最近进度。 */
  async list(rootTaskId: string): Promise<SubagentRecord[]> {
    const all = await this.store.listSubagents({ rootTaskId });
    return all.map((r) => ({ ...r }));
  }

  /** agent_send：幂等投递；waiting_input 唤醒；终态拒绝（CHILD_TERMINAL）。
   *  scope（T03，PC03）：调用方任务树——树外 childId 拒绝（CHILD_OUT_OF_SCOPE），
   *  模型不能向其它根 Task 的子代理投递。 */
  async send(childId: string, payload: string, kind: "constraint" | "user_input" = "constraint", messageId = randomUUID(), scope?: { rootTaskId: string }): Promise<{ delivered: boolean; reason?: string }> {
    const rec = await this.store.getSubagent(childId);
    if (!rec) return { delivered: false, reason: "CHILD_NOT_FOUND" };
    if (scope && rec.rootTaskId !== scope.rootTaskId) return { delivered: false, reason: "CHILD_OUT_OF_SCOPE" };
    if (isSubagentTerminal(rec.status)) return { delivered: false, reason: "CHILD_TERMINAL" }; // 不复活旧子代理（spec §8.2）
    await this.store.appendMessage({ messageId, childId, direction: "to_child", kind, payload, createdAt: new Date().toISOString() });
    return { delivered: true };
  }

  /** agent_wait：最多 timeoutMs；等首个终态或需处理状态；无变化返回仍在运行。
   *  非 async 挂死——用活跃 run 的 done promise + 轮询兜底。
   *  scope（T03）：树外 childId 直接拒绝，不把其它树的状态泄露给调用方。 */
  async wait(childIds: string[], timeoutMs = 30_000, scope?: { rootTaskId: string }): Promise<{ changed: SubagentRecord[]; anyTerminal: boolean }> {
    if (scope) {
      const out: string[] = [];
      for (const id of childIds) {
        const rec = await this.store.getSubagent(id);
        if (rec && rec.rootTaskId !== scope.rootTaskId) out.push(id);
      }
      if (out.length > 0) throw new Error(`SCOPE_VIOLATION：childId 不在当前任务树内：${out.join(", ")}`);
    }
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
   *  终态确认由状态回调落 cancelled。返回已登记。
   *  scope（T03）：树外 childId 拒绝——一个会话不能取消另一个根的后代。 */
  async cancel(childId: string, scope?: { rootTaskId: string }): Promise<{ cancelling: boolean; reason?: string }> {
    for (;;) {
      const rec = await this.store.getSubagent(childId);
      if (!rec) return { cancelling: false, reason: "CHILD_NOT_FOUND" };
      if (scope && rec.rootTaskId !== scope.rootTaskId) return { cancelling: false, reason: "CHILD_OUT_OF_SCOPE" };
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

  /** 队列泵：按根轮转取额度可用的 child 启动。
   *  T03：admission（跨协调器共享）原子授予运行槽——本 store 的运行计数只是
   *  本协调器内的廉价预过滤，全局/根上限以 admission 为准；授予失败即退出
   *  本次泵程，等释放通知（onRelease → pump）重试。 */
  private pump(): void {
    void (async () => {
      for (;;) {
        const running = await this.store.listSubagents({ statuses: ["running", "waiting_permission", "waiting_input", "waiting_external"] });
        if (running.length >= this.limits.global) return;
        const next = this.pickNext(running);
        if (!next) return;
        const admission = this.deps.admission;
        if (admission && !admission.tryAcquire(next.rootTaskId)) return;
        this.queue.splice(this.queue.indexOf(next), 1);
        void this.launch(next); // launch 持有许可，finally 按执行状态释放
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

  private async launch(item: { childId: string; rootTaskId: string; prompt: string }): Promise<void> {
    const admission = this.deps.admission;
    let settle: (() => void) | null = null;
    let done: Promise<void> | null = null;
    try {
      let rec = await this.store.getSubagent(item.childId);
      if (!rec || isSubagentTerminal(rec.status) || rec.status === "cancelling") return;
      rec = await this.store.updateSubagent(item.childId, rec.revision, { status: "running", times: { ...rec.times, startedAt: new Date().toISOString() } });
      let resolveDone!: () => void;
      done = new Promise<void>((resolve) => { resolveDone = resolve; });
      settle = resolveDone;
      this.active.set(item.childId, { abort: () => undefined, done });
      // T03（PC02）：runChild 返回结构化 outcome——失败/取消/阻塞与完成一样是
      // 显式声明，禁止按 Promise 正常返回推断成功（F02 修复的框架侧契约）。
      const outcome = await this.deps.runChild(item.childId, item.prompt);
      const latest = await this.store.getSubagent(item.childId);
      if (!latest) return;
      if (latest.status === "cancelling") {
        await this.store.updateSubagent(item.childId, latest.revision, { status: "cancelled", times: { ...latest.times, endedAt: new Date().toISOString() } });
      } else {
        const settled = projectChildRunOutcome(outcome);
        await this.store.updateSubagent(item.childId, latest.revision, {
          status: settled.status,
          times: { ...latest.times, endedAt: new Date().toISOString() },
          ...(settled.result ? { result: settled.result } : {}),
          ...(settled.blockerReason ? { blockerReason: settled.blockerReason } : {}),
        });
      }
    } catch (error) {
      const latest = await this.store.getSubagent(item.childId);
      if (latest && !isSubagentTerminal(latest.status)) {
        await this.store.updateSubagent(item.childId, latest.revision, { status: "failed", blockerReason: error instanceof Error ? error.message : String(error), result: { outcome: "failed", summary: `失败：${error instanceof Error ? error.message : String(error)}` } }).catch(() => undefined);
      }
    } finally {
      // 许可按执行状态释放：runChild 真正结束（成功/失败/取消/异常）后，而非
      // Promise 语义猜测；waiting_* 不占模型并发槽的细化在 T04 调度层处理。
      admission?.release(item.rootTaskId);
      this.active.delete(item.childId);
      settle?.();
      this.notifyWaiters();
      this.pump(); // 腾出的额度给下一个排队者
    }
  }

  private notifyWaiters(): void {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }
}
