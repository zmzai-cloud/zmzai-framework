import { createHash } from "node:crypto";

import type { TaskRecord, TaskStep, AcceptanceCriterion, TaskEvidence } from "./types.js";

/** 跨 Attempt 的进度指纹与空转检测（规格 3 §10.1）。
 *
 * 【为什么不能把 TaskRecord.revision 算进指纹】规格 §10.1 列出的指纹要素里
 * 第一条是「Task revision」。照字面实现会让 no-progress 保护彻底失效：每次
 * Attempt 收尾都要把状态写回（running → verifying → running），revision 必然
 * 自增，于是「两轮之间没有进展」这个条件永远不成立，§10.1 的 1/2/3 档保护
 * 全成了死代码。
 *
 * 规格要防的是「模型原地打转」，而原地打转的客观表现是：步骤状态没动、验收
 * 状态没动、没有新证据、没有新改动。所以指纹取这些**语义要素**，revision
 * 只作为「谁改过」的元数据保留在 TaskRecord 上供 CAS 用。 */

export type ProgressFingerprintInput = {
  task: TaskRecord;
  /** 本轮 Attempt 编辑/写入过的文件路径（已去重）。 */
  editedFiles: readonly string[];
  /** 本轮 Attempt 的工具调用次数。 */
  toolCalls: number;
};

/** 稳定序列化：步骤与条件按 id 排序，避免「顺序变了但内容没变」被误判成进展。 */
function canonical(parts: readonly (readonly [string, unknown])[]): string {
  return JSON.stringify(parts.map(([key, value]) => [key, value]));
}

function stepShape(steps: readonly TaskStep[]): readonly (readonly [string, unknown])[] {
  return [...steps]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((step) => [step.id, `${step.status}:${step.evidenceIds.length}`] as const);
}

function criterionShape(criteria: readonly AcceptanceCriterion[]): readonly (readonly [string, unknown])[] {
  return [...criteria]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((criterion) => [criterion.id, `${criterion.status}:${criterion.evidenceIds.length}`] as const);
}

/** 证据的形状：只看**它是什么、对着谁**，不看它被分配的随机 id。
 *
 *  【为什么不带 id】id 是 uuid，任何一条新证据都会让指纹变化——包括模型每轮
 *  重新说一遍自己的答案。那等于把「模型又开口了」算成进展，no-progress 保护
 *  就永远触发不了（实测：一个纯聊天的模型可以这样刷满 24 轮 Attempt 上限）。
 *  按 (kind, ref) 取值后，「又跑了一遍同一个 pnpm build」不再算进展，而
 *  「改了另一个文件」仍然算——这才是 §10.1 想抓的语义差别。
 *
 *  【为什么排除 model_observation】它是完成判定的口子（规格 §9 末段：没有工具
 *  可跑的任务，最终内容本身是唯一可验证的东西），但它**恰恰是没有外部验证**的
 *  那一类。让它进指纹，上面那个洞会原样复现。它的作用是满足「每个关键条件有
 *  一条证据」，不是证明任务在前进——两个目的，两类处理。 */
function evidenceShape(evidence: readonly TaskEvidence[]): readonly (readonly [string, unknown])[] {
  return [...evidence]
    .filter((item) => item.kind !== "model_observation")
    .sort((a, b) => `${a.kind}\u0000${a.ref ?? ""}`.localeCompare(`${b.kind}\u0000${b.ref ?? ""}`))
    .map((item) => [item.kind, item.ref ?? null] as const);
}

/**
 * 计算本次 Attempt 结束后的进度指纹。
 *
 * 刻意**不含**工具调用次数：模型完全可以用 30 次无意义的 read 把计数刷上去。
 * 工具调用只在「产生了上面这些可观测变化」时才意味着进展。
 */
export function taskFingerprint(input: ProgressFingerprintInput): string {
  const { task } = input;
  const payload = canonical([
    ["steps", stepShape(task.steps)],
    ["criteria", criterionShape(task.acceptanceCriteria)],
    ["evidence", evidenceShape(task.evidence)],
    ["files", [...input.editedFiles].sort()],
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

export type ProgressAdvance = {
  /** 指纹是否与上一轮不同（true = 有进展）。 */
  progressed: boolean;
  /** 下一次比较用的指纹。 */
  fingerprint: string;
  /** 更新后的 noProgressCount（有进展清零）。 */
  noProgressCount: number;
};

/**
 * 比较本轮指纹与 `task.lastFingerprint`，给出新的 noProgressCount。
 *
 * 纯函数——不改 task，由调用方决定何时落库（CAS 更新）。
 * 首次指纹（lastFingerprint 为 undefined）视为有进展：任务刚起步，
 * 第一轮就计一次「无进展」会让所有任务都从 1 开始倒数。
 */
export function advanceProgress(task: TaskRecord, input: Omit<ProgressFingerprintInput, "task">): ProgressAdvance {
  const fingerprint = taskFingerprint({ task, ...input });
  const progressed = task.lastFingerprint === undefined || task.lastFingerprint !== fingerprint;
  return {
    progressed,
    fingerprint,
    noProgressCount: progressed ? 0 : task.noProgressCount + 1,
  };
}
