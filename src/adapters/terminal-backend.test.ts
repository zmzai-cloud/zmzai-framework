import { describe, expect, it } from "vitest";

import { shellSpecFor } from "./terminal-backend.js";

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
