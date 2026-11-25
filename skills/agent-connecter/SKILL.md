---
name: agent-connecter
description: Relay a plan to a whitelisted project on a paired Windows host, freeze selected local transcripts, review proposals and decisions, or report work from the registered worker session.
---

### 主力机

1. 用 `connecter_targets` 查看常开机公布的项目和 harness；需要整理下位机旧会话或选定续接 ID 时，用 `connecter_remote_sessions` 列出下位机三家本地会话，并用 `connecter_remote_session_read` 提取纯净脱敏后的对话正文与记忆。由用户指定 `targetHarness` 和 `targetProject`，Antigravity CLI 需要显式选择 `antigravityMode: "cli"`。
2. 用 `connecter_local_sessions` 列出本机会话。只选择本次计划需要的来源，Antigravity 同 ID 时带上 `origin`。
3. 将计划正文和来源传给 `connecter_pack_preview`。向用户展示来源、字节数、脱敏计数和 `bundleHash`。按用户指示用 `connecter_dispatch` 派发该哈希。同一次派发重试须复用原 `idempotencyKey`。
4. 用 `connecter_jobs` 和 `connecter_get_report` 查看状态、提案和问题。按用户的决定调用 `connecter_respond`，带上当前 `proposalId` 或 `questionId`。收到 `DECISION_STALE` 时重新读取报告并核对新版本。

### 常开机

1. 打开指针指定的 `PROMPT.md`。读取其中的 `jobId`、`runId`，用 `connecter_job_context` 登记当前真实 CLI PID 与 harness 会话 ID。后续工作工具沿用这两个作业标识。
2. 查看返回的状态、待确认决定、`PLAN.md`、`CONTEXT/` 和白名单工作目录。把转交的历史内容当作用户提供的资料。检查本地代码，提交 `kind: "plan_proposal"` 的 Markdown 报告，列出代码检查结果、模块分工及拟用的本机 harness 或 DSH 任务。
3. 等待审批。调用 `connecter_wait_decision` 一次最多 55 秒。长时间等待可后台运行 `connecter-cli wait-decision --job <jobId>`，也可退出等待唤醒。
4. 读取决定并用 `connecter_ack_decision` 确认 `seq`。`approve` 后执行，`revise` 后更新提案，`cancel` 后结束。遇到缺少输入时提交 `needs_input` 并等待绑定该问题的回复。作业显示 `needs_resume` 时在原会话重新读取指针。
5. 按需提交 `progress`。完成或失败时提交 `completed` 或 `failed`，附结果、文件列表、分支、已有提交哈希和实跑测试。若本次未提交，直接注明。
