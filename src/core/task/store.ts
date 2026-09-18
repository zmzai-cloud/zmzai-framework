import { isActiveStatus, isTerminalStatus, newTaskId, type CreateTaskInput, type TaskPatch, type TaskRecord } from "./types.js";
import { defaultCriteriaFor, newTaskRecord } from "./plan.js";

/** TaskStore（规格 3 §13.4）。
 *
 * 与 `SessionStore`/`WorkflowStore` 并列，通过 `SessionStore.task` 暴露。
 * 三个必须由实现保证的不变量：
 *
 * 1. **CAS**：`updateTask` 带 `expectedRevision`，版本不符即抛错。两个 runner
 *    同时推进同一任务时，慢的那个必须失败而不是覆盖——否则步骤状态会互相
 *    回退，Completion Gate 读到的是一个从未真实存在过的中间态。
 * 2. **同 session 最多一个 active root task**（规格 §6 / §18.9）：两个活跃
 *    任务会并行改同一个工作区。
 * 3. **requestId 幂等**（规格 §13.1 / §17.1.11）：重复提交返回同一个任务，
 *    不创建第二个，也不追加第二条用户消息。 */
export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  /** 当前活跃任务（未进终态）。无则 null。 */
  getActiveTask(sessionId: string): Promise<TaskRecord | null>;
  /** 最近一个进入终态的任务（`GET /task` 在无活跃任务时回退到它）。 */
  getLatestTask(sessionId: string): Promise<TaskRecord | null>;
  /** CAS 更新；`expectedRevision` 不匹配时抛 `TASK_REVISION_CONFLICT`。 */
  updateTask(taskId: string, expectedRevision: number, patch: TaskPatch): Promise<TaskRecord>;
  listTasks(sessionId: string): Promise<TaskRecord[]>;
  /** 按 rootRequestId 查（幂等键）。 */
  findTaskByRequestId(sessionId: string, requestId: string): Promise<TaskRecord | null>;
}

export const TASK_REVISION_CONFLICT = "TASK_REVISION_CONFLICT";

/** 应用补丁 + 递增 revision。纯函数——各个 store 实现共用，避免三处各写一份
 *  递增逻辑（漏掉一处就会出现「某些路径不更新 revision」的隐性 CAS 失效）。 */
export function applyTaskPatch(task: TaskRecord, patch: TaskPatch, now: string): TaskRecord {
  const merged: TaskRecord = {
    ...task,
    ...patch,
    id: task.id,
    sessionId: task.sessionId,
    createdAt: task.createdAt,
    revision: task.revision + 1,
    updatedAt: now,
  };
  // blocker 用 undefined 显式清除；展开运算会把它带成 undefined 字段，
  // 序列化后仍占一个键。统一归一化，保证「无阻塞」只有一种表示。
  if (patch.blocker === undefined) delete merged.blocker;
  return merged;
}

export function createTaskRecord(input: CreateTaskInput, now: string): TaskRecord {
  const base = newTaskRecord({
    id: newTaskId(),
    sessionId: input.sessionId,
    rootRequestId: input.rootRequestId,
    rootUserMessageId: input.rootUserMessageId,
    goal: input.goal,
    now,
  });
  return {
    ...base,
    ...(input.steps?.length ? { steps: [...input.steps] } : {}),
    acceptanceCriteria: input.acceptanceCriteria?.length ? [...input.acceptanceCriteria] : defaultCriteriaFor(input.goal),
  };
}

/** 内存实现：参考实现 + 单测用。语义与 SQLite 实现逐条对齐。 */
export function createMemoryTaskStore(options?: { now?: () => string }): TaskStore {
  const tasks = new Map<string, TaskRecord>();
  const now = options?.now ?? (() => new Date().toISOString());

  function cloneOf(task: TaskRecord): TaskRecord {
    return structuredClone(task);
  }

  function activeOf(sessionId: string): TaskRecord | null {
    for (const task of tasks.values()) {
      if (task.sessionId === sessionId && isActiveStatus(task.status)) return task;
    }
    return null;
  }

  return {
    async createTask(input) {
      const existing = await this.findTaskByRequestId(input.sessionId, input.rootRequestId);
      if (existing) return existing;
      // 同一 session 已有活跃任务时不新建（调用方应先做 steering/排队判定）
      const active = activeOf(input.sessionId);
      if (active && active.rootRequestId !== input.rootRequestId) {
        throw new Error("TASK_ALREADY_ACTIVE");
      }
      const record = createTaskRecord(input, now());
      tasks.set(record.id, record);
      return cloneOf(record);
    },
    async getTask(taskId) {
      const task = tasks.get(taskId);
      return task ? cloneOf(task) : null;
    },
    async getActiveTask(sessionId) {
      const task = activeOf(sessionId);
      return task ? cloneOf(task) : null;
    },
    async getLatestTask(sessionId) {
      const candidates = [...tasks.values()]
        .filter((task) => task.sessionId === sessionId && isTerminalStatus(task.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return candidates[0] ? cloneOf(candidates[0]) : null;
    },
    async updateTask(taskId, expectedRevision, patch) {
      const current = tasks.get(taskId);
      if (!current) throw new Error("TASK_NOT_FOUND");
      if (current.revision !== expectedRevision) throw new Error(TASK_REVISION_CONFLICT);
      const updated = applyTaskPatch(current, patch, now());
      tasks.set(taskId, updated);
      return cloneOf(updated);
    },
    async listTasks(sessionId) {
      return [...tasks.values()]
        .filter((task) => task.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(cloneOf);
    },
    async findTaskByRequestId(sessionId, requestId) {
      for (const task of tasks.values()) {
        if (task.sessionId === sessionId && task.rootRequestId === requestId) return cloneOf(task);
      }
      return null;
    },
  };
}
