/** Pure workspace text-edit + diff helpers, shared by the framework's
 *  mongo-workspace (direct write/edit) and any code that renders a unified
 *  diff. Extracted from the legacy proposals module so the proposal-staging
 *  machinery could be retired without losing these. */

export type FileChange = {
  path: string;
  operation: "create" | "update" | "delete";
  before: string | null;
  after: string | null;
};

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

function diffLines(prefix: string, value: string | null): string[] {
  if (value === null || value === "") return [];
  return value.split("\n").map((line) => `${prefix}${line}`);
}

export function createUnifiedDiff(change: FileChange): string {
  const beforeLabel = change.before === null ? "/dev/null" : `a/${change.path}`;
  const afterLabel = change.after === null ? "/dev/null" : `b/${change.path}`;
  return [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -1,${lineCount(change.before ?? "")} +1,${lineCount(change.after ?? "")} @@`,
    ...diffLines("-", change.before),
    ...diffLines("+", change.after),
  ].join("\n");
}

/** Applies an exact oldText → newText replacement. Returns an error when the
 *  target is missing or occurs more than once (ambiguous edit). */
export function applySingleEdit(content: string, oldText: string, newText: string): { content: string } | { error: string } {
  if (!oldText) return { error: "EDIT_TARGET_REQUIRED" };
  const first = content.indexOf(oldText);
  if (first === -1) return { error: "EDIT_TARGET_NOT_FOUND" };
  if (content.indexOf(oldText, first + oldText.length) !== -1) return { error: "EDIT_TARGET_AMBIGUOUS" };
  return { content: `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}` };
}
