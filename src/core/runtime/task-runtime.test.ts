import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";

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

async function taskHarness(script: FauxResponseStep[], policy?: RunnerDeps["taskPolicy"]) {
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
    // 这套 harness 就是为了任务层而存在的：把它需要的能力显式暴露出来，
    // 测试里不必到处写 `!` 断言「我知道它一定在」。
    tasks: store.task!,
    workflow: store.workflow!,
    // 场景 C 要把沙箱换成「结果不确定」的替身。`SessionRunnerDeps.sandbox` 是
    // 可选字段，直接从 `deps` 上取会带出 undefined 分支，于是断言行也得跟着写
    // `!`——那正好把「这个 harness 一定装了沙箱」这件事从类型里抹掉了。
    sandbox: deps.sandbox!,
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

describe("任务运行时：模型声明需要用户介入（§11 / §17.3 场景 B）", () => {
  /** 这三条是 `task_block` 存在的理由：把「模型说它卡住了」变成**可执行的运行时
   *  状态**。在此之前，模型停下来说「我需要仓库地址」会被当成一次正常收尾 →
   *  自动续跑 → 同样的理由再停一次 → 连续三轮后落进 blocked(no_progress)，
   *  用户看到的是「连续 3 轮没有实质进展」。原因被换成了一个性能问题。 */

  it("缺信息：落 waiting_input，且阻塞文案用的是模型的原话", async () => {
    const h = await taskHarness([
      fauxAssistantMessage([
        fauxToolCall("task_block", {
          kind: "input",
          message: "缺少目标仓库地址，无法确定推送到哪里。",
          requiredAction: "把仓库地址（owner/repo）发过来。",
        }),
      ]),
      fauxAssistantMessage("我需要仓库地址才能继续推送。"),
    ]);
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_block_input", text: "把本地改动推到远端" });
      await waitFor(async () => countOf(await h.events(), "task.blocked") === 1);

      const task = await h.tasks.getTask(receipt.taskId!);
      expect(task!.status).toBe("waiting_input");
      expect(task!.blocker).toMatchObject({ kind: "input", resumable: true });
      // §14.4：必须说清「缺什么」，而不是「补充必要信息后任务会自动继续」
      expect(task!.blocker!.message).toContain("缺少目标仓库地址");
      expect(task!.blocker!.requiredAction).toContain("owner/repo");
      expect(task!.blocker!.requiredAction).not.toContain("补充必要信息后任务会自动继续");
      // 声明阻塞不是交付
      expect(countOf(await h.events(), "task.delivered")).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it("外部登录：落 waiting_external；用户补齐后继续同一个 task 并交付", async () => {
    const h = await taskHarness([
      fauxAssistantMessage([
        fauxToolCall("task_block", {
          kind: "external_auth",
          message: "推送时 GitHub 凭据已失效（401）。",
          requiredAction: "在终端里完成 gh auth login，然后回来说一声。",
        }),
      ]),
      fauxAssistantMessage("本地改动和构建都通过了，只差推送这一步。"),
      // 用户回复之后这一轮跑的东西
      fauxAssistantMessage("登录已生效，推送完成，远端页面检查通过。"),
    ]);
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_block_ext", text: "推送并验证线上页面" });
      await waitFor(async () => countOf(await h.events(), "task.blocked") === 1);

      const waiting = await h.tasks.getTask(receipt.taskId!);
      expect(waiting!.status).toBe("waiting_external");
      expect(waiting!.blocker!.kind).toBe("external_auth");
      // §17.3-B 的关键：登录之前不许出现任何「任务完成」
      expect(countOf(await h.events(), "task.delivered")).toBe(0);

      // 用户把外部状态处理完，回来说一句 → 同一 task 从等待处恢复。
      // disposition 是 task_resumed 而不是 task_steered：区别在于任务当时**停在
      // 等待上**，这条消息是把它解锁，而不是对一条正在跑的任务追加约束。
      // 界面靠这个区分「你在回答我」与「你在改需求」（§12）。
      const second = await h.runner.prompt(h.session.id, { requestId: "req_block_ext_reply", text: "已经登录好了，继续" });
      expect(second.disposition).toBe("task_resumed");
      expect(second.taskId).toBe(receipt.taskId);

      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1);
      const delivered = await h.tasks.getTask(receipt.taskId!);
      expect(delivered!.status).toBe("delivered");
      // §18.5：恢复原 task，不创建新 root task
      expect(await h.tasks.listTasks(h.session.id)).toHaveLength(1);
      expect(countOf(await h.events(), "task.blocked")).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("声明阻塞换不来交付：步骤全做完但用户在等，仍然不是 delivered", async () => {
    // §19 的反向保护——如果 task_block 能换来一个 delivered，它就成了逃生舱。
    const h = await taskHarness([
      fauxAssistantMessage([
        fauxToolCall("todo", { todos: [{ content: "唯一的一步", status: "completed" }] }),
        fauxToolCall("task_block", { kind: "choice", message: "两种发布方式结果不可逆。", requiredAction: "选直接覆盖还是保留旧版本。", options: ["直接覆盖", "保留旧版本"] }),
      ]),
      fauxAssistantMessage("这一步做完了，但发布方式需要你定。"),
    ]);
    try {
      await h.runner.prompt(h.session.id, { requestId: "req_block_choice", text: "发布这个页面" });
      await waitFor(async () => countOf(await h.events(), "task.blocked") === 1);

      const task = (await h.tasks.listTasks(h.session.id))[0]!;
      expect(task.status).toBe("waiting_input");
      expect(task.blocker!.kind).toBe("choice");
      expect(countOf(await h.events(), "task.delivered")).toBe(0);
      expect(countOf(await h.events(), "task.failed")).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it("参数不合法的声明不会把任务冻住", async () => {
    // 一个格式不对的工具调用（模型常见的失误）不该让任务停下来等一个根本不存在的
    // 需求。`readTaskBlock` 校验失败即视为没声明，任务照常往下跑。
    const h = await taskHarness([
      fauxAssistantMessage([fauxToolCall("task_block", { kind: "出去吃个饭" })]),
      fauxAssistantMessage("这个工具我调错了，直接回答：页面已经铺好了。"),
    ]);
    try {
      await h.runner.prompt(h.session.id, { requestId: "req_block_bad", text: "把页面铺好" });
      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1);
      const task = (await h.tasks.listTasks(h.session.id))[0]!;
      expect(task.status).toBe("delivered");
      expect(countOf(await h.events(), "task.blocked")).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("§17.3 端到端场景", () => {
  // 场景 A：单条用户消息启动一个六步任务，模型中途正常停三次，全程用户不点任何东西。
  //
  // 这是整份规格的主命题，所以断言刻意压在「**中途没有一次交付**」上：如果系统
  // 还是把「模型停了」当成「做完了」，这里会在第一次 attempt.finished 之后就出现
  // task.delivered——而那正是用户投诉的那个现象。
  it("场景 A：六步任务由一条消息跑完全程，中途停三次不算完成", async () => {
    const script: FauxResponseStep[] = [];
    const titles = ["读取 PDF 并拆页", "提取正文与图片", "把内容写进页面", "本地构建并启动", "浏览器检查关键内容与资源", "修复发现的问题并交付"];
    // 三次「停下来」：每轮末尾都是一段纯文本，步骤却还没做完。
    titles.forEach((title, index) => {
      const done = titles.slice(0, index).map((content) => ({ content, status: "completed" as const }));
      const current = { content: title, status: "in_progress" as const };
      script.push(fauxAssistantMessage([fauxToolCall("todo", { todos: [...done, current, ...titles.slice(index + 1).map((content) => ({ content, status: "pending" as const }))] })]));
      script.push(fauxAssistantMessage(`${title}这一步先到这里，接着往下做。`));
    });
    // 最后一次收尾才把六步全部标成完成——交付发生在这里，而不是前面任何一次停下。
    script.push(fauxAssistantMessage([fauxToolCall("todo", { todos: titles.map((content) => ({ content, status: "completed" as const })) })]));
    script.push(fauxAssistantMessage("六步都做完了：页面已铺好，构建通过，浏览器检查关键内容和资源都正常。"));

    const h = await taskHarness(script);
    try {
      await h.runner.prompt(h.session.id, { requestId: "req_scenario_a", text: "把这个 PDF 的内容完整铺到网页上，并验证页面可用" });
      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1, 15_000);

      const events = await h.events();
      const task = (await h.tasks.listTasks(h.session.id))[0]!;

      // 1) 用户只说了一句话，也没有第二次 run
      expect(await userMessageCount(h.store, h.session.id)).toBe(1);
      expect(await h.workflow.workflowRuns(h.session.id)).toHaveLength(1);
      // 2) 六步全部完成，且从头到尾只有一个 task.delivered
      expect(task.steps.map((step) => step.status)).toEqual(Array(6).fill("completed"));
      expect(countOf(events, "task.delivered")).toBe(1);
      // 3) 中途的每一次收尾都没有交付——这是「模型停止 ≠ 任务完成」的直接证据
      const firstDeliveredAt = events.findIndex((event) => event.type === "task.delivered");
      const settledBefore = events.slice(0, firstDeliveredAt).filter((event) => event.type === "task.attempt.finished");
      expect(settledBefore.length).toBeGreaterThanOrEqual(3);
      // 4) 交付文本来自最后一次尝试，而不是中途那句「先到这里」
      const delivered = events[firstDeliveredAt]!;
      expect((delivered.data as { result: string }).result).toContain("浏览器检查");
      expect(task.result?.outcome).toBeTruthy();
    } finally {
      await h.cleanup();
    }
  }, 25_000);

  // 场景 C：命令长时间无输出且副作用不明 → 先核对，不把「没输出」当成功，也不重复提交。
  it("场景 C：写操作结果未知时落 blocked(unsafe_replay)，且不自动重放", async () => {
    const h = await taskHarness([
      fauxAssistantMessage([fauxToolCall("bash", { program: "git", args: ["push", "origin", "main"] })]),
      fauxAssistantMessage("推送命令没有任何输出，无法确认是否已经提交到远端。"),
    ]);
    // 沙箱报告「结果不确定」：命令跑完了，但拿不到明确的成败结论。
    h.sandbox.run = vi.fn().mockResolvedValue({ ok: false, outcome: "unknown", durationMs: 30_000, outputText: "", artifacts: [] }) as never;
    try {
      await h.runner.prompt(h.session.id, { requestId: "req_scenario_c", text: "把改动推到远端" });
      await waitFor(async () => countOf(await h.events(), "permission.asked") === 1);
      const asked = (await h.events()).find((event) => event.type === "permission.asked")!;
      await h.runner.replyPermission(h.session.id, (asked.data as { request: { id: string } }).request.id, "once");

      // 等待的过程中会先出现一条 blocked(permission)（§11.1：对用户是「在等你」），
      // 所以这里要等的是**授权之后**那条，别把前者当成终局。
      await waitFor(async () => (await h.events()).some((event) => event.type === "task.blocked" && (event.data as { blocker: { kind: string } }).blocker.kind === "unsafe_replay"));
      const task = (await h.tasks.listTasks(h.session.id))[0]!;

      // §10.2：写操作结果未知 → 不自动重放，先核验外部状态
      expect(task.status).toBe("blocked");
      expect(task.blocker!.kind).toBe("unsafe_replay");
      expect(task.blocker!.resumable).toBe(true);
      expect(task.blocker!.requiredAction).toContain("确认外部系统");
      // 命令只跑了一次：没有把「无输出」当成失败去重试
      expect(h.sandbox.run).toHaveBeenCalledTimes(1);
      expect(countOf(await h.events(), "task.delivered")).toBe(0);
      // 也不该落成 failed——它没坏，只是不知道
      expect(task.status).not.toBe("failed");
    } finally {
      await h.cleanup();
    }
  }, 25_000);
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

describe("任务运行时：重启恢复与人工放行", () => {
  // §16 阶段 D：恢复扫描给任务落了 blocked，用户核对完之后要能继续。
  // 每个 blocker 都写着一句「先核对…再决定继续」，产品必须接得住这句话。
  it("resumeTask 让 blocked 的任务继续，且不创建新用户消息", async () => {
    const h = await taskHarness(
      [
        fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "把 PDF 铺到网页", status: "in_progress" }] })]),
        fauxAssistantMessage("先解析了 PDF，下一页再落网页。"),
        fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "把 PDF 铺到网页", status: "completed" }] })]),
        fauxAssistantMessage("PDF 内容已铺到网页并通过构建。"),
      ],
      // 预算刻意只给 1 轮：第一轮做完就该停，等用户放行
      { maxAttempts: 1 },
    );
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_resume", text: "把 PDF 铺到网页" });
      await waitFor(async () => countOf(await h.events(), "task.blocked") === 1);
      const stopped = (await h.tasks.getTask(receipt.taskId!))!;
      expect(stopped.status).toBe("blocked");
      expect(stopped.blocker!.kind).toBe("budget");
      expect(stopped.attemptCount).toBe(1);

      // 「继续」不是一条新消息：用户核对完点一下按钮而已
      expect(await h.runner.resumeTask(h.session.id)).toBe(true);
      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1);

      const resumed = (await h.tasks.getTask(receipt.taskId!))!;
      expect(resumed.status).toBe("delivered");
      expect(resumed.blocker).toBeUndefined();
      expect(resumed.id).toBe(receipt.taskId);
      // 放行会重置预算与无进展计数：否则「继续」会立刻被同一个上限再挡一次，
      // 成了一个按不出反应的死按钮。
      expect(resumed.attemptCount).toBe(1);
      // 用户消息仍然只有最初那一条
      expect(await userMessageCount(h.store, h.session.id)).toBe(1);
      // 也没有为「继续」新建 workflow run
      expect(await h.workflow.workflowRuns(h.session.id)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  it("任务在正常跑时 resumeTask 返回 false（正常运行不需要「继续」）", async () => {
    const h = await taskHarness([fauxAssistantMessage("好了。")]);
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_noop", text: "随便做点什么" });
      await waitFor(async () => (await h.tasks.getTask(receipt.taskId!))!.status === "delivered");
      // 已交付的终态任务没什么可继续的
      expect(await h.runner.resumeTask(h.session.id)).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  // 提交被 workflow 层的恢复闸拒掉时，任务必须回到原样。
  // resolveTaskForPrompt 已经清掉 blocker、把状态放回 queued 了，而这次 prompt
  // 根本没被接受——没有 run 会去推进它，任务会停在 queued 上永远等不到。
  it("提交被 recovery 闸拒绝时，任务回到提交前的样子", async () => {
    // 让运行卡在等待授权上：workflow run 会一直保持 running，正好可以模拟
    // 「进程在跑的时候挂掉，恢复扫描接手」。
    const h = await taskHarness([
      fauxAssistantMessage([fauxToolCall("bash", { program: "npm", args: ["run", "build"] })]),
      fauxAssistantMessage("不该跑到这里。"),
    ]);
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_gate", text: "构建并验证" });
      await waitFor(async () => countOf(await h.events(), "permission.asked") === 1);
      const before = (await h.tasks.getTask(receipt.taskId!))!;
      expect(before.status).toBe("waiting_permission");
      expect(before.constraints).toEqual([]);

      await h.workflow.recoverInterrupted(h.session.id);

      await expect(h.runner.prompt(h.session.id, { requestId: "req_gate_2", text: "补充一句不该被记下的话" }))
        .rejects.toThrow("RECOVERY_REQUIRED");

      // 被拒的提交不留痕迹：状态、blocker、约束、计数都回到提交前
      const after = (await h.tasks.getTask(receipt.taskId!))!;
      expect(after.status).toBe("waiting_permission");
      expect(after.blocker).toMatchObject({ kind: "permission" });
      expect(after.constraints).toEqual([]);
      expect(after.attemptCount).toBe(before.attemptCount);
      expect(after.noProgressCount).toBe(before.noProgressCount);
    } finally {
      await h.runner.abort(h.session.id);
      await h.cleanup();
    }
  }, 20_000);
});

describe("任务运行时：预算与上下文存续（§10.2 / §16 阶段 D / §17.1.12）", () => {
  it("时间预算耗尽时停在 blocked(budget)，放行后重新计时", async () => {
    const h = await taskHarness(
      [
        fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "把 PDF 铺到网页", status: "in_progress" }] })]),
        fauxAssistantMessage("先解析了 PDF，下一页再落网页。"),
        fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "把 PDF 铺到网页", status: "completed" }] })]),
        fauxAssistantMessage("PDF 内容已铺到网页并通过构建。"),
      ],
      // 预算压到 1 毫秒：第一轮刚跑完就超。轮数给足，证明停下来的是时间而不是轮数。
      { maxDurationMs: 1, maxAttempts: 8 },
    );
    try {
      const receipt = await h.runner.prompt(h.session.id, { requestId: "req_time", text: "把 PDF 铺到网页" });
      await waitFor(async () => countOf(await h.events(), "task.blocked") === 1);
      const stopped = (await h.tasks.getTask(receipt.taskId!))!;
      expect(stopped.status).toBe("blocked");
      expect(stopped.blocker!.kind).toBe("budget");
      // 说清楚是**时间**预算，而不是笼统的「预算」：用户要知道自己撞上的是哪一堵墙
      expect(stopped.blocker!.message).toContain("时间预算");
      expect(stopped.attemptCount).toBe(1);
      expect(stopped.activeMs).toBeGreaterThan(1);

      // 放行 = 预算重新计时。不重置 activeMs 的话，放行后的第一轮连起点都过不去，
      // 「继续」就又成了一个按不出反应的死按钮。
      expect(await h.runner.resumeTask(h.session.id)).toBe(true);
      await waitFor(async () => countOf(await h.events(), "task.delivered") === 1);
      const done = (await h.tasks.getTask(receipt.taskId!))!;
      expect(done.status).toBe("delivered");
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  // §17.1.12：上下文压缩不得带走任务契约。机制上契约进的是 systemPrompt（每个
  // Attempt 从**持久化的 TaskRecord** 重新渲染一次），而 compaction 的
  // transformContext 只折叠 messages——两者根本不在同一个容器里。这条测试钉住
  // 的正是这个性质：续跑那一轮拿到的指令里，目标、验收条件、剩余步骤一个不少。
  it("续跑时任务契约仍在 systemPrompt 里（历史怎么折叠都带不走）", async () => {
    const prompts: string[] = [];
    const h = await taskHarness([
      fauxAssistantMessage([fauxToolCall("todo", { todos: [{ content: "迁移 6 张图片", status: "in_progress" }] })]),
      fauxAssistantMessage("图片还没迁完。"),
      // 第三条起（也就是续跑那一轮）换成工厂，好把这一次真正发给模型的
      // systemPrompt 抓下来——它不落库、不进事件流，只能在这里观测。
      (context) => {
        prompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("还在迁移。");
      },
    ]);
    try {
      await h.runner.prompt(h.session.id, { requestId: "req_contract", text: "把站点里的图片迁到新图床" });
      await waitFor(() => prompts.length > 0);
      const contract = prompts[0]!;
      expect(contract).toContain("<task-contract>");
      expect(contract).toContain("目标：把站点里的图片迁到新图床");
      expect(contract).toContain("验收条件");
      expect(contract).toContain("剩余步骤：迁移 6 张图片");
    } finally {
      await h.runner.abort(h.session.id);
      await h.cleanup();
    }
  }, 20_000);
});
