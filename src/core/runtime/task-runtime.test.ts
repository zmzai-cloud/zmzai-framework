import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { AgentRegistry } from "../agent/registry.js";
import { SessionRunner, createFrameworkSession, type RunnerDeps } from "../runtime/runner.js";
import { createSqliteEventLog } from "../events/sqlite-event-log.js";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import type { PersistedFrameworkEvent } from "../events/manifest.js";
import type { WorkspaceFiles } from "../tools/context.js";

/** 持续任务执行的运行时集成测试（规格 3 §17.1 的 3/4/5/6/7/10/11 条）。
 *
 *  【为什么单独一个文件、且必须用 SQLite store】这些断言全部落在**任务层**上：
 *  TaskRecord 的终态、workflow run 的条数、事件序列的形状。内存 store 没有
 *  `task` / `workflow` 能力，注入它只会让 runner 退化成一次性运行（那条路径
 *  当然也要保留，但它证明不了这些行为）。用真实的 SQLite 实现顺带把
 *  CAS、`UNIQUE(session_id, request_id)`、事务性一并覆盖了。 */

type Published = PersistedFrameworkEvent[];

function fakeWorkspace(): WorkspaceFiles {
  return {
    list: vi.fn().mockResolvedValue([{ path: "a.ts", bytes: 10 }]),
    read: vi.fn().mockResolvedValue({ path: "a.ts", content: "const a = 1;" }),
    write: vi.fn().mockResolvedValue({ revisionId: "rev_1", diff: "diff" }),
    edit: vi.fn().mockResolvedValue({ revisionId: "rev_2", diff: "diff2" }),
  };
}

async function taskHarness(script: ReturnType<typeof fauxAssistantMessage>[], policy?: RunnerDeps["taskPolicy"]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "task-runtime-"));
  const faux = createFauxCore({ models: [{ id: "test-model" }] });
  faux.setResponses(script);
  const store = createSqliteSessionStore({ dataDir });
  const eventLog = createSqliteEventLog({ dataDir });
  const deps: RunnerDeps = {
    store,
    registry: new AgentRegistry(),
    streamFnFor: () => faux.streamSimple as never,
    modelFor: () => faux.getModel() as never,
    eventLog,
    workspaceFor: () => fakeWorkspace(),
    sandbox: {
      buildSnapshot: vi.fn().mockResolvedValue({ revisionId: null, files: [] }),
      run: vi.fn().mockResolvedValue({ ok: true, exitCode: 0, outputText: "构建成功", durationMs: 5, artifacts: [] }),
    },
    subagentDepth: 0,
    ...(policy ? { taskPolicy: policy } : {}),
  };
  const runner = new SessionRunner(deps);
  const session = await createFrameworkSession({
    store,
    userId: "user_1",
    workspaceId: "ws_1",
    model: { providerId: "faux", modelId: "test-model" },
    prompt: "任务",
  });
  /** 从**持久事件**读回整个会话的事件流。断线重连后客户端就是这么恢复任务
   *  进度的（规格 §13.3），所以断言也走这条路，而不是去戳 runner 的内部状态。 */
  const events = async (): Promise<Published> => await eventLog.read(session.id, 0, 10_000);
  return {
    runner,
    store,
    session,
    faux,
    events,
    // 这套 harness 就是为了任务层而存在的：把它需要的两个能力显式暴露出来，
    // 测试里不必到处写 `!` 断言「我知道它一定在」。
    tasks: store.task!,
    workflow: store.workflow!,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const typesOf = (events: Published): string[] => events.map((event) => event.type);
const countOf = (events: Published, type: string): number => events.filter((event) => event.type === type).length;

async function userMessageCount(store: ReturnType<typeof createSqliteSessionStore>, sessionId: string): Promise<number> {
  const entries = await store.getMessages(sessionId);
  return entries.filter((entry) => entry.info.role === "user").length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("任务运行时：续跑与交付", () => {
  // §17.1.3 / §17.1.4：模型连续正常 stop，但每次仍有剩余步骤时自动续跑，
  // 且续跑沿用同一个 task 与 rootRequestId，**不新增用户消息**。
  it("模型一次正常停止不算完成：仍有未完成步骤时自动续跑，且不新增用户消息", async () => {
    // 【脚本为什么是四段而不是三段】一次 Attempt 内部是一个 agent 循环：模型只要
    // 还在调工具就一直跑下去，直到它给出一个不含工具调用的回复才算停。所以
    // 「模型停了」必须用一个**纯文本回复**来表达，而不是「一次 todo 调用结束」。
    // 这里第 2 段就是那个停止点：它停了，但步骤还没做完。
    const h = await taskHarness([
      fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "解析 PDF", status: "in_progress" }] })]),
      fauxAssistantMessage("PDF 已解析 12 页，先把正文落下来，下一步补图片。"),
      fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "解析 PDF", status: "completed" }] })]),
      fauxAssistantMessage("PDF 正文与图片已铺到网页，本地构建通过。"),
    ]);
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_continuation", text: "把这份 PDF 的内容铺到网页并验证可用" });
      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1);

      const events = await h.events();
      const tasks = await h.tasks.listTasks(h.session.id);
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;

      // 交付发生在第 2 轮，而不是第 1 轮模型刚说完话就宣布完成
      expect(task.status).toBe("delivered");
      expect(task.attemptCount).toBe(2);
      expect(countOf(events, "task.attempt.finished")).toBe(2);
      // 「任务完成」只允许由 task.delivered 表达，且只发一次（规格 §14.3 / §18.4）
      expect(countOf(events, "task.delivered")).toBe(1);
      expect(events.filter((event) => event.type === "task.delivered")[0]!.data).toMatchObject({ taskId: task.id });

      // §8.2 / §19：内部续跑不创建用户消息，也不新建 workflow run
      expect(await userMessageCount(h.store, h.session.id)).toBe(1);
      expect(await h.workflow.workflowRuns(h.session.id)).toHaveLength(1);

      // §17.1.4：续跑与原始 task 一致
      expect(task.rootRequestId).toBe("req_continuation");
      expect(receipt.taskId).toBe(task.id);
      expect(receipt.disposition).toBe("task_started");
    } finally {
      await h.cleanup();
    }
  });

  // §8.3 的反向：不能因为「模型停了」就判完成，也不能因为「没拆步骤」就永远
  // 不判完成。一句普通问答应当**一次**交付——否则最简单的问答会变成最贵的任务。
  it("普通问答一次交付，不因为「没有步骤」而空转", async () => {
    const h = await taskHarness([fauxAssistantMessage("42 是生命、宇宙与万物的终极答案。")]);
    try {
      await h.runner.prompt(h.session.id, { requestId: "req_qa", text: "42 是什么" });
      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1);

      const events = await h.events();
      const task = (await h.tasks.listTasks(h.session.id))[0]!;
      expect(task.status).toBe("delivered");
      expect(task.attemptCount).toBe(1);
      expect(countOf(events, "task.attempt.finished")).toBe(1);
      // 交付文本必须来自**这一轮**的回答
      const delivered = events.find((event) => event.type === "task.delivered")!;
      expect((delivered.data as { result: string }).result).toContain("终极答案");
      // 没有工具可跑的答复，其证据就是答复本身（规格 §9 末段）
      expect(task.evidence.some((item) => item.kind === "model_observation")).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});

describe("任务运行时：权限等待", () => {
  // §17.1.5：权限等待后回复，继续同一 task（不创建新用户消息、不新建 run）。
  it("权限等待时任务进入 waiting_permission，回复后继续同一个 task", async () => {
    const h = await taskHarness([
      fauxAssistantMessage([fauxToolCall("bash", { program: "npm", args: ["run", "build"] })]),
      fauxAssistantMessage("构建通过，页面可用。"),
    ]);
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_permission", text: "构建并验证页面" });
      await waitFor(async () => countOf(await h.events(), "permission.asked") === 1);

      // §11.1：等待授权对用户是「在等你」，不是「在跑」
      const waiting = await h.tasks.getTask(receipt.taskId!);
      expect(waiting!.status).toBe("waiting_permission");
      expect(waiting!.blocker).toMatchObject({ kind: "permission", resumable: true });
      const blockedEvent = (await h.events()).find((event) => event.type === "task.blocked")!;
      expect((blockedEvent.data as { blocker: { kind: string } }).blocker.kind).toBe("permission");

      const asked = (await h.events()).find((event) => event.type === "permission.asked")!;
      const request = (asked.data as { request: { id: string } }).request;
      expect(await h.runner.replyPermission(h.session.id, request.id, "once")).toBe(true);

      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1);
      const events = await h.events();
      const delivered = await h.tasks.getTask(receipt.taskId!);
      // §11.2：同一个 task 继续，不是新任务
      expect(delivered!.status).toBe("delivered");
      expect(await h.tasks.listTasks(h.session.id)).toHaveLength(1);
      // 授权是通过引擎回复的，全程没有新用户消息，也没有新 workflow run
      expect(await userMessageCount(h.store, h.session.id)).toBe(1);
      expect(await h.workflow.workflowRuns(h.session.id)).toHaveLength(1);
      expect(countOf(events, "task.delivered")).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  // §17.1.6：reject 之后模型可以走替代方案，任务不该停在 blocked。
  it("权限被拒后模型改走替代方案，任务仍然交付", async () => {
    const h = await taskHarness([
      fauxAssistantMessage([fauxToolCall("bash", { program: "rm", args: ["-rf", "dist"] })]),
      fauxAssistantMessage("收到，我不删除目录，改为只清理构建缓存并重新构建。"),
    ]);
    try {
      await h.runner.prompt(h.session.id, { requestId: "req_reject", text: "清理 dist 后重新构建" });
      await waitFor(async () => countOf(await h.events(), "permission.asked") === 1);
      const asked = (await h.events()).find((event) => event.type === "permission.asked")!;
      await h.runner.replyPermission(h.session.id, (asked.data as { request: { id: string } }).request.id, "reject");

      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1);
      const task = (await h.tasks.listTasks(h.session.id))[0]!;
      // 拒绝不等于任务失败：拒绝结果交回模型，它给出了替代方案（§11.3）
      expect(task.status).toBe("delivered");
      expect(task.status).not.toBe("waiting_permission");
      expect(countOf(await h.events(), "task.failed")).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("任务运行时：停止与幂等", () => {
  // §11「用户主动停止」：任务必须落 cancelled，而不是停在等待里。
  it("用户停止时任务落 cancelled 并解除等待", async () => {
    const h = await taskHarness([
      fauxAssistantMessage([fauxToolCall("bash", { program: "npm", args: ["run", "build"] })]),
      fauxAssistantMessage("不应该跑到这里。"),
    ]);
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_stop", text: "构建项目" });
      await waitFor(async () => countOf(await h.events(), "permission.asked") === 1);
      expect((await h.tasks.getTask(receipt.taskId!))!.status).toBe("waiting_permission");

      await h.runner.abort(h.session.id);

      const task = await h.tasks.getTask(receipt.taskId!);
      expect(task!.status).toBe("cancelled");
      expect(task!.blocker).toBeUndefined();
      const events = await h.events();
      expect(countOf(events, "task.cancelled")).toBe(1);
      expect(countOf(events, "task.delivered")).toBe(0);
      expect(events.find((event) => event.type === "task.cancelled")!.data).toMatchObject({ taskId: receipt.taskId });
    } finally {
      await h.cleanup();
    }
  });

  // §17.1.10 / §17.1.11：并发与重复提交都不会造出第二个任务或第二条用户消息。
  it("补充消息并入当前任务，重复 requestId 不重复建任务", async () => {
    const h = await taskHarness([
      fauxAssistantMessage("先给一版结论。"),
      fauxAssistantMessage("按补充的约束重做了一版。"),
    ]);
    try {
      const first = await h.runner.prompt(h.session.id, { requestId: "req_steer_1", text: "给我一版结论" });
      const second = await h.runner.prompt(h.session.id, { requestId: "req_steer_2", text: "补充：结论要带引用" });
      expect(first.disposition).toBe("task_started");
      // §12：任务进行中的补充消息归为 steering，不能各自启动并发 runner
      expect(second.disposition).toBe("task_steered");
      expect(second.taskId).toBe(first.taskId);
      expect(await h.tasks.listTasks(h.session.id)).toHaveLength(1);

      const replay = await h.runner.prompt(h.session.id, { requestId: "req_steer_1", text: "给我一版结论" });
      expect(replay.taskId).toBe(first.taskId);
      expect(await h.tasks.listTasks(h.session.id)).toHaveLength(1);
      // 重放不产生第二条用户消息（幂等键的意义就在这里）
      expect(await userMessageCount(h.store, h.session.id)).toBe(2);

      await waitFor(async () => countOf(await h.events(), "task.delivered") >= 1);
      expect(await h.tasks.listTasks(h.session.id)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
});

describe("任务运行时：预算与防空转", () => {
  // §17.1.7 的另一半：确定没救的错误（鉴权、额度、参数非法）立刻判失败，
  // 不退避、不续跑——把它当网络抖动重试只会让用户多等半天拿到同一个错误。
  it("确定没救的错误立刻判 failed，不重试也不无限续跑", async () => {
    const faux = createFauxCore({ models: [{ id: "test-model" }] });
    const dataDir = await mkdtemp(path.join(tmpdir(), "task-budget-"));
    const store = createSqliteSessionStore({ dataDir });
    const eventLog = createSqliteEventLog({ dataDir });
    const runner = new SessionRunner({
      store,
      registry: new AgentRegistry(),
      streamFnFor: () => (() => { throw new Error("401 invalid api key"); }) as never,
      modelFor: () => faux.getModel() as never,
      eventLog,
      workspaceFor: () => fakeWorkspace(),
      sandbox: {
        buildSnapshot: vi.fn().mockResolvedValue({ revisionId: null, files: [] }),
        run: vi.fn().mockResolvedValue({ ok: true, exitCode: 0, outputText: "", durationMs: 1, artifacts: [] }),
      },
      subagentDepth: 0,
    });
    const session = await createFrameworkSession({ store, userId: "u", workspaceId: "w", model: { providerId: "faux", modelId: "test-model" } });
    try {
      const receipt = await runner.prompt(session.id, { requestId: "req_fatal", text: "把 PDF 铺到网页" });
      await waitFor(async () => countOf(await eventLog.read(session.id, 0, 10_000), "task.failed") === 1, 15_000);

      const events = await eventLog.read(session.id, 0, 10_000);
      const task = await store.task!.getTask(receipt.taskId!);
      expect(task!.status).toBe("failed");
      // 只跑了一轮：鉴权错误重试没有意义
      expect(task!.attemptCount).toBe(1);
      expect(countOf(events, "task.delivered")).toBe(0);
      // 失败原因要说得出具体是什么
      const failedEvent = events.find((event) => event.type === "task.failed")!;
      expect((failedEvent.data as { reason: string }).reason).toContain("401");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  // §16 阶段 D「最大 Attempt 数配置」：宿主给的预算必须真的生效，且有硬上限。
  it("最大 Attempt 数到顶后停在 blocked(budget)，不继续烧", async () => {
    const h = await taskHarness(
      [
        fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "永远做不完的步骤", status: "in_progress" }] })]),
        fauxAssistantMessage("还没做完，我先停一下。"),
        fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "永远做不完的步骤", status: "in_progress" }] })]),
        fauxAssistantMessage("还是没做完。"),
      ],
      { maxAttempts: 2, noProgress: { blockedAt: 8, switchStrategyAt: 7 } },
    );
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_budget", text: "没有终点的工作" });
      await waitFor(async () => countOf(await h.events(), "task.blocked") === 1);
      const task = await h.tasks.getTask(receipt.taskId!);
      expect(task!.status).toBe("blocked");
      expect(task!.blocker!.kind).toBe("budget");
      // noProgress 阈值被刻意调高，证明停下来的是预算而不是无进展保护
      expect(task!.attemptCount).toBe(2);
    } finally {
      await h.cleanup();
    }
  }, 20_000);
});
