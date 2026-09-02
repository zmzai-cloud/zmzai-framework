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
  });

  describe("streamFor", () => {
    it("returns a function", () => {
      const provider = createOpenAiModelProvider({ apiKey: "test" });
      const session = { id: "ses_1" } as never;
      const streamFn = provider.streamFor(session);
      expect(typeof streamFn).toBe("function");
    });
  });
});
