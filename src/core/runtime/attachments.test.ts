import { expect, it } from "vitest";
import { validateAttachments } from "./attachments.js";
const bytes = Buffer.from("你好");
const file = { name: "a.md", mediaType: "text/plain", size: bytes.length, data: `data:text/plain;base64,${bytes.toString("base64")}` };
it("validates actual decoded size and UTF-8", () => { expect(validateAttachments([file])).toEqual([file]); });
it.each([{ size: 1 }, { data: "https://example.com" }, { name: "../a.md" }, { mediaType: "application/pdf" }, { data: "data:text/plain;base64,/w==", size: 1 }])("rejects invalid attachments %j", (change) => { expect(() => validateAttachments([{ ...file, ...change }])).toThrow(); });
