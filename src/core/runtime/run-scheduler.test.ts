import { describe, expect, it } from "vitest";
import { RunScheduler, type SchedulerExecutor } from "./run-scheduler.js";
import type { SessionStore } from "../session/store.js";
import type { SessionInfo } from "../session/types.js";
import type { WorkflowRun } from "../session/workflow.js";

/** W6 S3 收尾单测（设计 §6）：调度语义不借模型/存储实现，全用可注入 mock。 */
function job(id: string): WorkflowRun {
  return { receipt: { ok: true, queued: false, requestId: id, runId: id, userMessageId: "m-" + id, disposition: "started" }, input: { text: "t" }, status: "running", revision: 1 };
}

function makeStore(runs: WorkflowRun[]) {
  const finished: Array<[string, string]> = [];
  const store = {
    workflow: {
      claimPrompt: async () => runs.shift() ?? null,
      finishPrompt: async (_s: string, runId: string, _r: number, state: string) => { finished.push([runId, state]); },
      workflowRuns: async () => runs,
    },
    getSession: async (id: string) => ({ id }) as SessionInfo,
    clearQueuedPrompts: async () => {},
    enqueuePrompt: async () => {},
  };
  return { store: store as unknown as SessionStore, finished };
}

const noopExecutor = (events: string[] = []): SchedulerExecutor => ({
  runJob: async () => { events.push("run"); return "completed"; },
  driveResumed: async () => { events.push("drive"); },
  cancelResidual: async () => { events.push("residual"); },
});

describe("RunScheduler", () => {
  it("stopRequested 期间认领的 job 直接判 cancelled，不执行 runJob", async () => {
    const events: string[] = [];
    const { store, finished } = makeStore([job("r1")]);
    const s = new RunScheduler({ store, executor: noopExecutor(events) });
    const aborting = s.abort("s1"); // 同步置 stopRequested 后才让 drain 启动
    s.drain("s1");
    await aborting;
    expect(events).toEqual(["residual"]); // 只收残余，没跑过 runJob
    expect(finished).toEqual([["r1", "cancelled"]]);
  });

  it("abort 等驱动链收尾之后才调 cancelResidual", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const executor: SchedulerExecutor = {
      runJob: async () => { events.push("run"); await gate; return "completed"; },
      driveResumed: async () => {},
      cancelResidual: async () => { events.push("residual"); },
    };
    const { store } = makeStore([job("r1")]);
    const s = new RunScheduler({ store, executor });
    s.drain("s1");
    await new Promise((r) => setTimeout(r, 0)); // 让链先认领并进入 runJob
    const aborting = s.abort("s1");
    release();
    await aborting;
    expect(events).toEqual(["run", "residual"]);
  });

  it("空队列上的 requestResume 驱动 driveResumed（放行不丢）", async () => {
    const events: string[] = [];
    const { store } = makeStore([]);
    const s = new RunScheduler({ store, executor: noopExecutor(events) });
    s.drain("s1");
    s.requestResume("s1");
    await s.idle();
    expect(events).toContain("drive");
  });
});
