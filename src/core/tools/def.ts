import type { z } from "zod";

import type { ToolContext } from "../tools/context.js";

/** Framework tool definition (spec §7.1). The permission mapping is
 *  declarative: the runner evaluates it in beforeToolCall (the single choke
 *  point, spec §5.4) before execute() ever runs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolDef<TSchema extends z.ZodType = z.ZodType<any>> = {
  id: string;
  label: string;
  description: string;
  parameters: TSchema;
  /** Maps validated args to the permission request. Return null to skip the
   *  permission check entirely (e.g. todo, which is always safe). */
  permission: (args: z.output<TSchema>) => { permission: string; patterns: string[]; always?: string[]; metadata?: unknown } | null;
  execute(args: z.output<TSchema>, ctx: ToolContext): Promise<{ title: string; output: string; metadata?: Record<string, unknown> }>;
  /** Sequential tools never run concurrently with other calls (PI executionMode). */
  executionMode?: "sequential" | "parallel";
};
