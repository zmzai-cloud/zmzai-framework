import type { SessionInfo } from "../session/types.js";
import type { WorkflowState } from "../session/workflow.js";

/** 子代理协调记录（spec §8.2 SubagentRecord，M3-S17）。
 *
 *  与 childSession 的分工：本记录是**协调状态**（谁派的、什么状态、结果
 *  被父消费没有）；childSession 保留 transcript；子会话自身的 TaskRecord
 *  （如存在）负责其任务语义。协调器从实际执行终态生成 result，不建立
 *  第二套完成判断。 */
export type SubagentStatus =
  | "queued" | "running" | "waiting_permission" | "waiting_input" | "waiting_external"
  | "cancelling" | "recovering" | "blocked" | "completed" | "failed" | "cancelled";

export type SubagentConsumeState = "pending_review" | "accepted" | "needs_revision" | "rejected";

export type SubagentRecord = {
  /** 协调主键 = childSessionId（spec：spawn 幂等键锚点）。 */
  childId: string;
  childSessionId: string;
  parentSessionId: string;
  /** 根任务与父任务归属（取消树/预算聚合的键）。 */
  rootTaskId: string;
  parentTaskId: string;
  /** 同 spawnRequestId 重试返回同一 child（不重复派生，spec A14）。 */
  spawnRequestId: string;
  agentType: string;
  goal: string;
  mode: "read_only" | "workspace_write";
  /** 共享工作区（B0 不做子 worktree）。 */
  workspaceId: string;
  status: SubagentStatus;
  /** CAS 凭据：并发更新（协调器 vs 取消 vs 权限回调）必须带 revision。 */
  revision: number;
  runId?: string;
  executionEpoch?: number;
  traceId: string;
  times: { spawnedAt: string; startedAt?: string; endedAt?: string };
  result?: {
    outcome: "completed" | "failed" | "cancelled";
    summary: string;
    evidenceRefs?: string[];
    /** 撤回的 replacesChildId（返工时关联，spec §9.4）。 */
    replacesChildId?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  /** 父验证状态（§9.4）：消费 ≠ 接受。 */
  consumeState?: SubagentConsumeState;
  /** 取消/阻塞原因（blocked 时必填，spec：不伪装完成）。 */
  blockerReason?: string;
};

/** 邮箱消息（§8.2 父结果投递 / agent_send 双向共用一张表，方向字段区分）。 */
export type SubagentMessage = {
  messageId: string;
  /** 收件 childId（父→子补充 或 子→父结果都是「投到该 child 的信箱」，
   *  父侧读取按 rootTaskId 聚合水位）。 */
  childId: string;
  direction: "to_child" | "to_parent";
  kind: "user_input" | "constraint" | "result" | "system";
  payload: string;
  /** 契约版本：补充消息改变约束时递增（spec §9.4）。 */
  contractRevision?: number;
  createdAt: string;
  /** 父执行器已纳入上下文的水位标记（幂等合并的基准，S19）。 */
  consumedByParent?: boolean;
};

/** SubagentStore：与 tasks 同级的项目 SQLite 面（M3-S17）。
 *  所有写操作 CAS（expectedRevision 不符抛 SUBAGENT_REVISION_CONFLICT）；
 *  spawn 登记与 childSession 关联须在**同一事务**（spec §8.2）。 */
export interface SubagentStore {
  createSubagent(record: SubagentRecord): Promise<SubagentRecord>;
  getSubagent(childId: string): Promise<SubagentRecord | null>;
  /** 按 spawnRequestId 幂等查找（重试路径，A14）。 */
  findSubagentBySpawnRequest(parentSessionId: string, spawnRequestId: string): Promise<SubagentRecord | null>;
  /** CAS 更新；非法状态迁移（如 completed → running）抛 SUBAGENT_INVALID_TRANSITION。 */
  updateSubagent(childId: string, expectedRevision: number, patch: Partial<SubagentRecord>): Promise<SubagentRecord>;
  listSubagents(filter: { rootTaskId?: string; parentSessionId?: string; statuses?: SubagentStatus[] }): Promise<SubagentRecord[]>;
  appendMessage(message: SubagentMessage): Promise<void>;
  /** messageId 去重：同 messageId 重复投递是 no-op（至少一次投递 + 幂等消费）。 */
  listMessages(childId: string, options?: { sinceCreatedAt?: string }): Promise<SubagentMessage[]>;
  /** 父消费水位标记（S19：唤醒合并的幂等基准）。 */
  markMessagesConsumedByParent(childId: string, upToCreatedAt: string): Promise<void>;
}

/** 状态机合法迁移表（非法即抛，绝不静默）。 */
const TRANSITIONS: Record<SubagentStatus, SubagentStatus[]> = {
  queued: ["running", "cancelling", "cancelled", "failed"],
  running: ["waiting_permission", "waiting_input", "waiting_external", "blocked", "cancelling", "cancelling", "completed", "failed", "recovering"],
  waiting_permission: ["running", "cancelling", "cancelled"],
  waiting_input: ["running", "cancelling", "cancelled"],
  waiting_external: ["running", "cancelling", "cancelled"],
  cancelling: ["cancelled", "failed"],
  recovering: ["queued", "blocked", "cancelling", "cancelled"],
  blocked: ["queued", "running", "cancelling", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function assertSubagentTransition(from: SubagentStatus, to: SubagentStatus): void {
  if (from === to) return; // 幂等更新（revision 仍递增）
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(`SUBAGENT_INVALID_TRANSITION: ${from} → ${to}`);
  }
}

export function isSubagentTerminal(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** 新记录工厂（childId = childSessionId，同键）。 */
export function newSubagentRecord(input: {
  childSessionId: string; parentSessionId: string; rootTaskId: string; parentTaskId: string;
  spawnRequestId: string; agentType: string; goal: string; mode: "read_only" | "workspace_write";
  workspaceId: string; traceId: string;
}): SubagentRecord {
  return {
    childId: input.childSessionId,
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    rootTaskId: input.rootTaskId,
    parentTaskId: input.parentTaskId,
    spawnRequestId: input.spawnRequestId,
    agentType: input.agentType,
    goal: input.goal,
    mode: input.mode,
    workspaceId: input.workspaceId,
    status: "queued",
    revision: 1,
    traceId: input.traceId,
    times: { spawnedAt: new Date().toISOString() },
  };
}
