---
"@zmzai/agent-framework": patch
---

新增 `isSessionAwaitingPermission(sessionId)`：查询会话当前 run 是否挂起等待人工授权（HITL 待确认）。供宿主会话列表把「待确认」从笼统的「运行中」区分出来——后台会话被权限请求卡住时侧边栏能直接给出信号。
