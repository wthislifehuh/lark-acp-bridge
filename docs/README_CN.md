# lark-acp

[![npm version](https://img.shields.io/npm/v/lark-agent-acp-bridge.svg)](https://www.npmjs.com/package/lark-agent-acp-bridge)
[![npm downloads](https://img.shields.io/npm/dm/lark-agent-acp-bridge.svg)](https://www.npmjs.com/package/lark-agent-acp-bridge)
[![node version](https://img.shields.io/node/v/lark-agent-acp-bridge.svg)](https://www.npmjs.com/package/lark-agent-acp-bridge)
[![license](https://img.shields.io/npm/l/lark-agent-acp-bridge.svg)](../LICENSE)

**[English](../README.md)** | **中文**

> 💡 **致谢**：本项目基于 [4t145/lark-acp](https://github.com/4t145/lark-acp) 深度修改与扩展——新增了 Kiro 与 Amazon Q 两个 agent 的原生接入、飞书/Lark 区域（domain）切换、Windows 构建支持及其他修复。感谢 [@4t145](https://github.com/4t145) 打下的优秀基础。

> 💖 觉得本项目有帮助、或者只是看着有点意思？动动发财的小手在右上角点个 ⭐ Star 吧——这是对作者最直接的鼓励。

> ⚠️ **WIP**：仍在迭代中，1.0 之前 CLI 选项与配置字段可能继续调整。

把 [飞书/Lark](https://open.larksuite.com/) 机器人接到任何符合 [ACP（Agent Client Protocol）](https://agentcommunicationprotocol.dev/) 的 AI Agent 上：用户在飞书里发消息，agent 在你的机器上跑，过程和结果都以一张可交互的飞书卡片呈现，工具调用授权、中断、跨进程恢复会话都在卡片里完成。

实际使用强烈建议配合[飞书cli](https://github.com/larksuite/cli)与其skill一起使用，本桥阶层会把会话信息注入上下文，通过飞书cli可以衔接各种飞书操作。

<p align="center">
  <img src="mock-example.png" alt="lark-acp 在飞书里的演示卡片" width="640">
</p>

---

## CLI: `lark-acp`

### 安装与运行

无需 git clone，全局安装即可：

```bash
npm i -g lark-agent-acp-bridge
# 或直接从 GitHub 安装（安装时自动构建）：
npm i -g github:wthislifehuh/lark-agent-acp-bridge
```

装好后 `lark-acp` 命令就在 `$PATH` 上了——本文档所有示例都用它：

```bash
lark-acp proxy --agent claude                  # 飞书应用（open.feishu.cn）
lark-acp proxy --domain lark --agent gemini    # Lark 国际版应用（open.larksuite.com）
```

如果要参与开发，再从源码跑：

```bash
git clone https://github.com/wthislifehuh/lark-agent-acp-bridge
cd lark-agent-acp-bridge
npm install && npm run build       # 或 bun install && bun run build
node dist/bin/lark-acp.js --help
# 可选：npm link → 让裸 `lark-acp` 命令指向本地构建
```

### 命令格式

```
lark-acp [global-options] proxy --agent <preset> [-- <extra-args>...]
lark-acp [global-options] proxy -- <agent-cmd> [agent-args...]
lark-acp agents
lark-acp help
lark-acp version
```

两种启动方式：

- **`--agent <preset>`** —— 使用内置预设，最常用。运行 `lark-acp agents` 查看完整列表。
- **`-- <agent-cmd>`** —— 自定义命令，`--` 后的所有参数原样转发给 agent。

两种方式可以组合：`proxy --agent claude -- --debug` 会在预设末尾追加 `--debug` 再启动。

全局选项必须放在 `proxy` 子命令之前（例外：`--domain` 放在 `proxy` 之后也可以）。

### 内置 agent 预设

| Preset         | 说明                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `claude`       | Claude Code，需先在终端跑过 `claude` 完成登录。                                                                             |
| `claude-agent` | Claude Agent SDK 适配器，需要 `ANTHROPIC_API_KEY`。                                                                         |
| `codex`        | OpenAI Codex 适配器。                                                                                                       |
| `copilot`      | GitHub Copilot CLI。                                                                                                        |
| `gemini`       | Google Gemini CLI（实验性）。个人账号的 Sign in with Google 登录可能已失效，改用 API Key，详见下文「接入 Gemini」。         |
| `opencode`     | OpenCode，需要 `opencode` 已在 `$PATH` 上。                                                                                 |
| `kiro`         | Kiro CLI，需要 `kiro-cli` 已在 `$PATH` 上并完成登录。详见下文「接入 Kiro」。                                                |
| `q`            | Amazon Q Developer CLI，经内置适配器桥接（`q` 无原生 ACP）。需 `q` 在 `$PATH` 上且已 `q login`。详见下文「接入 Amazon Q」。 |
| `mock`         | 内置脚本化 ACP agent（思考 / 工具调用 / 权限许可 / Markdown），用于本地端到端调试。                                         |

不在预设里的 agent，用 raw command：

```bash
lark-acp proxy -- node ./my-acp-server.js --port 9000
```

也可以在配置文件的 `agents` 字段里固化自己的预设（详见下文「配置文件」一节）。

### 接入 Kiro

Kiro CLI（AWS 官方的 Amazon Q Developer CLI 继任者）通过 `kiro-cli acp` **原生支持 ACP**，无需适配器。安装 [Kiro CLI](https://kiro.dev/docs/cli/)、登录一次，然后：

```bash
lark-acp proxy --agent kiro
```

可获得完整体验：按工具粒度的授权卡片、思考/工具时间线，以及桥接层重启后的会话恢复（Kiro 声明了 ACP `loadSession` 能力）。

### 接入 Gemini

Google 于 2026-06-18 停用了 Gemini CLI 面向**个人账号**（Gemini Code Assist for individuals / Google AI Pro / Ultra）的「Sign in with Google」免费 OAuth 登录，改推 [Antigravity](https://antigravity.google)。首次运行 `gemini` 选「1. Sign in with Google」时会报错：

```text
Failed to sign in. This client is no longer supported for Gemini Code Assist
for individuals. To continue using Gemini, please migrate to the Antigravity
suite of products: https://antigravity.google
```

Gemini CLI 本体（Apache-2.0，仍在维护）用一个 **Gemini API Key** 即可继续跑，不必迁移到 Antigravity。由于本项目把 `gemini` 当子进程拉起（`npx -y @google/gemini-cli --experimental-acp`），**推荐把 API Key 写进配置文件**，让子进程非交互鉴权，而不是每次手动登录。

**1. 拿一个 API Key**：打开 [Google AI Studio](https://aistudio.google.com/apikey)，登录后点 **Create API key** 生成（免费额度即可用 Flash 系列，形如 `AIza...`）。

**2. 写进 `agents.gemini.env`**（给内置 `gemini` 预设打补丁）：

```jsonc
{
  "agents": {
    "gemini": {
      // 注入 API Key，桥接子进程即可跳过交互式 OAuth
      "env": { "GEMINI_API_KEY": "AIza..." },
    },
  },
}
```

设了 `GEMINI_API_KEY`，`gemini` 会自动选 API Key 鉴权、不再弹登录框，照常启动即可：

```bash
lark-acp proxy --agent gemini
```

> **首次仍弹登录框？** 少数版本在全新机器上第一次运行仍会显示鉴权菜单。此时先在终端**手动**跑一次 `gemini`，用方向键选 **2. Use Gemini API Key** 并粘贴上面的 Key——这个选择会持久化到 `~/.gemini/settings.json`，之后桥接子进程就不再弹框。

**几点提醒**：

- `GOOGLE_API_KEY` 与 `GEMINI_API_KEY` 等价，两者都设时前者优先。
- 免费额度速率较低（Flash 系列大约每天几百次量级）；注意 **Google One / AI Pro 订阅并不会自动开通 API 付费额度**，遇到 `limit: 0` 的 429 需去 Google Cloud 绑定结算账号。
- 企业 / 团队可改用鉴权菜单里的 **3. Vertex AI**（不受本次停用影响），需设 `GOOGLE_GENAI_USE_VERTEXAI=true` 及 `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`。

### 接入 Amazon Q

Amazon Q Developer CLI（`q`）**没有原生 ACP**——AWS 把这块投入放到了继任者 Kiro CLI 上（Kiro 通过 `kiro-cli acp` 原生支持 ACP，见上面的 `kiro` 预设），并明确表示不会给 `q` 单独实现（[feature request #2703](https://github.com/aws/amazon-q-developer-cli/issues/2703)）。所以本项目自带一个轻量适配器 `lark-acp-q`，把 ACP 翻译成对 `q chat` 的调用，让经典 `q` 也能接进来。

**用法**（先确保 `q` 在 `$PATH` 上并已 `q login`）：

```bash
lark-acp proxy --agent q
```

**工作原理**：每个飞书会话独占一个适配器进程，进程内维护该会话的对话记录。每收到一条消息，适配器把历史记录作为上下文拼进一次全新的 `q chat --no-interactive --trust-all-tools` 调用，把 stdout 去掉 ANSI 后作为 `agent_message_chunk` 流式回传，再把这一轮追加进记录。这样即使多个飞书会话共享同一个 `cwd` 也不会串味（`q` 原生的 `--resume` 是按目录记忆的，多会话会互相污染，故不采用）。对话记录按 sessionId 落盘，桥接层重启后可通过 `session/load` 恢复。

**两点固有限制**（是 `q` 本身的能力边界，不是 bug）：

1. 非交互模式的 `q` 必须预先信任工具（否则会卡住等 TTY 输入），因此 **`q` 这条链路无法把单次工具调用的授权卡片弹给用户**——工具会被自动允许。需要按工具粒度授权，请改用 `kiro` / `claude` 等原生 ACP agent。
2. `q chat` 只输出非结构化文本（没有 JSON 事件流），所以**思考过程与工具调用不会被单独拆分**进卡片时间线，回答以一整段消息流式呈现。

**可选环境变量**（写进配置文件 `agents.q.env`，或直接 export）：

| 变量                      | 默认值                      | 说明                                                                             |
| ------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `Q_ACP_BIN`               | `q`                         | Amazon Q 可执行文件名 / 绝对路径                                                 |
| `Q_ACP_MODEL`             | —                           | 透传给 `q chat --model`                                                          |
| `Q_ACP_AGENT`             | —                           | 透传给 `q chat --agent`（Amazon Q 自定义 agent / profile）                       |
| `Q_ACP_TRUST_TOOLS`       | —（即 `--trust-all-tools`） | 设为逗号分隔列表则改用 `--trust-tools`，只信任这些工具                           |
| `Q_ACP_WRAP`              | `never`                     | 透传给 `q chat --wrap`；设为空字符串则不加该参数                                 |
| `Q_ACP_EXTRA_ARGS`        | —                           | 追加到 `q chat` 的额外参数（按空格切分，不支持引号包裹）                         |
| `Q_ACP_DATA_DIR`          | `~/.lark-acp/q-sessions`    | 对话记录落盘目录                                                                 |
| `Q_ACP_MAX_HISTORY`       | `24`                        | 每次调用最多回放多少条历史消息                                                   |
| `Q_ACP_MAX_HISTORY_CHARS` | `24000`                     | 回放历史的字符预算——整段输入作为单个 argv 传递，需控制在操作系统命令行长度限制内 |

例如指定模型并只信任只读工具：

```jsonc
{
  "agents": {
    "q": {
      "env": {
        "Q_ACP_MODEL": "claude-sonnet-4",
        "Q_ACP_TRUST_TOOLS": "fs_read",
      },
    },
  },
}
```

> **Windows 提示**：Amazon Q CLI 本身不支持原生 Windows——需要 WSL / Linux / macOS。在 Windows 宿主机上，请把整个桥接放进 WSL 里跑（`lark-acp proxy --agent q`），并在 WSL 内安装、登录 `q`。

**没有真实 `q` 也能测试**：仓库的测试套件用一个假 `q` 通过真实 ACP 端到端驱动适配器——运行 `npm test`（先构建，再跑 vitest：适配器核心的单元测试 + `tests/` 下的黑箱 e2e）。

> **想要按工具授权、思考/工具时间线等完整体验？** Kiro CLI 是 Amazon Q 的官方继任者且原生支持 ACP，直接用 `--agent kiro` 即可（见 <https://kiro.dev/docs/cli/acp/>）。

### 全局选项

| 选项                    | 说明                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--cwd <dir>`           | agent 工作目录（默认当前目录）                                                                                     |
| `--config <path>`       | 覆盖配置文件路径                                                                                                   |
| `--data-dir <dir>`      | 覆盖会话存储目录                                                                                                   |
| `--domain <region>`     | 部署区域：`feishu`（默认，`open.feishu.cn`）/ `lark`（国际版 `open.larksuite.com`），也可填自建部署的完整 base URL |
| `--idle-timeout <min>`  | 闲置 N 分钟后释放会话（`0` 表示永不，默认 1440）                                                                   |
| `--max-chats <n>`       | 最大并发会话数（默认 10）                                                                                          |
| `--hide-thoughts`       | 不在卡片里渲染思考过程                                                                                             |
| `--hide-tools`          | 不在卡片里渲染工具调用                                                                                             |
| `--hide-cancel-button`  | 不渲染卡片底部的"中断当前任务"按钮                                                                                 |
| `--permission-mode <m>` | 工具授权策略：`alwaysAsk`（默认，弹卡片让用户选）/ `alwaysAllow`（自动允许）/ `alwaysDeny`（自动拒绝）             |
| `-h`, `--help`          | 显示帮助                                                                                                           |
| `-v`, `--version`       | 显示版本                                                                                                           |

### 会话内指令

在与机器人的对话中直接发送以下消息（群聊中 @机器人 后发送）：

| 指令                                  | 作用                                             |
| ------------------------------------- | ------------------------------------------------ |
| `/cancel` / `/stop` / `取消` / `停止` | 中断当前任务（agent 进程保留，后续消息继续会话） |
| `/new` / `/restart`                   | 重置会话，下一条消息启动全新的 agent 会话        |

### 配置文件

CLI 读取一份配置文件（默认 `~/.config/lark-acp/config.json`），里面包含凭据和运行时默认值。优先级：CLI flag > 环境变量 > 配置文件 > 内置默认。

完整字段（都可选）：

```jsonc
{
  "credentials": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    // 部署区域：feishu（默认）/ lark（国际版），或自建部署的完整 base URL
    "domain": "feishu",
  },
  "dataDir": "./var/lark-acp",
  "runtime": {
    "cwd": "/work/project",
    "idleTimeoutMinutes": 1440,
    "maxChats": 10,
    "hideThoughts": false,
    "hideTools": false,
    "hideCancelButton": false,
    "permissionMode": "alwaysAsk",
  },
  "agents": {
    // 在已有的内置预设上"打补丁"——只需要写要改的字段
    "claude": {
      "env": { "ANTHROPIC_BASE_URL": "https://my-proxy.example.com" },
    },
    // 新增一个用户自己的预设——必须同时给出 label 和 command
    "my-agent": {
      "label": "My ACP Agent",
      "command": "node",
      "args": ["./my-agent.js", "--acp"],
      "description": "本地自研 agent",
      "env": { "FOO": "bar" },
    },
  },
}
```

### 环境变量

| 变量                       | 作用                          |
| -------------------------- | ----------------------------- |
| `LARK_ACP_APP_ID`          | 覆盖 `credentials.appId`      |
| `LARK_ACP_APP_SECRET`      | 覆盖 `credentials.appSecret`  |
| `LARK_ACP_DOMAIN`          | 覆盖 `credentials.domain`     |
| `LARK_ACP_CONFIG`          | 覆盖配置文件路径              |
| `LARK_ACP_DATA_DIR`        | 覆盖会话存储目录              |
| `LARK_ACP_PERMISSION_MODE` | 覆盖 `runtime.permissionMode` |

> **区域（domain）**：SDK 默认连飞书（`open.feishu.cn`）。如果你的应用是在 **Lark 国际版**（`open.larksuite.com`）创建的，必须设为 `lark`（`--domain lark` 或配置 `credentials.domain`），否则握手会被服务端拒绝并报错码 `1000040351`（"Incorrect domain name"）。注意：上游的 `@4t145/lark-acp` npm 包**没有**这个设置——请确认装的是本项目（`lark-agent-acp-bridge`）。

`lark-acp agents` 会列出当前配置下所有可用的预设，并标出来源（`[built-in]` / `[user]` / `[overridden]`）。

> 在飞书开放平台 [开发者后台](https://open.feishu.cn/app)（海外版 [Lark Developer](https://open.larksuite.com/app)）创建一个"自建应用"，从「凭证与基础信息」页拿 `App ID` / `App Secret`；在「事件与回调」里把订阅模式切到 **长连接 (WebSocket)**。具体步骤见下文「飞书开发者后台配置」。

### 飞书开发者后台配置

在 [飞书开放平台](https://open.feishu.cn/app)（海外版 [Lark Developer](https://open.larksuite.com/app)）创建一个"自建应用"后，需要配置三块：**权限**、**事件**、**回调**，然后发布版本。

#### 1. 添加权限

「权限管理 → 批量导入/导出权限 → 导入」，粘贴下面这份 JSON 后保存：

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:update",
      "im:message.reactions:write_only",
      "im:resource",
      "im:chat:readonly",
      "cardkit:card:write",
      "contact:user.base:readonly"
    ],
    "user": []
  }
}
```

每条权限对应的能力：

| 权限                                    | 用途                                               |
| --------------------------------------- | -------------------------------------------------- |
| `im:message` / `im:message:send_as_bot` | 以机器人身份回复用户消息                           |
| `im:message.group_msg`                  | 在群聊中接收消息                                   |
| `im:message.p2p_msg:readonly`           | 在单聊中接收消息                                   |
| `im:message:readonly`                   | 拉取消息上下文（@提及解析、富文本展开）            |
| `im:message:update`                     | 更新交互卡片（流式渲染思考 / 工具调用 / 终态）     |
| `im:message.reactions:write_only`       | 给消息加 / 撤 emoji 反馈，标记任务进度             |
| `im:resource`                           | 下载用户上传的图片 / 文件二进制（按 `message_id`） |
| `im:chat:readonly`                      | 读群信息（注入到 prompt 上下文里：群名、群 id）    |
| `cardkit:card:write`                    | 发送 / 修改 v2 互动卡片                            |
| `contact:user.base:readonly`            | 读用户名（注入到 prompt 上下文里：发送者姓名）     |

#### 2. 添加事件

「事件与回调 → 事件配置」，把**订阅方式**切到 **使用长连接接收事件**（不需要配置回调地址）。然后添加这一个事件，订阅身份选"应用身份"：

| 事件名   | event_type              | 用途                       |
| -------- | ----------------------- | -------------------------- |
| 接收消息 | `im.message.receive_v1` | 用户发的每条消息进入桥接层 |

#### 3. 添加回调

同一页「事件与回调 → 事件配置」下方的"卡片回调"区，添加：

| 回调名       | event_type            | 用途                                        |
| ------------ | --------------------- | ------------------------------------------- |
| 卡片回传交互 | `card.action.trigger` | 用户点击卡片按钮（授权选项 / 中断当前任务） |

#### 4. 发布版本

「版本管理与发布 → 创建版本」，按提示填写资料后提交审核 / 发布。**应用可见范围**根据实际需要选——只有可见范围内的用户才能在飞书里找到这个机器人并对话。

#### 5. 启用

把 `App ID` / `App Secret` 填到 `config.json`（或环境变量 `LARK_ACP_APP_ID` / `LARK_ACP_APP_SECRET`），运行：

```bash
lark-acp proxy --agent claude
```

然后在飞书里搜到这个机器人、单聊或拉到群里直接发消息即可。

### 配置示例

#### 最小配置（仅写一个文件，其它走默认）

```bash
# 1. 准备目录（首次使用时一次性执行）
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp"

# 2. 写入凭据
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp/config.json" <<'EOF'
{
  "credentials": {
    "appId":     "cli_a1b2c3d4e5f60001",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
EOF
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/lark-acp/config.json"

# 3. 启动桥接
lark-acp proxy --agent claude
```

#### 完整配置（凭据 + 运行时默认值）

把常用默认值固化到文件，命令行只剩 `proxy --agent`：

```jsonc
{
  "credentials": {
    "appId": "cli_a1b2c3d4e5f60001",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    // 国际版（open.larksuite.com）应用改成 "lark"
    "domain": "feishu",
  },
  "runtime": {
    "cwd": "/srv/projects/main",
    "idleTimeoutMinutes": 60,
    "maxChats": 20,
    "hideThoughts": true,
  },
}
```

```bash
lark-acp proxy --agent claude
```

CLI flag 会临时覆盖文件里的同名项。

#### systemd 托管

`lark-acp` 是前台进程，由进程管理器托管即可：

```ini
[Service]
Environment=LARK_ACP_APP_ID=cli_a1b2c3d4e5f60001
Environment=LARK_ACP_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ExecStart=/usr/local/bin/lark-acp --cwd /srv/projects/main proxy --agent claude
Restart=on-failure
```

### 快速示例

```bash
# 1. 接 Claude Code（最常用）
#    会话自动持久化，重启不丢上下文。
lark-acp proxy --agent claude

# 2. 接 Kiro CLI（原生 ACP，Amazon Q 的官方继任者）
lark-acp proxy --agent kiro

# 3. 接 OpenCode，工作目录指向具体项目
lark-acp --cwd /work/project proxy --agent opencode

# 4. 接 GitHub Copilot CLI，关掉思考输出
lark-acp --hide-thoughts proxy --agent copilot

# 5. 自研 ACP server
lark-acp proxy -- node ./my-acp-server.js --port 9000
```

## 作为库使用

本包同时导出可编程 API，方便二次开发：

```ts
import { LarkBridge, FileSessionStore } from "lark-agent-acp-bridge";

const bridge = new LarkBridge({
  lark: { appId: "cli_...", appSecret: "...", domain: "lark" },
  agent: {
    command: "kiro-cli",
    args: ["acp"],
    cwd: "/work/project",
    permissionMode: "alwaysAsk",
  },
  session: { idleTimeoutMs: 60 * 60_000, maxConcurrentChats: 20 },
  sessionStore: new FileSessionStore("./var/lark-acp"),
});

await bridge.start();
```

主要导出：`LarkBridge`（编排器）、`LarkCardPresenter` / `LarkPresenter`（可替换的 UI 层）、`FileSessionStore` / `SessionStore`（会话持久化）、`createPinoLogger` / `LarkLogger`（结构化日志）、`LarkHttpClient` 与 domain 工具函数。

## 致谢与类似项目

本项目 fork 自 [4t145/lark-acp](https://github.com/4t145/lark-acp)（其本身由 [JiaqiZhang-Dev/lark-acp](https://github.com/JiaqiZhang-Dev/lark-acp) 重构而来）。相关实现：

1. 本项目的上游原作：<https://github.com/4t145/lark-acp>
2. golang 版本，实现也很齐全：<https://github.com/ri-char/Lark-ACP>
3. 另一个 node 版本：<https://github.com/JiaqiZhang-Dev/lark-acp>

### 本 fork 在原作基础上新增

1. `kiro` 预设（经 `kiro-cli acp` 原生 ACP）与内置的 Amazon Q 适配器 `lark-acp-q`。
2. 飞书/Lark 区域切换（`--domain` / `credentials.domain` / `LARK_ACP_DOMAIN`）——Lark 国际版应用必需。
3. 跨平台（Windows 可用）构建，以及若干修复与文档翻新。

---

## 参考

- ACP 协议：<https://agentcommunicationprotocol.dev/core-concepts/architecture>
- 飞书开放平台：<https://open.larksuite.com/document/server-docs/getting-started/getting-started>

License: MIT
