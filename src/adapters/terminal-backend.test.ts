import { describe, expect, it } from "vitest";

import { probeCommandFor, shellSpecFor } from "./terminal-backend.js";

/** 终端会话的退出态完全由进程退出事件驱动（`TerminalBackend.onExit`），
 *  所以 shell 规格必须保证「命令跑完即退出」。
 *
 *  回归锚点：Windows 加固提交曾给 pwsh/powershell 加上 `-NoExit`，使 PowerShell
 *  执行完命令后继续挂在交互提示符上——Windows 上每个终端会话都永远停在 running，
 *  跨盘冒烟与打包冒烟的「Terminal did not exit」断言都会被打挂。这类缺陷只在
 *  Windows 上暴露，用一个纯函数断言把它钉在 1 秒级的单测里。 */
describe("shellSpecFor：一次执行型 shell 规格", () => {
  it("Windows pwsh：不带 -NoExit，且以 -Command 结尾（命令作为最后一个参数）", () => {
    const spec = shellSpecFor("win32", { hasPwsh: true, hasPowershell: true });
    expect(spec.file).toBe("pwsh.exe");
    expect(spec.prefixArgs).not.toContain("-NoExit");
    expect(spec.prefixArgs[spec.prefixArgs.length - 1]).toBe("-Command");
  });

  it("Windows PowerShell 兜底：同样不带 -NoExit", () => {
    const spec = shellSpecFor("win32", { hasPwsh: false, hasPowershell: true });
    expect(spec.file).toBe("powershell.exe");
    expect(spec.prefixArgs).not.toContain("-NoExit");
    expect(spec.prefixArgs[spec.prefixArgs.length - 1]).toBe("-Command");
  });

  it("两者都缺时回落 cmd，用 /c 执行后退出", () => {
    const spec = shellSpecFor("win32", { hasPwsh: false, hasPowershell: false, comSpec: undefined });
    expect(spec.file).toBe("cmd.exe");
    expect(spec.prefixArgs).toEqual(["/d", "/s", "/c"]);
  });

  it("POSIX 用 sh -c，与 Windows 分支语义一致（都返回一个执行型 shell 规格）", () => {
    const spec = shellSpecFor("linux", { hasPwsh: false, hasPowershell: false });
    expect(spec.file).toBe("/bin/sh");
    expect(spec.prefixArgs).toEqual(["-c"]);
  });
});

/** 回归锚点：probePtySpawn 曾硬编码 /bin/sh -c true——Windows 上没有 /bin/sh，
 *  探测必失败 → 打包版在真实 Windows 上永久静默降级 pipe。探测命令必须跟随
 *  shellSpecFor 的跨平台规格，且语义是一次性执行（跑完即退）。 */
describe("probeCommandFor：跨平台 pty 探测命令", () => {
  it("Windows pwsh：用 pwsh -Command exit 0，不引用 /bin/sh", () => {
    const cmd = probeCommandFor("win32", { hasPwsh: true, hasPowershell: true });
    expect(cmd.file).toBe("pwsh.exe");
    expect(cmd.args).toEqual(["-NoLogo", "-NoProfile", "-Command", "exit 0"]);
    expect(cmd.args.join(" ")).not.toContain("/bin/sh");
  });

  it("Windows 兜底：powershell 与 cmd 分支同样可执行 exit 0", () => {
    expect(probeCommandFor("win32", { hasPwsh: false, hasPowershell: true }).file).toBe("powershell.exe");
    const cmd = probeCommandFor("win32", { hasPwsh: false, hasPowershell: false });
    expect(cmd.file).toBe("cmd.exe");
    expect(cmd.args).toEqual(["/d", "/s", "/c", "exit 0"]);
  });

  it("POSIX：sh -c exit 0，保持原探测语义", () => {
    expect(probeCommandFor("darwin", { hasPwsh: false, hasPowershell: false })).toEqual({
      file: "/bin/sh",
      args: ["-c", "exit 0"],
    });
  });
});
