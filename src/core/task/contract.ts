import type { TaskRecord, TaskResult, TaskStep } from "./types.js";

/** 任务契约的上下文表达（规格 3 §8.2 / §6）。
 *
 * 【为什么放进 systemPrompt 而不是一条 user 消息】规格 §19 明文禁止「用新增
 * 一条伪用户消息作为内部 continuation」。除了「不许伪造用户说过的话」这条
 * 原则，还有三个实际后果：伪用户消息会落库、会出现在聊天记录里（用户看到
 * 自己没发过的话）、会被计入 token 与消息序号、rewind 时会跟着一起被截断。
 * 作为系统指令注入则完全不碰消息流。
 *
 * 每个 Attempt 重新注入一次，因此上下文被压缩掉也不影响任务契约的存续
 * （规格 §6「必须进入上下文压缩后的恢复上下文」）。 */

function stepLine(step: TaskStep): string {
  const mark = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[~]" : step.status === "cancelled" ? "[-]" : "[ ]";
  return `${mark} ${step.title}`;
}

/** 剩余步骤（非终态的）。cancelled/completed 不进「剩余」。 */
export function remainingSteps(task: TaskRecord): TaskStep[] {
  return task.steps.filter((step) => step.status === "pending" || step.status === "in_progress" || step.status === "blocked");
}

/** 渲染任务契约。`advisory` 传入时追加在末尾——续跑指令与契约同源，
 *  避免出现两处互相矛盾的指示。 */
export function taskContractText(task: TaskRecord, advisory?: string): string {
  const lines: string[] = [];
  lines.push("<task-contract>");
  lines.push(`目标：${task.goal}`);
  if (task.constraints.length) {
    lines.push("用户追加的约束：");
    for (const constraint of task.constraints) lines.push(`- ${constraint}`);
  }
  const required = task.acceptanceCriteria.filter((criterion) => criterion.required);
  if (required.length) {
    lines.push("验收条件（全部满足才算完成）：");
    for (const criterion of required) lines.push(`- ${criterion.description}${criterion.status === "passed" ? "（已通过）" : ""}`);
  }
  if (task.steps.length) {
    lines.push("任务计划：");
    for (const step of task.steps) lines.push(stepLine(step));
  }
  const remaining = remainingSteps(task);
  if (remaining.length) {
    lines.push(`剩余步骤：${remaining.map((step) => step.title).join("、")}`);
  }
  if (task.evidence.length) {
    lines.push("已有验证证据：");
    for (const item of task.evidence.slice(-8)) lines.push(`- [${item.kind}] ${item.summary}`);
  }
  if (task.blocker) {
    lines.push(`当前阻塞（${task.blocker.kind}）：${task.blocker.message}`);
    lines.push(`需要做的事：${task.blocker.requiredAction}`);
  }
  lines.push(
    "继续执行这件事，直到验收条件全部满足并留下证据。不要在中途把控制权交回用户——",
    "只有确实需要用户授权、补充信息或处理外部状态（登录、验证码、付款）时才停下，并说明卡在哪里、需要用户做什么。",
  );
  if (advisory) lines.push("", advisory);
  lines.push("</task-contract>");
  return lines.join("\n");
}

/** 首次 Attempt 的任务契约（无 advisory）。 */
export function initialTaskContract(task: TaskRecord): string {
  return taskContractText(task);
}

/** 交付摘要的兜底文本：模型没产出结构化交付信息时，由任务记录本身生成
 *  「做了什么」。此时**不使用任何完成性措辞**——规格 §18.7 要求交付信息
 *  必须包含结果/改动/验证/剩余项，一段编出来的「已全部完成」比一段朴实的
 *  统计更糟。 */
export function fallbackResult(input: {
  task: TaskRecord;
  filesEdited: readonly string[];
  toolCalls: number;
}): TaskResult {
  const { task, filesEdited, toolCalls } = input;
  const completed = task.steps.filter((step) => step.status === "completed");
  const remaining = remainingSteps(task).map((step) => step.title);
  return {
    outcome: `完成了 ${completed.length} 个步骤、${toolCalls} 次工具调用。`,
    changes: [...filesEdited],
    verification: task.evidence.slice(-6).map((item) => item.summary),
    remaining,
  };
}

/** 把结构化交付信息渲染成给用户看的文本（规格 §21 最终交付示例）。 */
export function renderResult(result: TaskResult): string {
  const lines: string[] = [result.outcome];
  if (result.changes.length) lines.push(`改动：${result.changes.join("、")}`);
  if (result.verification.length) lines.push(`验证：${result.verification.join("；")}`);
  lines.push(`剩余项：${result.remaining.length ? result.remaining.join("、") : "无"}`);
  return lines.join("\n");
}
