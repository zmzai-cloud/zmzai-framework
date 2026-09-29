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
  /** 返工替代（T05，§9.4）：本派生取代的被否决子代理。 */
  replacesChildId?: string;
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
  /** 子终态回调（T04，spec §4.2 唤醒意图）：settleSubagent（终态+结果邮件
   *  同事务）成功后调用；宿主接父唤醒（runner.requestInternalResume 等），
   *  不得在此另写结果邮件（已在事务内）。 */
  onChildTerminal?: (child: SubagentRecord, parentSessionId: string) => void;
  /** 运行中子代理的消息投递通道（T04，PC07「运行中安全边界接收」）：宿主接
   *  runner.prompt（活动会话的 FIFO queued prompt 即安全边界；requestId 用
   *  messageId 幂等）。缺省时 running 子代理的 agent_send 只落邮箱。 */
  deliverToChild?: (childSessionId: string, text: string, requestId: string) => Promise<void>;
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
  /** 根取消的 admission 截止（T05，PC09/spec §4.2）：cancelTree 先关闸，
   *  pump/launch 不再启动该根的排队者；根终态不复活，截止随协调器生命周期。 */
  private readonly admissionCutoff = new Set<string>();

  constructor(private readonly deps: SubagentCoordinatorDeps) {
    this.limits = deps.limits ?? DEFAULT_LIMITS;
    this.createChildSession = deps.createChildSession
      ?? createDefaultChildSessionFactory({ store: deps.store, registryFor: (session) => this.resolveRegistry(session) });
    // 共享许可的释放要能唤醒本协调器的队列泵（另一项目的协调器释放槽位后，
    // 本项目排队者才能启动，PC03）。
    deps.admission?.onRelease(() => this.pump());
    // T04（spec §4.2）启动对账：内存队列只是缓存，凭 store 恢复
    // （见 recover——宿主须保证同一 store 每进程只建一个协调器）。
    this.recover();
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
      // T04（spec §4.2 持久队列）：执行输入落记录——宿主重启后凭此恢复
      // queued 子代理，不依赖进程内存。
      prompt: input.prompt,
      ...(input.replacesChildId ? { replacesChildId: input.replacesChildId } : {}),
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

  /** 启动对账（T04/T06，spec §4.2）：内存队列/活跃表只是缓存，进程重启后凭
   *  store 重建——queued（从未开始）凭记录里的 prompt 重新入队执行；
   *  running/cancelling 是上个进程的在途执行、结果未知 → 落 blocked 进恢复
   *  审查（cancelling 补收 cancelled），不自动重放副作用；waiting_* 无活跃
   *  run、重启安全，保持原状。
   *  另外（PC06 持久唤醒）：in-process 唤醒 Set 随进程消失——「parked 父任务
   *  + 未消费 to_parent 结果」就是持久唤醒状态；终态子 + 未消费邮件 + 父任务
   *  running（parkedReason=children）时经 onChildTerminal 通道重建唤醒；父
   *  任务终态/等待态不复活（§8.4/A29）。 */
  private recover(): void {
    void (async () => {
      const stale = await this.store.listSubagents({}).catch(() => [] as SubagentRecord[]);
      let requeued = 0;
      const wakeCandidates = new Map<string, SubagentRecord>();
      for (const rec of stale) {
        if (rec.status === "queued") {
          this.queue.push({ childId: rec.childId, rootTaskId: rec.rootTaskId, prompt: rec.prompt ?? rec.goal });
          requeued += 1;
        } else if (rec.status === "running" || rec.status === "cancelling") {
          await this.store.updateSubagent(rec.childId, rec.revision, rec.status === "cancelling"
            ? { status: "cancelled", times: { ...rec.times, endedAt: new Date().toISOString() } }
            : { status: "blocked", blockerReason: "宿主重启：子运行中断，结果未知，需恢复核对（不自动重放副作用）", times: { ...rec.times, endedAt: new Date().toISOString() } })
            .catch(() => undefined);
        } else if (isSubagentTerminal(rec.status)) {
          wakeCandidates.set(rec.parentSessionId, rec);
        }
      }
      if (requeued > 0) this.pump();
      // 持久唤醒对账：构造异步起步（首个 store 读即挂起），此处 holder/runner
      // 已由宿主回填完成（Lectern 在 createAgentRuntime 返回后同步赋值）。
      const taskStore = this.deps.store.task;
      if (taskStore && this.deps.onChildTerminal) {
        for (const [parentSessionId, child] of wakeCandidates) {
          const task = await taskStore.getActiveTask(parentSessionId).catch(() => null);
          if (!task || task.status !== "running") continue; // 终态/等待态父不复活
          const messages = await this.store.listMessages(child.childId).catch(() => []);
          if (messages.some((m) => m.direction === "to_parent" && m.kind === "result" && !m.consumedByParent)) {
            try {
              this.deps.onChildTerminal!(child, parentSessionId);
            } catch { /* 对账唤醒失败不影响其余恢复 */ }
          }
        }
      }
    })().catch(() => undefined);
  }

  /** 结果验收（T05，PC08/§9.4）：父执行器记录 accepted / needs_revision /
   *  rejected，绑定子结果版本（childRevision=验收时的记录 revision）。
   *  消费 ≠ 接受——drain 只代表看到了结果；验收是显式动作。needs_revision/
   *  rejected 不解除交付门禁：须 re-spawn（replacesChildId 关联替代）或复核
   *  改判 accepted。仅终态子可验收；scope 树外拒绝。 */
  async reviewChild(childId: string, decision: "accepted" | "needs_revision" | "rejected", input: { note?: string; evidenceRefs?: string[] } = {}, scope?: { rootTaskId: string }): Promise<SubagentRecord> {
    for (;;) {
      const rec = await this.store.getSubagent(childId);
      if (!rec) throw new Error(`子代理不存在：${childId}`);
      if (scope && rec.rootTaskId !== scope.rootTaskId) throw new Error(`SCOPE_VIOLATION：childId 不在当前任务树内：${childId}`);
      if (!isSubagentTerminal(rec.status)) throw new Error(`子代理尚未终态（${rec.status}），不能验收`);
      const reviewedAt = new Date().toISOString();
      try {
        return await this.store.updateSubagent(childId, rec.revision, {
          consumeState: decision,
          review: { decision, ...(input.note ? { note: input.note } : {}), ...(input.evidenceRefs?.length ? { evidenceRefs: input.evidenceRefs } : {}), reviewedAt, childRevision: rec.revision },
        });
      } catch (error) {
        if (/SUBAGENT_REVISION_CONFLICT/.test(String(error))) continue; // CAS 重试
        throw error;
      }
    }
  }

  /** agent_list：当前树内子代理 + 最近进度。 */
  async list(rootTaskId: string): Promise<SubagentRecord[]> {
    const all = await this.store.listSubagents({ rootTaskId });
    return all.map((r) => ({ ...r }));
  }

  /** agent_send：幂等投递；按子代理状态真正进入子上下文（T04，PC07）——
   *  queued：launch 时随原始 prompt 注入（见 launch 的消息组装）；
   *  活跃 run：经 deliverToChild 投递（宿主接 runner.prompt——活动会话的
   *    FIFO queued prompt 即安全边界，requestId=messageId 幂等）；
   *  waiting_input（无活跃 run）：重新入队，runChild 携带新消息续跑；
   *  waiting_permission/waiting_external/blocked：只落邮箱——普通消息不得
   *    替代审批或解除安全阻塞（spec §8.2 出口互不替代）。
   *  终态拒绝（CHILD_TERMINAL）；scope（T03）：树外 childId 拒绝。 */
  async send(childId: string, payload: string, kind: "constraint" | "user_input" = "constraint", messageId = randomUUID(), scope?: { rootTaskId: string }): Promise<{ delivered: boolean; reason?: string }> {
    const rec = await this.store.getSubagent(childId);
    if (!rec) return { delivered: false, reason: "CHILD_NOT_FOUND" };
    if (scope && rec.rootTaskId !== scope.rootTaskId) return { delivered: false, reason: "CHILD_OUT_OF_SCOPE" };
    if (isSubagentTerminal(rec.status)) return { delivered: false, reason: "CHILD_TERMINAL" }; // 不复活旧子代理（spec §8.2）
    await this.store.appendMessage({ messageId, childId, direction: "to_child", kind, payload, createdAt: new Date().toISOString() });
    if (rec.status === "queued") return { delivered: true };
    if (this.active.has(childId)) {
      await this.deps.deliverToChild?.(rec.childSessionId, payload, messageId);
      return { delivered: true };
    }
    if (rec.status === "waiting_input" && !this.queue.some((q) => q.childId === childId)) {
      this.queue.push({ childId, rootTaskId: rec.rootTaskId, prompt: rec.prompt ?? rec.goal });
      this.pump();
    }
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

  /** 根 Task 取消（§8.4 父取消→全部后代）：先关 admission 闸（该根的排队者
   *  不再被 pump 启动——「取消瞬间被 pump 抢跑」是实测竞态），再递归收尾。 */
  async cancelTree(rootTaskId: string): Promise<void> {
    this.admissionCutoff.add(rootTaskId);
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
      // T05（PC09）：根取消截止的二次检查——pump 认领与 launch 之间取消可能
      // 恰好落闸；命中即放弃启动（finally 释放许可）。
      if (this.admissionCutoff.has(item.rootTaskId)) return;
      let rec = await this.store.getSubagent(item.childId);
      if (!rec || isSubagentTerminal(rec.status) || rec.status === "cancelling") return;
      rec = await this.store.updateSubagent(item.childId, rec.revision, { status: "running", times: { ...rec.times, startedAt: new Date().toISOString() } });
      let resolveDone!: () => void;
      done = new Promise<void>((resolve) => { resolveDone = resolve; });
      settle = resolveDone;
      this.active.set(item.childId, { abort: () => undefined, done });
      // T04（PC07）：子上下文组装——原始 prompt + 全部 to_child 消息（agent_send
      //  落邮箱的补充约束/用户输入）。重跑（waiting_input 续跑/恢复）时重复注入
      //  旧约束幂等无害；新消息按时间序追加。
      const supplements = (await this.store.listMessages(item.childId).catch(() => [] as never[]))
        .filter((m) => m.direction === "to_child");
      const prompt = supplements.length > 0
        ? `${item.prompt}\n\n[父代理追加输入（按时间序，最新在后）]\n${supplements.map((m) => `- (${m.kind}) ${m.payload}`).join("\n")}`
        : item.prompt;
      // T03（PC02）：runChild 返回结构化 outcome——失败/取消/阻塞与完成一样是
      // 显式声明，禁止按 Promise 正常返回推断成功（F02 修复的框架侧契约）。
      const outcome = await this.deps.runChild(item.childId, prompt);
      const latest = await this.store.getSubagent(item.childId);
      if (!latest) return;
      if (latest.status === "cancelling") {
        await this.settleTerminal(latest, { status: "cancelled" });
      } else {
        const settled = projectChildRunOutcome(outcome);
        if (isSubagentTerminal(settled.status)) {
          // T04（spec §4.2）：子终态 + to_parent 结果邮件同事务，成功后触发
          // 父唤醒意图钩子（宿主接 requestInternalResume——PC05 的接线点）。
          await this.settleTerminal(latest, {
            status: settled.status,
            ...(settled.result ? { result: settled.result } : {}),
            ...(settled.blockerReason ? { blockerReason: settled.blockerReason } : {}),
          });
        } else {
          // waiting_*：非终态，无结果邮件（出口互不替代，spec §8.2）
          await this.store.updateSubagent(item.childId, latest.revision, {
            status: settled.status,
            ...(settled.blockerReason ? { blockerReason: settled.blockerReason } : {}),
          });
        }
      }
    } catch (error) {
      const latest = await this.store.getSubagent(item.childId);
      if (latest && !isSubagentTerminal(latest.status)) {
        const message = error instanceof Error ? error.message : String(error);
        await this.settleTerminal(latest, { status: "failed", blockerReason: message, result: { outcome: "failed", summary: `失败：${message}` } }).catch(() => undefined);
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

  /** 终态结算（T04，spec §4.2）：状态 + to_parent 结果邮件**同事务**落库
   *  （settleSubagent），成功后触发唤醒钩子。messageId 由 childId + 结算后
   *  revision 派生——同 child 重放结算天然幂等（INSERT OR IGNORE）。 */
  private async settleTerminal(latest: SubagentRecord, patch: { status: SubagentStatus; result?: SubagentRecord["result"]; blockerReason?: string }): Promise<void> {
    const settled = await this.store.settleSubagent(latest.childId, latest.revision, {
      ...patch,
      times: { ...latest.times, endedAt: new Date().toISOString() },
    }, {
      messageId: `result_${latest.childId}_${latest.revision + 1}`,
      childId: latest.childId,
      direction: "to_parent",
      kind: "result",
      payload: JSON.stringify({ outcome: patch.result?.outcome ?? patch.status, summary: patch.result?.summary ?? "", childId: latest.childId }),
      createdAt: new Date().toISOString(),
    });
    try {
      this.deps.onChildTerminal?.(settled, settled.parentSessionId);
    } catch {
      // 唤醒钩子失败不影响终态结算（邮箱里已有结果，父侧可经其它路径续跑）
    }
    this.notifyWaiters();
  }
}
