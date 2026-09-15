import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSubprocessSandbox } from "./subprocess-sandbox.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const platform = process.platform;
const snapshot = { revisionId: null, files: [{ path: "hello.txt", content: "hello" }] };
const context = { toolCallId: "call-test", userId: "user-test", workspaceId: "ws-test", runId: "run-test" };

afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockClear();
  vi.mocked(existsSync).mockReset();
});

function windows(gitBin?: string, error?: string) {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("PATH", "C:\\Windows\\System32;D:\\Dev Tools\\Git\\cmd");
  vi.mocked(existsSync).mockImplementation((file) =>
    !!gitBin && ["sh.exe", "ls.exe", "find.exe"].some((name) => file === `${gitBin}\\${name}`));
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      if (error) child.emit("error", Object.assign(new Error(error), { code: "ENOENT" }));
      else child.emit("close", 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

describe("subprocess sandbox Windows commands", () => {
  it("resolves ls from Git on PATH without shell interpolation", async () => {
    windows("D:\\Dev Tools\\Git\\usr\\bin");
    const args = ["-la", "a & echo injected"];
    await createSubprocessSandbox().run({ ...context, command: { program: "ls", args }, snapshot });
    expect(spawn).toHaveBeenCalledWith("D:\\Dev Tools\\Git\\usr\\bin\\ls.exe", args,
      expect.objectContaining({ shell: false, windowsHide: true }));
  });

  it("adds Unix tools to the child PATH for sh compound commands", async () => {
    windows("D:\\Dev Tools\\Git\\usr\\bin");
    await createSubprocessSandbox().run({ ...context, command: { program: "sh", args: ["-c", "ls | cat"] }, snapshot });
    expect(spawn).toHaveBeenCalledWith("D:\\Dev Tools\\Git\\usr\\bin\\sh.exe", ["-c", "ls | cat"],
      expect.objectContaining({ env: expect.objectContaining({ PATH: expect.stringMatching(/^D:\\Dev Tools\\Git\\usr\\bin;/) }) }));
  });

  it("finds the standard Git installation when only Windows is on Path", async () => {
    windows("C:\\Program Files\\Git\\usr\\bin");
    vi.stubEnv("PATH", undefined);
    vi.stubEnv("Path", "C:\\Windows\\System32");
    vi.stubEnv("ProgramFiles", "C:\\Program Files");
    await createSubprocessSandbox().run({ ...context, command: { program: "find", args: ["."] }, snapshot });
    expect(spawn).toHaveBeenCalledWith("C:\\Program Files\\Git\\usr\\bin\\find.exe", ["."],
      expect.objectContaining({ env: expect.objectContaining({ Path: expect.stringMatching(/^C:\\Program Files\\Git\\usr\\bin;/) }) }));
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).not.toHaveProperty("PATH");
  });

  it("leaves native executables and their arguments unchanged", async () => {
    windows("D:\\Dev Tools\\Git\\usr\\bin");
    await createSubprocessSandbox().run({ ...context, command: { program: "node", args: ["-e", "console.log(42)"] }, snapshot });
    expect(spawn).toHaveBeenCalledWith("node", ["-e", "console.log(42)"], expect.objectContaining({ shell: false }));
  });

  it("honors a differently cased PATH override without duplicate environment keys", async () => {
    windows("E:\\PortableGit\\usr\\bin");
    await createSubprocessSandbox().run({ ...context, command: {
      program: "ls", args: [], env: { Path: "E:\\PortableGit\\cmd" },
    }, snapshot });
    const call = vi.mocked(spawn).mock.calls[0]!;
    expect(call[0]).toBe("E:\\PortableGit\\usr\\bin\\ls.exe");
    expect(call[2]?.env?.Path).toBe("E:\\PortableGit\\usr\\bin;E:\\PortableGit\\cmd");
    expect(call[2]?.env).not.toHaveProperty("PATH");
  });

  it("finds a per-user Git installation", async () => {
    windows("C:\\Users\\Tester\\AppData\\Local\\Programs\\Git\\usr\\bin");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\Tester\\AppData\\Local");
    await createSubprocessSandbox().run({ ...context, command: { program: "ls", args: [] }, snapshot });
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe("C:\\Users\\Tester\\AppData\\Local\\Programs\\Git\\usr\\bin\\ls.exe");
  });

  it("explains how to recover when Unix tools are missing", async () => {
    windows(undefined, "spawn ls ENOENT");
    await expect(createSubprocessSandbox().run({ ...context, command: { program: "ls", args: [] }, snapshot }))
      .rejects.toThrow(/Git for Windows/);
  });
});

describe("subprocess sandbox native execution", () => {
  it("runs a real process against the snapshot and preserves literal arguments", async () => {
    const result = await createSubprocessSandbox().run({ ...context, snapshot, command: {
      program: process.execPath,
      args: ["-e", "console.log(require('node:fs').readFileSync('hello.txt', 'utf8')); console.log(process.argv[1])", "literal & argument"],
    } });
    expect(result.ok).toBe(true);
    expect(result.outputText).toContain("hello");
    expect(result.outputText).toContain("literal & argument");
  });

  it("rejects cwd and snapshot paths that escape the temporary workspace", async () => {
    await expect(createSubprocessSandbox().run({ ...context, snapshot, command: {
      program: process.execPath, args: [], cwd: "../../outside",
    } })).rejects.toThrow(/escapes workspace/);
    await expect(createSubprocessSandbox().run({ ...context, snapshot: {
      revisionId: null, files: [{ path: "../../outside.txt", content: "secret" }],
    }, command: { program: process.execPath, args: [] } })).rejects.toThrow(/escapes workspace/);
  });

  it("emits a URL-safe file artifact path", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/fw-artifact-"));
    const result = await createSubprocessSandbox({ workspaceRoot: root }).run({ ...context,
      snapshot, command: { program: process.execPath, args: ["-e", "require('node:fs').writeFileSync('out file.txt', 'ok')"] },
    });
    expect(result.artifacts[0]?.downloadUrl).toMatch(/^file:\/\//);
    expect(result.artifacts[0]?.downloadUrl).toContain("out%20file.txt");
  });
});
