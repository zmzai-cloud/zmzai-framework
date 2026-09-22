import type { Agent } from "@earendil-works/pi-agent-core";
import type { PermissionEngine } from "../permission/engine.js";

/** 一个会话的当前活跃 run（W6 §3.1，自 runner.ts 原样搬移）。
 *
 *  registry 拥有进程级活跃 run 表，让调度/命令层共享它而不必 import runner。 */
export type ActiveRun = {
  agent: Agent;
  engine: PermissionEngine;
  settled: () => Promise<void>;
  abort: () => void;
  /** Resolves only after the run has emitted its terminal state and released
   *  its lease. Control-plane code uses this before starting a continuation. */
  done: Promise<void>;
};

/** activeRuns 表仍是挂 globalThis 的 Map 单例（跨副本共享语义保持不变）；
 *  registry 只是它的具名门面。 */
const globalRunners = globalThis as typeof globalThis & { __zmzaiFrameworkRuns?: Map<string, ActiveRun> };
const activeRuns = globalRunners.__zmzaiFrameworkRuns ?? new Map<string, ActiveRun>();
globalRunners.__zmzaiFrameworkRuns = activeRuns;

export class ActiveRunRegistry {
  constructor(private readonly runs: Map<string, ActiveRun>) {}

  register(sessionId: string, run: ActiveRun): void {
    this.runs.set(sessionId, run);
  }
  get(sessionId: string): ActiveRun | undefined {
    return this.runs.get(sessionId);
  }
  has(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }
  delete(sessionId: string): void {
    this.runs.delete(sessionId);
  }
  sessionIds(): string[] {
    return [...this.runs.keys()];
  }
}

/** 进程级默认实例（包住上面那张 globalThis Map）。 */
export const defaultActiveRunRegistry = new ActiveRunRegistry(activeRuns);
