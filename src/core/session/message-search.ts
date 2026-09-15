import type { Part } from "./types.js";

export type MessageSearchHit = {
  sessionId: string; messageId: string; partId: string;
  kind: "text" | "tool" | "attachment_name";
  messageSeq: number; snippet: string; match: { start: number; length: number };
};

/** Search is deliberately narrower than the transcript: never index tool inputs,
 * output logs, reasoning, file URLs or decoded attachment bodies. */
export function searchablePart(part: Part): { kind: MessageSearchHit["kind"]; text: string } | null {
  let text: string;
  let kind: MessageSearchHit["kind"];
  if (part.type === "text") { text = part.text; kind = "text"; }
  else if (part.type === "file") { text = part.filename; kind = "attachment_name"; }
  else if (part.type === "tool") {
    text = `${part.tool} ${"title" in part.state ? part.state.title ?? "" : ""}`;
    kind = "tool";
  } else return null;
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[=:]\s*)[^\r\n]+/gi, "$1[redacted]");
  return text ? { kind, text } : null;
}

export function searchSnippet(text: string, query: string): Pick<MessageSearchHit, "snippet" | "match"> {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + query.length + 60);
  const prefix = start > 0 ? "..." : "";
  return { snippet: prefix + text.slice(start, end) + (end < text.length ? "..." : ""), match: { start: prefix.length + index - start, length: query.length } };
}
