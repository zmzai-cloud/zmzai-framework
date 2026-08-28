import type { ModelProvider } from "./index.js";
import type { ModelRef, SessionInfo } from "../core/session/types.js";
import type { Api, Context, Model, SimpleStreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai";

/** 动态额外请求头（如登录态 cookie）。函数形式每次请求前求值，支持异步。 */
export type ProviderHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

/** OpenAI-compatible ModelProvider (M5 CLI reference): drives the framework
 *  against any OpenAI-compatible chat-completions endpoint via env vars:
 *
 *   OPENAI_BASE_URL=https://api.openai.com/v1
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL=gpt-4o            (default model)
 *
 *  The same provider serves relay-compatible backends (m.zmzai.cloud uses the
 *  OpenAI wire format), so the framework runs standalone with zero product
 *  coupling. headers 选项用于注入登录态 cookie 等动态鉴权头。 */
export function createOpenAiModelProvider(input?: {
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: ProviderHeaders;
}): ModelProvider {
  const baseUrl = (input?.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = input?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  const defaultModel = input?.defaultModel ?? process.env.OPENAI_MODEL ?? "gpt-4o";
  const resolveHeaders = async (): Promise<Record<string, string>> => {
    const h = input?.headers;
    if (!h) return {};
    return typeof h === "function" ? await h() : h;
  };

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
        // 兼容开关收紧到经典 OpenAI 字段：部分上游（含 relay 的通道）对
        // strict / stream_options 等新字段会 400，这里显式禁用。
        compat: {
          supportsStrictMode: false,
          maxTokensField: "max_tokens",
          supportsUsageInStreaming: false,
          supportsReasoningEffort: false,
          supportsFinishReason: true,
        },
      } as never;
    },
    streamFor(session: SessionInfo) {
      void session;
      // streamFn built per call; auth cookie injected by the custom fetch below.
      return (async (model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> => {
        const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
        const dynamicHeaders = await resolveHeaders();
        return streamSimple(
          model as never,
          context,
          {
            ...(options ?? {}),
            // 占位 key：pi-ai 要求非空 apiKey（否则 throw）。relay 不校验
            // Bearer，真实鉴权靠下方自定义 fetch 注入的登录 cookie。
            apiKey: "cookie-auth",
            maxTokens: options?.maxTokens ?? 16_384,
            // 自定义 fetch：剥掉 SDK 自动生成的 Authorization（relay 对无效
            // Bearer 直接 401，不会回退到 cookie 登录态），再注入动态头。
            fetch: async (url: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
              const headers = new Headers(init?.headers);
              headers.delete("authorization");
              for (const [name, value] of Object.entries(dynamicHeaders)) headers.set(name, value);
              return fetch(url, { ...(init ?? {}), headers });
            },
          } as never,
        );
      }) as never;
    },
  };
}
