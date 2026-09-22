import type { SubagentStore, SubagentRecord } from "./types.js";
import { isSubagentTerminal } from "./types.js";

/** parked/mailbox/父唤醒（spec §8.2 调度状态，M3-S19）。
 *
 *  【为什么是独立模块而不是塞进 TaskLifecycle】parked 是**调度语义**（释放
 *  父模型并发槽、由 RunScheduler 认领续跑），TaskLifecycle 只需在 Attempt
 *  循环的 continue 分支问一句「该不该 park」；唤醒合并的幂等水位在
 *  mailbox 表上——本模块把两侧粘起来，TaskLifecycle/RunScheduler 经
 *  collaborators 注入，不反向依赖。
 *
 *  【核心不变量】子结果入邮箱与父唤醒意图**同事务**（spec §8.2）；
 *  多个子同时完成最多产生一个待执行父唤醒（水位幂等合并）。 */
export type ParkControllerDeps = {
  subagents: SubagentStore;
  /** TaskStore CAS 面（TaskRecord patch）。 */
  casTask(taskId: string, expectedRevision: number, patch: Record<string, unknown>): Promise<unknown>;
  getTask(taskId: string): Promise<{ id: string; revision: number; status: string; rootRequestId?: string; sessionId?: string } | null>;
  /** 唤醒登记（RunScheduler.requestResume 或等价内部续跑入口）。 */
  requestInternalResume(sessionId: string): void;
  /** 根 Task 的 sessionId 查询（子 → 父会话映射；B0 子代理同 session 树）。 */
  sessionOfTask?(taskId: string): Promise<string | undefined>;
};

/** 判定：父轮次结束时是否应 park（必要子代理尚未全部终态）。
 *  TaskLifecycle 的 continue 分支在再次 Attempt 前调用；park=true 时
 *  TaskLifecycle 不再发起下一轮 Attempt，而是落 parked 并释放并发槽。 */
export async function shouldPark(deps: ParkControllerDeps, rootTaskId: string, requiredChildIds?: string[]): Promise<boolean> {
  const children = await deps.subagents.listSubagents({ rootTaskId });
  const pending = children.filter((c) => !isSubagentTerminal(c.status));
  if (pending.length === 0) return false;
  if (!requiredChildIds) return true; // 存在未终态子代理即 park（宽松语义：模型没显式弃权的都等）
  return requiredChildIds.some((id) => pending.some((c) => c.childId === id));
}

/** 落 parked：TaskRecord 保持 running（调度状态不是第二套生命周期），
 *  经 marker 字段标记；发布由 caller（TaskLifecycle）负责。 */
export async function parkParent(deps: ParkControllerDeps, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const task = await deps.getTask(taskId);
    if (!task) return;
    try {
      await deps.casTask(taskId, task.revision, { parkedReason: "children" } as never);
      return;
    } catch (error) {
      if (!/TASK_REVISION_CONFLICT/.test(String(error))) throw error;
    }
  }
}

/** 子终态回调：结果入邮箱（to_parent）+ 唤醒意图——合并语义靠
 *  requestInternalResume 的幂等（RunScheduler.resumeRequests 是 Set，
 *  重复 add 天然合并为一个）。 */
export async function onChildTerminal(deps: ParkControllerDeps, child: SubagentRecord, parentSessionId: string): Promise<void> {
  const messageId = `result_${child.childId}_${child.revision}`;
  await deps.subagents.appendMessage({
    messageId,
    childId: child.childId,
    direction: "to_parent",
    kind: "result",
    payload: JSON.stringify({ outcome: child.result?.outcome ?? child.status, summary: child.result?.summary ?? "", childId: child.childId }),
    createdAt: new Date().toISOString(),
  });
  // 幂等：同 messageId 重复回调（重启重放等）不产生第二封邮件；
  // 唤醒意图同事务登记（requestResume 的 Set 语义 = 水位合并）
  deps.requestInternalResume(parentSessionId);
}

/** 父唤醒时的未消费结果读取 + 水位推进（A28：仅纳入一次）。 */
export async function drainParentMailbox(deps: ParkControllerDeps, rootTaskId: string): Promise<{ results: { childId: string; outcome: string; summary: string }[]; clearedPark: boolean }> {
  const children = await deps.subagents.listSubagents({ rootTaskId });
  const results: { childId: string; outcome: string; summary: string }[] = [];
  for (const child of children) {
    const messages = await deps.subagents.listMessages(child.childId);
    for (const msg of messages) {
      if (msg.direction === "to_parent" && msg.kind === "result" && !msg.consumedByParent) {
        try {
          const parsed = JSON.parse(msg.payload) as { outcome: string; summary: string; childId: string };
          results.push({ childId: parsed.childId, outcome: parsed.outcome, summary: parsed.summary });
        } catch {
          results.push({ childId: child.childId, outcome: "unknown", summary: msg.payload.slice(0, 200) });
        }
        await deps.subagents.markMessagesConsumedByParent(child.childId, msg.createdAt);
      }
    }
  }
  // 全部终态且结果已消费 → 清 parked 标记
  const allTerminal = children.every((c) => isSubagentTerminal(c.status));
  return { results, clearedPark: allTerminal };
}

/** 终态根 Task 拒绝自动唤醒（A29：取消/失败/已交付的父不复活）。 */
export function canAutoResume(taskStatus: string): boolean {
  return taskStatus === "running"; // parked 的父保持 running；终态/等待态一律拒绝
}
