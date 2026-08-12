import type { AgentInfo } from "./registry.js";
import type { SessionInfo } from "../session/types.js";
import type { ToolDef } from "../tools/def.js";

/** A product resolves an immutable Agent Version into this runtime-safe shape.
 *  The framework deliberately does not know how versions, plugins, secrets,
 *  or connectors are stored. */
export type ResolvedAgent = {
  agent: AgentInfo;
  /** Extra tool definitions contributed by trusted, resolved capabilities.
   *  Base tools remain owned by the framework. */
  tools?: ToolDef[];
};

export type AgentResolver = {
  resolve(session: SessionInfo): Promise<ResolvedAgent | null>;
};
