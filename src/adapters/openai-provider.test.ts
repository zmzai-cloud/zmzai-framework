import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOpenAiModelProvider } from "./openai-provider.js";
import type { ModelRef } from "../core/session/types.js";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
});

describe("createOpenAiModelProvider", () => {
  describe("getModel", () => {
    it("returns model with default settings", () => {
      const provider = createOpenAiModelProvider();
      const model = provider.getModel({ providerId: "openai", modelId: "gpt-4o" });
      expect(model.id).toBe("gpt-4o");
      expect(model.api).toBe("openai-completions");
      expect(model.provider).toBe("zmzai-openai");
      expect(model.input).toEqual(["text", "image"]);
      expect(model.contextWindow).toBe(128_000);
      expect(model.maxTokens).toBe(16_384);
    });

    it("uses defaultModel when modelId is empty", () => {
      process.env.OPENAI_MODEL = "deepseek-v3";
      const provider = createOpenAiModelProvider();
      const model = provider.getModel({ providerId: "x", modelId: "" });
      expect(model.id).toBe("deepseek-v3");
    });

    it("respects explicit input overrides", () => {
      const provider = createOpenAiModelProvider({
        baseUrl: "https://custom.api.com/v1",
        apiKey: "custom-key",
        defaultModel: "custom-model",
      });
      const model = provider.getModel({ providerId: "x", modelId: "" });
      expect(model.id).toBe("custom-model");
      expect(model.baseUrl).toBe("https://custom.api.com/v1");
    });

    it("strips trailing slash from baseUrl", () => {
      const provider = createOpenAiModelProvider({ baseUrl: "https://api.test.com/v1/" });
      const model = provider.getModel({ providerId: "x", modelId: "test" });
      expect(model.baseUrl).toBe("https://api.test.com/v1");
    });

    it("reads baseUrl from OPENAI_BASE_URL env", () => {
      process.env.OPENAI_BASE_URL = "https://env.api.com/v1";
      const provider = createOpenAiModelProvider();
      const model = provider.getModel({ providerId: "x", modelId: "test" });
      expect(model.baseUrl).toBe("https://env.api.com/v1");
    });

    it("uses the real context window when the model catalog covers the model", () => {
      const provider = createOpenAiModelProvider({
        modelCaps: (id) => (id === "long-ctx" ? { contextWindow: 1_000_000, maxTokens: 65_536 } : undefined),
      });
      const model = provider.getModel({ providerId: "x", modelId: "long-ctx" });
      expect(model.contextWindow).toBe(1_000_000);
      expect(model.maxTokens).toBe(65_536);
    });

    it("falls back to defaults when the catalog does not cover the model", () => {
      const provider = createOpenAiModelProvider({ modelCaps: () => undefined });
      const model = provider.getModel({ providerId: "x", modelId: "unknown" });
      expect(model.contextWindow).toBe(128_000);
      expect(model.maxTokens).toBe(16_384);
    });

    it("falls back per field when the catalog covers only one dimension", () => {
      const provider = createOpenAiModelProvider({ modelCaps: () => ({ contextWindow: 200_000 }) });
      const model = provider.getModel({ providerId: "x", modelId: "m" });
      expect(model.contextWindow).toBe(200_000);
      expect(model.maxTokens).toBe(16_384);
    });

    it("falls back to defaults when the caps resolver throws", () => {
      const provider = createOpenAiModelProvider({
        modelCaps: () => {
          throw new Error("catalog broken");
        },
      });
      const model = provider.getModel({ providerId: "x", modelId: "m" });
      expect(model.contextWindow).toBe(128_000);
      expect(model.maxTokens).toBe(16_384);
    });

    it("disables reasoning effort when the catalog does not cover the model", () => {
      // 关键契约：目录未覆盖时不得臆造「支持」，否则 UI 假开关 → relay 400
      const provider = createOpenAiModelProvider({ modelCaps: () => undefined });
      const model = provider.getModel({ providerId: "x", modelId: "unknown" });
      expect(model.compat.supportsReasoningEffort).toBe(false);
      expect((model.thinkingLevelMap as Record<string, string | null>).high).toBeNull();
    });

    it("maps allowed efforts into thinkingLevelMap and enables the switch", () => {
      const provider = createOpenAiModelProvider({
        modelCaps: (id) => (id === "m" ? { allowedReasoningEfforts: ["low", "medium", "high"] } : undefined),
      });
      const model = provider.getModel({ providerId: "x", modelId: "m" });
      expect(model.compat.supportsReasoningEffort).toBe(true);
      const map = model.thinkingLevelMap as Record<string, string | null>;
      expect(map.low).toBe("low");
      expect(map.medium).toBe("medium");
      expect(map.high).toBe("high");
      expect(map.xhigh).toBeNull();
      expect(map.max).toBeNull();
      expect(map.minimal).toBeNull();
    });

    it("keeps the switch off when the allowed list is empty", () => {
      const provider = createOpenAiModelProvider({ modelCaps: () => ({ allowedReasoningEfforts: [] }) });
      const model = provider.getModel({ providerId: "x", modelId: "m" });
      expect(model.compat.supportsReasoningEffort).toBe(false);
    });
  });

  describe("streamFor", () => {
    it("returns a function", () => {
      const provider = createOpenAiModelProvider({ apiKey: "test" });
      const session = { id: "ses_1" } as never;
      const streamFn = provider.streamFor(session);
      expect(typeof streamFn).toBe("function");
    });

    it("accepts a function-form failoverEndpoints resolver", () => {
      const resolver = vi.fn(() => [{ baseUrl: "https://backup.api.com/v1" }]);
      const provider = createOpenAiModelProvider({ apiKey: "test", failoverEndpoints: resolver });
      const streamFn = provider.streamFor({ id: "ses_1" } as never);
      expect(typeof streamFn).toBe("function");
      // resolver 在 streamFor 建函数时不求值（每请求才求值），这里只验证类型被接受。
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});
