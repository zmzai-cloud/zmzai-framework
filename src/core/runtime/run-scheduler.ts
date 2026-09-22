import { leaseDurationMs } from "../../adapters/index.js";
import type { SessionStore } from "../session/store.js";
import type { PromptInput, WorkflowState } from "../session/workflow.js";
import type { SessionInfo } from "../session/types.js";
import { defaultActiveRunRegistry } from "./active-run-registry.js";

/** RunScheduler 的执行回调（W6 §3.2）：怎么跑一条被认领的 job、怎么推进被
 *  放行的任务、停止时怎么收残余任务。W6 由 SessionRunner 实现；W7 换
 *  AttemptExecutor 时这里就是插槽。 */
export type SchedulerExecutor = {
  runJob(session: SessionInfo, input: PromptInput, acceptedUserId?: string): Promise<WorkflowState>;
  driveResumed(session: SessionInfo): Promise<void>;
  cancelResidual(sessionId: string): Promise<void>;
};

export type SchedulerDeps = {
  store: SessionStore;
  executor: SchedulerExecutor;
  /** 租约 owner。默认 `node:${pid}`（搬移前现行为）；§6.2 的
   *  hostInstanceId+executionEpoch 落地时由宿主注入更强的身份。 */
  leaseOwner?: string;
  leaseStore?: { stamp(sessionId: string, owner: string, expiresAt: Date): Promise<void>; clear(sessionId: string): Promise<void> };
};

/** 会话级 FIFO 调度（W6 S3 自 SessionRunner 原样搬移）：drain 驱动链、放行
 *  通路登记、停止协调与租约打点。语义零变化；竞争窗口注释一并搬走。 */
export class RunScheduler {
  private readonly draining = new Map<string, Promise<void>>();
  private readonly stopRequested = new Set<string>();
  /** 已被用户放行、等待驱动链接手推进的会话（见 `drain` 的第三条分支）。 */
  private readonly resumeRequests = new Set<string>();
  private readonly leaseOwner: string;

  constructor(private readonly deps: SchedulerDeps) {
    this.leaseOwner = deps.leaseOwner ?? `node:${process.pid}`;
  }

  isStopRequested(sessionId: string): boolean {
    return this.stopRequested.has(sessionId);
  }

  async stampLease(sessionId: string): Promise<void> {
    if (!this.deps.leaseStore) return; // demo/JSONL mode: no lease
    await this.deps.leaseStore.stamp(sessionId, this.leaseOwner, new Date(Date.now() + leaseDurationMs)).catch(() => undefined);
  }

  async clearLease(sessionId: string): Promise<void> {
    if (!this.deps.leaseStore) return;
    await this.deps.leaseStore.clear(sessionId).catch(() => undefined);
  }

  drain(sessionId: string): void {
    if (this.draining.has(sessionId)) return;
    const work = (async () => {
      while (true) {
        const job = await this.deps.store.workflow!.claimPrompt(sessionId, `node:${process.pid}`);
        if (job) {
          let outcome: WorkflowState = "recovery_required";
          try {
            if (this.stopRequested.has(sessionId)) {
              outcome = "cancelled";
            } else {
            const session = await this.deps.store.getSession(sessionId);
            if (!session) {
              outcome = "failed";
            } else {
              // 走任务层：一次 claim 之后可能跑多轮 Attempt（规格 §8.2）
              outcome = await this.deps.executor.runJob(session, job.input, job.receipt.userMessageId);
            }
            }
          } catch {
            // Setup or settlement may have failed after a tool ran. Do not replay.
          }
          try {
            await this.deps.store.workflow!.finishPrompt(sessionId,job.receipt.runId,job.revision,outcome);
          } catch (error) {
            // revision 是这次 run 的所有权凭据。冲突说明这次 run 的归属已经在
            // 别处被改写过——最典型的就是进程崩溃后恢复扫描把它标成
            // `recovery_required`，而这一轮结算才姗姗来迟。那时这条结论不该由
            // 我们写（恢复扫描已经给出了它的判断），静默退出即可。把冲突往上抛
            // 只会炸掉 `abort()`——它正 await 着这条驱动链。
            if (!/RUN_REVISION_CONFLICT/.test(String((error as Error)?.message ?? ""))) throw error;
            return;
          }
          if (outcome !== "completed") return;
          continue;
        }
        // 队列里没有 run 了。还有第三种可能要推进：**用户刚按了「继续」**。
        // 这类任务停下的原因是预算/无进展/等待，而不是「排队等认领」——它那次
        // 的 workflow run 早已 `completed`，`claimPrompt` 永远取不到它。没有这条
        // 分支，`resumeTask` 把任务放回 queued 之后就再没有东西会碰它，
        // 每个 blocker 里写的那句「确认后可以继续」就是一句系统接不住的承诺。
        if (!this.resumeRequests.delete(sessionId)) return;
        if (this.stopRequested.has(sessionId)) return;
        const resumed = await this.deps.store.getSession(sessionId);
        if (!resumed) return;
        await this.deps.executor.driveResumed(resumed);
      }
    })();
    this.draining.set(sessionId, work);
    void work.catch(() => undefined).finally(async () => {
      this.draining.delete(sessionId);
      if (this.stopRequested.has(sessionId)) return;
      // 有放行请求就在原地接着驱动。必须在这里再查一次：`resumeTask` 是在
      // `draining.delete` 之前判断「有没有人在跑」的，上面那个 while 也可能
      // 刚刚判定退出——两件事都发生在微任务队列里，中间只差一次 await。
      // 少了这一查，一次恰好落在收尾窗口里的「继续」会被静默丢掉。
      if (this.resumeRequests.has(sessionId)) {
        this.drain(sessionId);
        return;
      }
      const queued = await this.deps.store.workflow!.workflowRuns(sessionId).catch(() => []);
      if (queued.some(run => run.status === "queued") && !queued.some(run => run.status === "running" || run.status === "recovery_required")) this.drain(sessionId);
    });
  }

  /** 用户放行通路的调度侧登记（任务层的 CAS 与恢复闸放行留在
   *  SessionRunner.resumeTask——那是任务语义，不是调度语义）。 */
  requestResume(sessionId: string): void {
    this.resumeRequests.add(sessionId);
    this.drain(sessionId);
  }

  async abort(sessionId: string): Promise<void> {
    this.stopRequested.add(sessionId);
    await this.deps.store.clearQueuedPrompts(sessionId);
    const active = defaultActiveRunRegistry.get(sessionId);
    // PI's abort signal does not cancel a PermissionEngine.ask() promise.
    // Rejecting pending approvals first releases beforeToolCall so the run can
    // publish its terminal state and a continuation cannot overlap it.
    if (active) {
      active.engine.dispose("任务已停止，未处理的授权请求已取消");
      active.abort();
      await active.done;
    }
    await this.draining.get(sessionId);
    await this.deps.executor.cancelResidual(sessionId);
    // 停止会作废还没被认领的放行请求：留着它，驱动链下一次启动就会去推进一个
    // 用户已经改主意（点了停止）的任务。
    this.resumeRequests.delete(sessionId);
    this.stopRequested.delete(sessionId);
  }

  /** 测试辅助：等待全部驱动链收尾（含收尾窗口内可能的重启）。 */
  async idle(): Promise<void> {
    while (this.draining.size > 0) await Promise.allSettled([...this.draining.values()]);
  }
}
