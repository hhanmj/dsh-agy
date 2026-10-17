# DSH × Antigravity CLI 原生子代理桥接

基于 [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy) 开发，MIT 许可。通过已登录的 Antigravity CLI 委派实际 UI/UX 和代码任务，主模型负责独立验收。

**当前版本：v0.4.1。** 已实测通过的 v0.4.0 前台任务、后台 Jobs、Better Sidebar 后台显示和会话恢复保持不变；新增 DSH 原生 Continuable 子会话桥接为**实验功能**，尚未完成真实 DSH 界面的端到端验证。v0.4.1 的发布包已显式开启预览模式。注意：DSH Desktop 某些版本启动时会错误地将通过本地 `.tgz` 安装的插件判为悬空链接并自动卸载；建议使用下述持久目录安装方式。

## 安装

先安装并登录 `agy` CLI，在源代码目录运行：

```powershell
npm ci
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stage-local-install.ps1
dsh plugin --profile web add ".\deploy\dsh-subagent-agy-reviewed"
```

这里 `web` 只是示例，使用你实际启动的 DSH Profile。务必安装真实目录 `deploy/dsh-subagent-agy-reviewed`，**不要使用 `.tgz` 路径**：Tauri 日志已观察到 `INTERNAL_PLUGIN_DANGLING_LINK_UNINSTALLING` 和 `Recovery uninstall removed plugin`。目录部署文件仅在本地生成并被 `.gitignore` 排除。安装完成后重启后端，并首先检查插件有没有再次被卸载；如被卸载，检查桌面端日志再决定下一步，不要循环重装。避免同时进行插件市场批量更新。

### v0.4.1 热修复部署（DSH 原生子代理收到工具定义时报错）

若 Better Sidebar 已显示原生子代理，但子会话报错 `AGY native bridge: DSH tools are not supported`，原因是 DSH 0.2 在 `allow: []` 后仍可能暴露子代理本地作用域的工具定义。适配器现在在传给 AGY CLI 前剥离工具声明和工具历史，但仍拒绝真实工具消息或非文本输入；不会捏造 DSH 工具调用。

为避免覆盖当前运行中的插件目录，可建立独立的修复目录（**仍为 v0.4.1**）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "F:\agy-subagebt\scripts\stage-local-install.ps1" -StageName dsh-subagent-agy-reviewed-hotfix
dsh plugin --profile web add "F:\agy-subagebt\deploy\dsh-subagent-agy-reviewed-hotfix"
```

等待后台任务完成，再重启 DSH 后端；新建子代理进行文本 PONG 测试，不要继续之前报错的子会话。安装前确保没有并发的插件市场更新。

## 功能

| 工具 | 用途 |
| --- | --- |
| `antigravity` | DSH 原生 SubagentRuntime 前台或后台派发 AGY 任务 |
| `antigravity_followup` | 恢复 AGY 原 conversation_id 继续修改 |
| `antigravity_evidence` | 独立工作区变更证据，默认尚未通过验收 |
| `antigravity_tasks` / `antigravity_cancel` | 任务查询与取消 |
| `antigravity_native_start` | **实验功能**：真实 DSH Continuable 子会话（需先启用） |
| `antigravity_trace` | 读取 AGY 执行记录：步骤、AGY 内部工具调用、错误、结果、取消/超时及关联的本地证据（分页） |
| `antigravity_models` | 只读：列出 `agy models` 实际返回的模型与 effort 档位（不启动 agent、不耗额度） |

### 每个原生子代理独立选模型（issue #1）

`antigravity_native_start({ description, prompt, model?, effort? })`。不传 `model` 时使用 `nativeDefaultModel` / `nativeDefaultEffort`（默认 **`gemini-3.8-flash` + `high`**，即 CLI 当前默认），并在 `agy models` 可用时校验；DSH 模型列表中不再单独列出 `agy-cli`（旧子代理仍可解析恢复）。

- 模型 ID 来自 `antigravity_models`：基础 ID（如 `gemini-3.8-flash` + `effort: low|medium|high`，缺省 high）或 CLI 变体 ID（如 `gemini-3.8-flash-low`）；无档位模型（如 `claude-sonnet-4-6`）不接受 effort。非法组合在**创建子代理之前**报错，不会生成子会话。
- 选择写入 DSH 自身的 `agentOptions.model / reasoningEffort`，由 DSH 持久化在子代理描述中，`send_message` 续轮与冷启动恢复都沿用。
- **实测：agy 续聊时若不传 `--model` 会退回默认模型**，因此每一轮（包括恢复会话）都会重新下发 `--model/--effort`；`antigravity_followup` 也会沿用任务原模型（显式换模型时丢弃旧 effort）。
- trace 中记录「请求值」（model / effort / 来源）；开启监督时，钩子回报 agy 实际运行的 `modelName`，摘要显示 `effective` 与 `verified: true`，否则明确为未验证。
- 原生适配器在 DSH 模型列表中列出 `agy-cli` 与真实模型（分组「Antigravity CLI (native child · experimental)」）。

### 在 DSH 主对话中直接选用 AGY 模型

在模型下拉中选择 `AGY · …` 后，主对话也会经由 AGY CLI 运行（`nativeMainSessionEnabled`，默认开启；关闭后只服务子代理）：

- AGY 在该会话的工作目录中使用**自己的工具**（同样带 `--dangerously-skip-permissions`，请只在可信目录中使用）；DSH 工具对它不可用，也不会被伪造。
- 不发送 DSH 系统提示词；切换前的 DSH 工具调用/结果以「已省略」注明；首轮历史过长时只保留最近能放进 CLI 参数限制的消息并注明省略数量。之后每轮通过同一个 AGY `conversation_id` 续聊。
- **图片**（`nativeImageInput`，默认开启）：图片从 DSH 附件库复制到系统临时目录（`%TEMP%/dsh-agy-images/…`，7 天后清理），通过 `--add-dir` 交给 AGY，并在提示中写明路径；AGY 用自己的查看工具打开（实测能正确识别测试图片左红右蓝）。
- DSH 的会话标题 / 压缩等辅助请求以一次性独立 AGY 调用完成，不进入该会话的 AGY 对话，也不采集证据。
- 主对话的执行记录可由该会话自己用 `antigravity_trace`（id = 会话 id）查看；主对话中 AGY 每完成一个自身工具步骤，会以 `> AGY · run_command … — done (0.4s)` 形式插入一行进度（`nativeChatToolProgress`，子代理只写入 trace）。
- **用量显示**：每轮把 AGY 自己报告的用量交给 DSH：提示侧（未缓存输入 + 缓存读取）取本轮最后一次模型调用，即当前上下文大小；输出与思考取本轮合计。因此 tok/s、累计用量、缓存命中与上下文占比都可显示；其中累计输入只计每轮最后一次调用（完整逐步用量在 trace 中）。上下文容量来自 `nativeContextWindows`（默认取厂商模型卡数值：Gemini 3.8 Flash 1,048,576、Claude 4.6 1,000,000、GPT-OSS 120B 131,072；agy 本身不报告，AGY 可能更早自行压缩）。
- **长任务**：单轮上限 `nativeTimeoutMs` 默认 60 分钟（原先沿用 5 分钟的前台上限），DSH 停止按钮会终止 AGY 进程树。

**验证状态：** 代码已实现；离线测试通过；真实 AGY 隔离验证通过（`node scripts/live-chat-e2e.mjs`：读图、续聊、标题）。**DSH Desktop 内待重启后实测。**
- `agy models --output-format json` 在 1.4.0 上不受支持（与更新日志不符），因此解析文本输出；按基础模型归组档位的方法参考了 [Jonah-Wu23/dsh-agy-safe](https://github.com/Jonah-Wu23/dsh-agy-safe)（MIT）。

**验证状态：** 代码已实现；离线测试通过；真实 AGY 1.4.0 隔离验证通过（`node scripts/live-models-e2e.mjs`：Claude Sonnet 4.6、Gemini 3.8 Flash Low、CLI 默认三个子代理各两轮，恢复会话后实际模型不变）。**DSH Desktop 实测（2026-10-17）**：`antigravity_models` 可用；同一主会话中 CLI 默认与 `claude-sonnet-4-6` 两个子代理互不串扰，`send_message` 续轮仍下发 `claude-sonnet-4-6`。**后端重启后冷恢复已实测通过**（同一子代理在重启后续轮仍下发 `claude-sonnet-4-6`、沿用同一 AGY 会话）；DSH 内实际生效模型需开启监督才能由钩子确认（该次实测未开启，显示为请求值）。

### AGY 执行事件桥接（stream-json）

实测 AGY 1.4.0 `--output-format stream-json` 的事件：`init`（conversation_id、工具列表、permission_mode）、`step_update`（step_index、state=ACTIVE/DONE/ERROR、step_type、text_delta、tool_name、`tool_info` = 名称 / 参数 / 输出 / 错误、usage）、`result`（status、response、usage）。`result.response` 等于全部 text_delta 拼接（含工具前的旁白），因此桥接不会重复追加最终回复。脱敏后的真实样本位于 `scripts/fixtures/`。本次采集中**未出现** `subagent_info`；该类未知字段只会作为不透明 `extra` 保存，不按传闻解析。

- **原生子会话**：AGY 的可见文字实时以 DSH `text-delta` 流入子会话；工具步骤没有诚实的 DSH StreamChunk 对应项，因此不会伪装成 `tool-call-delta` 或推理内容，而是写入 trace。AGY 隐藏推理链不在事件流中，也不会被记录。
- **前台/后台/followup**：受支持时统一使用 stream-json；结果语义不变。后台 `job_output` 的进度标记变为 `[agy: tool run_command done]` / `[agy: tool view_file error: ...]`，并修复了多字节字符跨数据块时的乱码。
- **trace**：每个原生子会话（childId）或任务键一个文件，默认保存在 `~/.dsh/agy-traces`（不在仓库中）；参数、输出与错误会脱敏（令牌/密码/私钥/URL 凭据）、截断，工作区路径改写为 `.`、主目录改写为 `~`，文件正文类参数只记录长度。每条 trace 有事件/字节上限，全局保留最近 200 个文件。只有发起委派的父代理可读取。
- **验收四阶段**：trace 摘要分别给出 `started`、`execution`（running/completed/failed/cancelled/timeout/interrupted）、`evidence`（本地 Git/文件快照证据，链接到 `antigravity_evidence`）和 `review`（始终为 pending，必须由 DSH 主代理自行检查代码、构建和测试）。
- 配置项：`traceEnabled`（默认 true）、`traceDir`、`traceToolName`、`traceMaxEvents`、`traceMaxFiles`。

**验证状态：** 代码已实现；离线测试通过（`npm test`）；真实 AGY 1.4.0 隔离验证通过（`node scripts/live-trace-e2e.mjs`）；**DSH Desktop 实测通过（2026-10-17）**：原生子代理运行中可用 `antigravity_trace` 分页看到 running → 步骤/工具调用（`git rev-parse` 输出）→ completed → 本地证据，`send_message` 续轮记录为 `native-followup` 并沿用同一 `conversation_id`。

### 与 AGY 共享 DSH 技能（`sharedSkills`）

配置 `sharedSkills`（技能名、以 `*` 结尾的前缀，或 `*` 表示全部可由模型调用的 DSH 技能）后，每次运行插件从 DSH 技能注册表取出这些技能的目录，在 `~/.dsh/agy-skill-bridge/<哈希>/.agents/skills.json` 中声明（`path` + `include_only`），并用 `--add-dir` 交给 AGY。**不复制、不链接、不写入仓库或 `~/.gemini`**。实测：AGY 1.4.0 会读取 add-dir 中的 `skills.json`（支持 Windows 绝对路径），并在需要时用 `view_file` 打开对应 `SKILL.md`（`node scripts/live-skills-e2e.mjs`）。开启监督时，这些技能目录可读但不可写。依赖 DSH 专有工具（如 `skill`、`ego_*`、`run_code`）的技能在 AGY 中无法生效，建议只共享纯说明/脚本型技能；共享过多会增加 AGY 每轮上下文（技能名与描述）。

AGY 自身添加技能的方式：`~/.gemini/config/skills/<名称>/SKILL.md`（全局）、项目 `.agents/skills/<名称>/SKILL.md`、`~/.gemini/config/skills.json` 声明外部目录，或 `agy plugin install`；用 `agy -p "/skills" --output-format json` 查看（不耗额度）。

### AGY 思考链

AGY 1.4.0 不提供思考内容：stream-json 只有 `thinking_tokens` 计数，`PostInvocation` 钩子载荷也没有思考字段（已实测）。因此不显示、也不伪造思考链；主对话中的工具进度行与 `antigravity_trace` 是可见的真实执行过程。

### 可选监督（AGY Hooks，默认关闭）

设置 `supervisionEnabled: true` 后，每次运行在项目外（默认 `~/.dsh/agy-supervisor/<随机目录>`）生成 `.agents/hooks.json`、钩子脚本和策略，并通过 `--add-dir` 交给 AGY；**不写入你的仓库，也不改全局 AGY 配置**，运行结束后读取决策、校验文件哈希（发现篡改会记入 trace）并删除。

AGY 1.4.0 实测结论（隔离目录，`-p --dangerously-skip-permissions`）：
- `PreToolUse` 返回 `deny` **即使开启 skip-permissions 也会阻断**，原因会以工具错误出现在 stream-json 和 trace 中；返回空 decision、畸形输出、非零退出或超时**同样阻断**（fail-closed），放行必须显式 `allow`。
- `Stop` 返回 `continue` + `reason` 会让 AGY 继续工作（返工），其他值允许结束。
- `--add-dir` 目录里的 `.agents/hooks.json` 会被加载；钩子继承 AGY 的环境变量，工作目录为 `.agents`。AGY 可能把该目录当成默认命令目录，因此提示中会注明真实工作区，钩子用 `overwrite` 把命令 Cwd 改回工作区（已实测）。

内置规则拒绝：`git push`、整体丢弃改动的 git 命令、发布包、`curl|sh` 类下载执行、删除根/主目录、系统级破坏命令、访问凭据与 AGY/DSH 状态目录（`~/.ssh`、`~/.gemini`、`~/.dsh` 等）、写入工作区之外、修改监督目录。可选：`supervisionDenyCommands`（额外正则）、`supervisionStopCheck`（结束前执行的验证命令，失败即要求返工，上限 `supervisionMaxReworks`）、`supervisionBuiltinRules`、`supervisionDir`。要求 `skipPermissions: true`；无法应用时直接拒绝运行，不会静默降级。

这是防误操作护栏，**不是安全边界**：开启 skip-permissions 的 AGY 拥有当前用户的文件权限。

**验证状态：** 代码已实现，默认关闭；离线测试通过；真实 AGY 1.4.0 隔离验证通过（`node scripts/live-supervision-e2e.mjs`：自定义规则拦截命令、普通命令执行、验证命令失败触发返工后通过、无篡改、监督文件已清理）。**尚未在 DSH Desktop 中实测。**

### v0.4.1 原生子代理实验模式

**设置入口：** 使用上面的持久目录部署包时，`cordis.patch.yml` 已经显式开启实验功能，**无需再运行开关脚本**。下列脚本仅供需要手动切换的用户使用，会备份当前 Profile；这不是插件市场里的 GUI 开关。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "F:\\agy-subagebt\\scripts\\set-native-preview.ps1" -Enable
```

关闭功能时换成 `-Disable`。脚本默认修改当前 DSH Desktop 使用的 `web` Profile；其他 Profile 可传 `-Profile <名称>`。随后**重启 DSH 后端**（仅刷新界面不够）。验证配置：

```powershell
cmd /c "dsh.cmd --profile web --dump-config 2>NUL" | Select-String "nativeContinuableEnabled" -Context 2,0
```

必须看到 `nativeContinuableEnabled: true`，再在新对话中检查是否能调用 `antigravity_native_start`。如果工具没有注册，先检查插件加载日志，不要反复重装。

然后让 DSH 主模型调用 `antigravity_native_start({description, prompt})`。工具仅在 DSH 子会话成功建立、首条消息进入 Inbox 后返回 `childId`，**并不代表 AGY 已经完成任务**。可在 Better Sidebar 原生子代理树观察子会话，通过 DSH 自带 `send_message` 向直接子代理发送后续指令。

这条路径是真实的 `ctx.subagents.startContinuable()`：DSH 创建并持久保存自己的子 Session / Agent，AGY CLI 作为其文本模型后端。AGY 自己执行代码任务，不会伪装成调用 DSH 工具。现阶段子代理不能主动用 DSH `send_message` 回报父代理；父代理要在子会话中查看结果。仅支持文本，不支持图片或 DSH 工具调用。AGY 会话映射单独保存在本机 `~/.dsh/agy-native-sessions.json`，用于继续会话，不应上传。

### 安全边界

默认向 AGY CLI 传递 `--dangerously-skip-permissions`，仅应在受信任、已授权的独立 Git 工作目录运行。使用 `--add-dir` 扩大的范围不会自动包含在证据快照中。

仓库不包含账号信息、API 密钥、OAuth 凭据、本地会话历史或私人日志。AGY 与 Google 服务条款可能限制第三方集成，请自行确认使用条件；代码不调用 Google 私有 API，也不提取登录令牌。

AGY 的“完成”不代表验收成功。主模型需要自行检查 Git diff、代码、构建和核心交互。

## 本地验证

```powershell
npm run build
node --test scripts/evidence.test.mjs scripts/plugin-smoke.test.mjs scripts/native-manager.test.mjs scripts/native-continuable.test.mjs scripts/stream-trace.test.mjs scripts/supervision.test.mjs scripts/models.test.mjs scripts/native-chat.test.mjs scripts/skills-bridge.test.mjs
```

全量 `npm test` 另外验证本地 AGY CLI 的存在及参数兼容性；真实 AGY 测试需主动运行 `npm run selftest:e2e`，或 `node scripts/live-trace-e2e.mjs`（消耗 AGY 额度，仅使用临时目录）。

## 致谢

原项目：[ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy)。许可：MIT，见 `LICENSE`。
