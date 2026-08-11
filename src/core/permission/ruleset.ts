/** Permission ruleset DSL (spec §5.1).
 *
 *  A ruleset is an ordered list of rules; the LAST matching rule wins and the
 *  default action when nothing matches is "ask". Config syntax mirrors
 *  opencode.json: a bare action string, or a map of permission -> action or
 *  pattern->action map. */

export type Action = "allow" | "deny" | "ask";

export type Rule = { permission: string; pattern: string; action: Action };
export type Ruleset = Rule[];

export type PermissionConfig = Action | Record<string, Action | Record<string, Action>>;

/** Well-known permission keys (spec §5.1). Tools may introduce additional keys
 *  (e.g. future MCP `server_*`); the engine treats keys as opaque strings and
 *  matches them with wildcards. */
export const PERMISSIONS = [
  "read",
  "edit", // covers write/edit/apply_patch
  "bash",
  "glob",
  "grep",
  "list",
  "webfetch",
  "task",
  "todo",
  "external_directory",
] as const;

/** Converts config syntax into a flat ruleset. Key order in the config object
 *  is preserved, so later keys override earlier ones for overlapping matches. */
export function rulesetFromConfig(config: PermissionConfig): Ruleset {
  if (typeof config === "string") return [{ permission: "*", pattern: "*", action: config }];
  const rules: Ruleset = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value });
    } else {
      for (const [pattern, action] of Object.entries(value)) {
        rules.push({ permission, pattern, action });
      }
    }
  }
  return rules;
}

/** Glob-style wildcard match: `*` matches any run of characters (including
 *  path separators), `?` matches one character. Same spirit as OpenCode's
 *  Wildcard.match — patterns are not filesystem paths, just strings. */
export function wildcardMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let starValue = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p++;
      v++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      starValue = v;
    } else if (star !== -1) {
      p = star + 1;
      v = ++starValue;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Core evaluation: last matching rule across all rulesets (in order) wins.
 *  Later rulesets in the array have higher precedence. Default: "ask". */
export function evaluateRules(rulesets: Ruleset[], permission: string, pattern: string): Action {
  let result: Action = "ask";
  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (wildcardMatch(rule.permission, permission) && wildcardMatch(rule.pattern, pattern)) {
        result = rule.action;
      }
    }
  }
  return result;
}
