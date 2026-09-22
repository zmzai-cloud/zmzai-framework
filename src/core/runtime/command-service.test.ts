import { describe, expect, it } from "vitest";
import { CommandService } from "./command-service.js";
import type { RunScheduler } from "./run-scheduler.js";
import type { SessionStore } from "../session/store.js";
import type { SessionInfo } from "../session/types.js";
import type { TaskPatch, TaskRecord } from "../task/types.js";
import type { FrameworkEvent } from "../events/manifest.js";

/** W6 S4 收尾单测（设计 §6）：提交链的任务归属/回滚/事件语义。 */
const session = { id: "s1", userId: "u", agent: "default", model: { providerId: "faux", modelId: "m" } } as unknown as SessionInfo;

const activeTask: TaskRecord = { id: "t1", sessionId: "s1", rootRequestId: "old-req", rootUserMessageId: "m0", goal: "g", status: "running", revision: 1, constraints: ["old"], noProgressCount: 3, attemptCount: 2, activeMs: 1000 } as unknown as TaskRecord;

function makeService(opts: { acceptError?: Error; hasActiveTask?: boolean }) {
  const casPatches: TaskPatch[] = [];
  const published: string[] = [];
  const store = {
    getSession: async () => session,
    workflow: {
      acceptPrompt: async () => { if (opts.acceptError) throw opts.acceptError; return { receipt: { ok: true, queued: false, requestId: "r1", runId: "run1", userMessageId: "m1", disposition: "task_steered" }, events: [] }; },
    },
    task: {
      findTaskByRequestId: async () => null,
      getActiveTask: async () => (opts.hasActiveTask === false ? null : activeTask),
      createTask: async (input: { sessionId: string; rootRequestId: string; rootUserMessageId: string; goal: string }) => ({ ...activeTask, id: "t-new", rootRequestId: input.rootRequestId, rootUserMessageId: input.rootUserMessageId, status: "queued", revision: 1, constraints: [], acceptanceCriteria: [], evidence: [], steps: [] } as unknown as TaskRecord),
    },
  } as unknown as SessionStore;
  const service = new CommandService({
    store,
    scheduler: { drain: () => {} } as unknown as RunScheduler,
    casTask: async (task, patch) => { casPatches.push(patch); return { ...task, ...patch, revision: task.revision + 1 } as TaskRecord; },
    publish: async (event: FrameworkEvent) => { published.push(event.type); },
    launch: () => {},
  });
  return { service, casPatches, published };
}

describe("CommandService.submit", () => {
  it("acceptPrompt 被拒时把任务回滚到提交前状态并原样抛错", async () => {
    const { service, casPatches } = makeService({ acceptError: new Error("RECOVERY_REQUIRED") });
    await expect(service.submit("s1", { requestId: "r1", text: "补充" })).rejects.toThrow("RECOVERY_REQUIRED");
    // 第一笔是 steering（并入约束），第二笔必须是回滚：状态/约束/三个计数全还原
    expect(casPatches[1]).toMatchObject({ status: "running", constraints: ["old"], noProgressCount: 3, attemptCount: 2, activeMs: 1000 });
  });

  it("steering 不发 task.started；新任务才发", async () => {
    const steer = makeService({});
    const receipt = await steer.service.submit("s1", { requestId: "r1", text: "补充" });
    expect(steer.published).toEqual([]);
    expect(receipt.disposition).toBe("task_steered");

    const start = makeService({ hasActiveTask: false });
    await start.service.submit("s1", { requestId: "r1", text: "新目标" });
    expect(start.published).toEqual(["task.started"]);
  });
});
