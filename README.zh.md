# DSH × Antigravity CLI 原生子代理桥接

基于 [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy) 开发，MIT 许可。通过已登录的 Antigravity CLI 委派实际 UI/UX 和代码任务，主模型负责独立验收。

**当前版本：v0.4.1。** 已实测通过的 v0.4.0 前台任务、后台 Jobs、Better Sidebar 后台显示和会话恢复保持不变；新增 DSH 原生 Continuable 子会话桥接为**实验功能**，尚未完成真实 DSH 界面的端到端验证。v0.4.1 的发布包已显式开启预览模式；此前安装的同版本发布包可直接使用下述开关脚本，无需重新下载。

## 安装

先安装并登录 `agy` CLI，在源代码目录运行：

```powershell
npm install
npm test
npm pack
dsh plugin --profile web add ".\dsh-external-dsh-subagent-agy-reviewed-0.4.1.tgz"
```

这里 `web` 只是示例，使用你实际启动的 DSH Profile。更新安装包需要重启对应后端。避免同时进行插件市场的批量更新。

## 功能

| 工具 | 用途 |
| --- | --- |
| `antigravity` | DSH 原生 SubagentRuntime 前台或后台派发 AGY 任务 |
| `antigravity_followup` | 恢复 AGY 原 conversation_id 继续修改 |
| `antigravity_evidence` | 独立工作区变更证据，默认尚未通过验收 |
| `antigravity_tasks` / `antigravity_cancel` | 任务查询与取消 |
| `antigravity_native_start` | **实验功能**：真实 DSH Continuable 子会话（需先启用） |

### v0.4.1 原生子代理实验模式

**设置入口：** 本项目提供 PowerShell 开关脚本；这不是插件市场里的 GUI 开关。对当前已安装的 v0.4.1，直接运行（自动备份 Profile 配置，支持恢复）：

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
node --test scripts/evidence.test.mjs scripts/plugin-smoke.test.mjs scripts/native-manager.test.mjs scripts/native-continuable.test.mjs
```

全量 `npm test` 另外验证本地 AGY CLI 的存在及参数兼容性；真实 AGY 测试需主动运行 `npm run selftest:e2e`。

## 致谢

原项目：[ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy)。许可：MIT，见 `LICENSE`。