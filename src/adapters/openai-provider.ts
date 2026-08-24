import type { ModelProvider } from "./index.js";
import type { ModelRef, SessionInfo } from "../core/session/types.js";
import type { Api, Context, Model, SimpleStreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai";

/** OpenAI-compatible ModelProvider (M5 CLI reference): drives the framework
 *  against any OpenAI-compatible chat-completions endpoint via env vars:
 *
 *   OPENAI_BASE_URL=https://api.openai.com/v1
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL=gpt-4o            (default model)
 *
 *  The same provider serves relay-compatible backends (m.zmzai.cloud uses the
 *  OpenAI wire format), so the framework runs standalone with zero product
 *  coupling. */
export function createOpenAiModelProvider(input?: { baseUrl?: string; apiKey?: string; defaultModel?: string }): ModelProvider {
  const baseUrl = (input?.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = input?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  const defaultModel = input?.defaultModel ?? process.env.OPENAI_MODEL ?? "gpt-4o";

  return {
    getModel(ref: ModelRef) {
      return {
        id: ref.modelId || defaultModel,
        name: ref.modelId || defaultModel,
        api: "openai-completions",
        provider: "zmzai-openai",
        baseUrl,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      } as never;
    },
    streamFor(session: SessionInfo) {
      void session;
      // streamFn built per call; auth header injected by the provider wrapper.
      return (async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
        const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
        const stream = createAssistantMessageEventStream();
        void (async () => {
          try {
            const messages = (context.messages ?? []).map((message: { role: string; content?: unknown; toolCallId?: string }) => {
              if (message.role === "user" || message.role === "assistant") {
                const content = message.content;
                if (typeof content === "string") return { role: message.role, content };
                if (Array.isArray(content)) {
                  const blocks = content.map((b: { type?: string; text?: string; image_url?: { url: string } }) => {
                    if (b.type === "text") return { type: "text" as const, text: b.text ?? "" };
                    if (b.type === "image_url" && b.image_url?.url) return { type: "image_url" as const, image_url: { url: b.image_url.url } };
                    return null;
                  }).filter(Boolean);
                  return { role: message.role, content: blocks };
                }
              }
              if (message.role === "toolResult") {
                const text = Array.isArray(message.content)
                  ? message.content.filter((b: { type?: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n")
                  : String(message.content ?? "");
                return { role: "tool", content: text, tool_call_id: (message as unknown as { toolCallId?: string }).toolCallId ?? "" };
              }
              return null;
            }).filter(Boolean);

            const response = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
              body: JSON.stringify({
                model: model.id,
                messages,
                stream: true,
                ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
              }),
            });
            if (!response.ok || !response.body) {
              const error = { type: "error" as const, reason: "error" as const, error: await response.text().catch(() => "HTTP error") };
              stream.push(error as never);
              stream.end(error as never);
              return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            const partial: { role: "assistant"; content: { type: "text"; text: string }[] } = { role: "assistant", content: [{ type: "text", text: "" }] };
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const data = trimmed.slice(5).trim();
                if (data === "[DONE]") continue;
                try {
                  const chunk = JSON.parse(data);
                  const delta = chunk.choices?.[0]?.delta?.content;
                  if (delta) {
                    partial.content[0]!.text += delta;
                    stream.push({ type: "text_delta", contentIndex: 0, delta, partial } as never);
                  }
                } catch {
                  // partial JSON — ignore
                }
              }
            }
            stream.push({ type: "done", reason: "stop", message: partial } as never);
            stream.end(partial as never);
          } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            stream.push({ type: "error", reason: "error", error: err } as never);
            stream.end({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: err } as never);
          }
        })();
        return stream;
      }) as never;
    },
  };
}
