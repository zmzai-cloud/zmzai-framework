import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { createSqliteEventLog } from "../events/sqlite-event-log.js";
import { AgentRegistry } from "../agent/registry.js";
import { SessionRunner, createFrameworkSession } from "./runner.js";
import { SubagentCoordinator, type SubagentCoordinatorDeps } from "../subagents/coordinator.js";
import { subagentTools } from "../subagents/tools.js";
import type { TaskRecord } from "../task/types.js";

/** T06（production-chain-closure）：子代理生产链路端到端（PC01–PC09 的
 *  整体链路验收载体）。
 *
 *  真实装配：SessionRunner + 真实 CommandService/RunScheduler/TaskLifecycle/
 *  AttemptExecutor + 真实 subagentTools（模型经 faux 脚本驱动）+ 真实协调器
 *  （runChild 走真实 runAttempt）。模型可脚本（spec §1 执行方式），其余零替身。
 *
 *  链路：prompt → Attempt 1（模型双 agent_spawn → park）→ 两个子 runAttempt
 *  （各自 faux 模型）→ 终态同事务结算 + 结果邮件 → onChildTerminal 唤醒 →
 *  调度器 driveResumed 自动续跑（无用户消息）→ drain 邮箱注入 advisory →
 *  Attempt 2（task_deliver）→ Completion Gate 交付。
 *
 *  父/子模型按会话分流（streamFnFor 按 parentId 分派），消除共享 faux 队列
 *  的父/子交错不确定性。 */

function registryWith(): AgentRegistry {
  return new AgentRegistry().derive([
    { name: "explorer", description: "探索", mode: "subagent", steps: 8, prompt: "你是探索代理。", permission: [], model: { providerId: "faux", modelId: "m" } } as never,
  ]);
}

describe("T06：子代理生产链路端到端（真实 runner + 真实工具 + 脚本模型）", () => {
  it("双 agent_spawn → park → 子终态 → 自动唤醒续跑 → drain 注入 → task_deliver → delivered", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "t06-e2e-"));
    try {
      const store = createSqliteSessionStore({ dataDir });
      const eventLog = createSqliteEventLog({ dataDir });

      const parentFaux = createFauxCore({ models: [{ id: "m" }] });
      const childFaux = createFauxCore({ models: [{ id: "m" }] });
      parentFaux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("agent_spawn", { description: "探索依赖A", prompt: "P-A", agent_type: "explorer", mode: "read_only" }),
          fauxToolCall("agent_spawn", { description: "探索依赖B", prompt: "P-B", agent_type: "explorer", mode: "read_only" }),
        ]),
        fauxAssistantMessage("两个子代理已派出，等待它们的结果。"),
        fauxAssistantMessage([fauxToolCall("task_deliver", { summary: "两个子代理的探索结论已汇总核对", verification: ["子代理结果已逐条核对"] })]),
        fauxAssistantMessage("交付说明：依赖 A、B 的结论一致，已汇总。"),
      ]);
      childFaux.setResponses([
        fauxAssistantMessage("结论A：依赖链为 A→B。"),
        fauxAssistantMessage("结论B：无反向依赖。"),
      ]);

      // late-bind holder：协调器的 runChild/abortChild/唤醒在 runtime 构造后回填
      const holder: { runner?: SessionRunner } = {};
      const deps: SubagentCoordinatorDeps = {
        store,
        registry: registryWith(),
        runChild: async (childId, prompt) => {
          const childSession = await store.getSession(childId);
          if (!childSession) throw new Error(`子会话不存在：${childId}`);
          const outcome = await holder.runner!.runAttempt(childSession, { text: prompt, agent: childSession.agent });
          return {
            state: outcome.state === "completed" ? "completed" : outcome.state === "cancelled" ? "cancelled" : outcome.state === "failed" ? "failed" : "blocked",
            ...(outcome.finalText ? { summary: outcome.finalText } : {}),
            ...(outcome.state === "failed" && outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
          };
        },
        abortChild: async (childId) => { await holder.runner!.abort(childId); },
        onChildTerminal: (_child, parentSessionId) => { holder.runner!.requestInternalResume(parentSessionId); },
      };
      const coordinator = new SubagentCoordinator(deps);

      const runner = new SessionRunner({
        store,
        registry: registryWith(),
        eventLog,
        // 父/子模型分流：子会话（有 parentId）走 childFaux，父会话走 parentFaux
        streamFnFor: (session) => (session.parentId ? childFaux.streamSimple : parentFaux.streamSimple) as never,
        modelFor: () => parentFaux.getModel() as never,
        workspaceFor: () => ({
          list: async () => [],
          read: async () => null,
          write: async () => ({ revisionId: "r", diff: "" }),
          edit: async () => ({ revisionId: "r", diff: "" }),
        }),
        sandbox: { buildSnapshot: async () => ({ revisionId: null, files: [] }), run: async () => ({ ok: true, exitCode: 0, outputText: "", durationMs: 1, artifacts: [] }) },
        localTools: [...subagentTools],
        subagentDepth: 1,
        subagentCoordinator: coordinator,
      });
      holder.runner = runner;

      const session = await createFrameworkSession({
        store,
        userId: "u-t06",
        workspaceId: "ws-t06",
        model: { providerId: "faux", modelId: "m" },
        // 预盖 task 权限：本用例考全链装配，不是权限门
        permission: [{ permission: "task", pattern: "*", action: "allow" }],
      });
      await runner.prompt(session.id, { requestId: "t06-e2e", text: "派两个子代理探索并汇总结论" });

      // 轮询终态：park → 子终态 → 自动唤醒续跑 → 交付（全异步驱动链）
      const deadline = Date.now() + 20_000;
      let task: TaskRecord | null = null;
      while (Date.now() < deadline) {
        task = await store.task!.getLatestTask(session.id);
        if (task?.status === "delivered") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // ---- 终态断言 ----
      expect(task).not.toBeNull();
      expect(task!.status).toBe("delivered");
      // 两轮 Attempt：第 1 轮 park（不烧轮次），第 2 轮唤醒续跑交付
      expect(task!.attemptCount).toBe(2);

      // 两个子代理：终态 + 结果邮件 + 已被父消费（drain 水位推进）
      const children = await coordinator.list(task!.rootRequestId);
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child.status).toBe("completed");
        expect(child.result?.summary ?? "").toMatch(/结论[AB]/);
        const mailbox = await store.subagents!.listMessages(child.childId);
        const result = mailbox.find((m) => m.direction === "to_parent" && m.kind === "result");
        expect(result).toBeDefined();
        expect(result!.consumedByParent).toBe(true);
        const childSession = await store.getSession(child.childSessionId);
        expect(childSession?.parentId).toBe(session.id);
        expect(childSession?.userId).toBe("u-t06");
      }

      // 不创建伪用户消息：续跑走 resume/advisory，只有最初那条用户消息
      const snapshot = await store.getMessageSnapshot!(session.id, { limit: 50 });
      const userMessages = snapshot.messages.filter((m) => m.info.role === "user" && !(m.info as { synthetic?: boolean }).synthetic);
      expect(userMessages).toHaveLength(1);
      // 交付声明在案（task_deliver 投影）
      expect(task!.result).toBeDefined();
      expect(task!.result!.outcome).toContain("汇总");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
