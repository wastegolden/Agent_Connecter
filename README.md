# Agent Connecter

在 Windows 局域网内把计划和选定的本机会话交给常开机，审批实施方案，接收进度、问题和最终报告。两台机器安装同一个 `agent-connecter` 插件。需要 Node.js 24+，无运行时 npm 依赖。

## 安装与配对

在常开机的普通桌面登录账户下运行。先安装 Windows Terminal 和准备使用的 harness，并确认该账户可以启动它们。以下为 PowerShell 示例。

```powershell
node scripts/setup-server.mjs --project 'app=D:\Projects\App' --task --serve-updates
node bin/connecter-cli.mjs pair
```

`--task` 注册并启动登录时运行的 Windows 计划任务，使用当前交互账户和 Limited 权限。手工运行时可省略该选项，再执行 `node bin/connecter-server.mjs`。需要开通局域网端口时，在管理员 PowerShell 单独运行一次 `node scripts/setup-server.mjs --firewall`，规则限定 Private 网络、LocalSubnet 和 LAN 端口。可通过重复 `--project` 添加项目，`--lan-port` 与 `--local-port` 分别选择监听端口。

在主力机输入常开机显示的六位配对码。有效期五分钟，成功使用一次即作废，连续五次失败会锁定该码。重新运行 `pair` 可生成新码。

```powershell
node scripts/setup-client.mjs --server http://192.168.1.10:3090 --code 012345 --name workstation
node bin/connecter-cli.mjs targets
```

在两台机器各自的 Codex、Claude Code 或 Antigravity 插件管理器中，将 setup 输出的 `current` 目录注册为本地插件目录，重开会话加载工具。命令示例使用仓库内 bin 文件。npm 安装或链接后也可用 `connecter-cli`、`connecter-server` 等同名命令。

首次配对将服务端 UUID、客户端 ID、地址和原始令牌写入主力机配置目录的 `credentials.json`。服务端 SQLite 仅存令牌摘要。后续连接会校验已固定的 UUID 及协议、插件主版本。重新绑定另一台机器时请先移走旧凭据。吊销某个名称的所有客户端令牌使用 `node bin/connecter-cli.mjs revoke workstation`。纯 HTTP 的投递与凭据适用于受信任局域网，TOFU 与 SHA-256 不提供链路加密或发布者签名。

## 投递与审批

```powershell
node bin/connecter-cli.mjs local-sessions
node bin/connecter-cli.mjs pack --plan .\PLAN.md --sources .\sources.json
node bin/connecter-cli.mjs dispatch --bundle <bundleHash> --harness codex --project app --key <unique-key>
node bin/connecter-cli.mjs report --job <jobId>
node bin/connecter-cli.mjs approve --job <jobId> --proposal <proposalId>
node bin/connecter-cli.mjs reply --job <jobId> --question <questionId> --message '采用方案 A'
```

`sources.json` 是数组，例如 `[{"harness":"antigravity","id":"会话ID","origin":"app"}]`。仅派发计划可省略 `--sources`。预览返回来源清单、各源字节数与哈希、替换次数、冻结 gzip 路径及其 SHA-256。重试时沿用相同预览、目标和幂等键，服务端按客户端保留 24 小时。新任务使用新键。

目标 harness 可以是 `codex`、`claude-code`、`antigravity`。续接时使用 `--session ID`，同一活动会话只接受一个作业。不同会话并行。模型、推理强度可通过 `--model`、`--effort` 指定，具体支持取决于该 harness 的命令。Antigravity 默认走桌面 App，显式 `--antigravity-mode cli` 使用 CLI。

工作会话收到本地 `PROMPT.md` 的短指针，用真实会话 ID 和 PID 注册并提交计划。审批使用当前提案 ID，可批准、要求修订或取消。修订后的提案有新 ID 和递增版本。执行中可以提交问题并按该问题 ID 请求回复。工作会话确认决定序号后继续。对于仍存活且无法注入的会话，`needs_resume` 表示应回到原会话，读取该作业的指针并确认待处理决定。

打开常开机 LAN 根地址，粘贴客户端令牌即可使用仪表板。令牌仅保存在此页面内存中。作业和决定以 SQLite 为准，`data/jobs/<id>/` 下保存计划、上下文、带随机边界的提示和决定 Markdown。主力机运行 `node bin/connecter-notifier.mjs` 可接收 Windows Toast。SSE 使用持久化事件号续接，最多保留 24 小时内最近 500 条。离线更久时用 `jobs` 和 `report` 查看完整当前状态。

## 配置与桌面 Sidecar

默认配置目录为 `~/.agent-connecter`，环境变量 `AGENT_CONNECTER_HOME` 可覆盖。以下配置将项目 `app` 绑定到常开机上的目录。

```json
{
  "mode": "server",
  "lanPort": 3090,
  "localPort": 3091,
  "projects": {"app": "D:\\Projects\\App"},
  "antigravityProjects": {"app": "desktop-project-id"},
  "serveUpdates": true
}
```

客户端设置 `"mode": "client"`，开发联调可用 `"both"`。可设置 `dataDir`、`previewDir`、`installDir` 和 `executables`。可执行文件覆盖键为 `wt`、`codex`、`claude-code`、`antigravity`、`agentapi`。LAN 默认绑定 `0.0.0.0:3090`，内部作业及 Sidecar 接口固定绑定 IPv4 回环，默认端口 3091。两套端口的路由互相隔离。作业凭据限定 job 和 run，并保存在该作业本地文件内。

启用 Antigravity 插件的 `agent-connecter/antigravity-bridge` Sidecar。在 App 的 Sidecar 设置中启用它并选择项目。支持配置文件的版本在 `~/.gemini/config/config.json` 的 `sidecars` 中设置该键，例如 `{"enabled":true,"projectId":"desktop-project-id"}`。多项目请用 `antigravityProjects` 将白名单键映射到 App 项目 ID。Sidecar 从 App 获取 agentapi 连接环境，经回环 SSE 接收创建或唤醒指令。App 离线将返回 `TARGET_HARNESS_UNAVAILABLE`。恢复 App 会话时，agentapi 按 conversationId 定位，请选择该项目已有的会话 ID。CLI 和工作会话需运行在当前已登录的桌面账户下。

## 上下文来源

| 来源 | 选择和清洗规则 |
| --- | --- |
| Codex | 联表筛选本地主机目录，目录不可用时读本地 JSONL 索引。扫描活动和归档 rollout。保留会话元数据、双方原文、图片标记及工具名。合并两个 memories 数据库中的最新线程记忆和磁盘记忆文件。 |
| Claude Code | 从项目 JSONL 读取实际 cwd、正文、会话链和工具摘要，并附项目 `memory/*.md`。大工具结果默认附完整脱敏文本，正文保留首尾与错误。可选 `--include-thinking`、`--include-history`。 |
| Antigravity | 分别扫描 App 和 CLI 目录，读摘要库与 brain。被截断的记录按 `step_index` 从完整日志恢复，并附 Markdown 成果。 |

清洗不调用模型。脱敏覆盖常见 API 密钥、Bearer 令牌和 PEM 私钥。预览中的 `redactedCount` 记录替换总数。活跃的 SQLite WAL 通过在线备份获取一致快照，干净库先复制再打开。上传校验冻结包 SHA-256，压缩上限 32 MiB，解压上限 128 MiB。

## MCP、更新与验证

主力机工具为 `connecter_targets`、`connecter_local_sessions`、`connecter_pack_preview`、`connecter_dispatch`、`connecter_jobs`、`connecter_get_report`、`connecter_respond`。常开机工作工具为 `connecter_job_context`、`connecter_submit_report`、`connecter_wait_decision`、`connecter_ack_decision`。MCP stdio 使用换行分隔的 JSON-RPC，运行中的等待可与其他调用并行。

启用 `serveUpdates` 后，主力机运行 `node bin/connecter-cli.mjs update`。更新程序校验 manifest 与 bundle 的 SHA-256、版本、插件清单及入口文件，暂存成功后切换 `%LOCALAPPDATA%\agent-connecter\current`。失败时保留此前可用版本。Windows 原子切换使用 NTFS junction 和系统 PowerShell。以后可通过 `node "$env:LOCALAPPDATA\agent-connecter\current\bin\connecter-cli.mjs" targets` 运行当前版本。既有 MCP 进程继续运行。下次加载指向该目录的插件时读取新版本。使用独立插件缓存的宿主需要刷新缓存。

```powershell
node --test
node scripts/validate-plugins.mjs
```

单元与集成测试使用临时项目、真实 SQLite 和本机 HTTP 监听。可见终端、真实 App 会话、登录任务与 WinRT 通知需在目标桌面账户下验收。
