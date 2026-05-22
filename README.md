# lark-acp

> ⚠️ **WIP**：API 与模块结构仍在迭代中，CLI 入口（`bin/lark-acp.ts`）尚未跟随重构后的库代码同步，目前只能作为一个库 (`src/`) 被嵌入使用。

把 [飞书/Lark](https://open.larksuite.com/) 机器人桥接到任何符合 [ACP（Agent Client Protocol）](https://agentcommunicationprotocol.dev/) 的 AI Agent 子进程上。

桥接层负责：

- 订阅飞书消息与卡片回调，把用户消息转换成 ACP `prompt`；
- 拉起 / 复用 Agent 子进程，处理 ACP 握手、`newSession` / `loadSession` / `unstable_resumeSession`；
- 把 Agent 流式输出（文本、思考、工具调用）合并渲染到一张飞书互动卡片上，并提供"中断"按钮；
- 处理工具调用授权请求 → 飞书卡片按钮 → ACP 回调的整条链路；
- 持久化 chat → sessionId 映射，支持跨进程恢复会话。

---

## 模块结构

```
src/
  bridge/         顶层编排：LarkBridge / ChatRuntime
  acp/            ACP 客户端实现：spawn agent、LarkAcpClient (acp.Client)
  interpreter/    入站方向：飞书消息 → ACP ContentBlock[]
  presenter/      出站方向：ACP 状态 → 飞书互动卡片 / post 富文本
  lark/           飞书 SDK 薄封装：HTTP（lark-http）+ WebSocket（lark-ws）
  session-store/  chat → sessionId 持久化（文件 / Postgres）
  logger/         pino 封装
```

每个子目录的 `index.ts` 仅 re-export 公开 API；子模块内部直接互相引用具体文件，避免 barrel 链。

### 命名约定

- **interpreter** —— 把外部世界（飞书）"翻译"给 Agent 看；
- **presenter** —— 把 Agent 的内部状态"呈现"给外部世界（飞书）；

两者在 `LarkBridge` 内部对称地承担入站/出站职责。

---

## 数据流

```
飞书 WS                     LarkBridge                          Agent (ACP 子进程)
    │                            │                                    │
    │ message_received           │                                    │
    ├───────────────────────────►│                                    │
    │                            │ larkMessageToPrompt()              │
    │                            │ （interpreter，下载图片→base64）    │
    │                            │                                    │
    │                            │ ChatRuntime.enqueue()              │
    │                            │   ├─ 首次：spawnAgent / resume     │
    │                            │   └─ 后续：复用同一 sessionId      │
    │                            │                                    │
    │                            │ connection.prompt(blocks) ────────►│
    │                            │                                    │
    │                            │◄─ sessionUpdate stream ────────────┤
    │                            │   • agent_message_chunk            │
    │                            │   • agent_thought_chunk            │
    │                            │   • tool_call / tool_call_update   │
    │                            │                                    │
    │  patchCard(timeline) ◄─────┤                                    │
    │  （unified card debounce 100ms）                                 │
    │                            │                                    │
    │                            │◄─ requestPermission ───────────────┤
    │  replyCard(permission) ◄───┤                                    │
    │                            │                                    │
    │ card.action.trigger ──────►│                                    │
    │                            │ resolve permission ───────────────►│
    │                            │                                    │
    │                            │◄─ prompt result {stopReason} ──────┤
    │                            │                                    │
    │  patchCard(final) ◄────────┤ finalize(status)                   │
```

---

## Unified Card：一张卡片承载整轮对话

为避免每次 thought / text / tool 切换都新发一张卡片刷屏，桥接层在 `LarkAcpClient` 内部维护一条**结构化时间线**（`TimelineEntry[]`），每次 ACP 流事件追加 / 更新条目，再 debounce 后整体渲染成一张飞书互动卡片：

```ts
type TimelineEntry =
  | { kind: "text";    text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool";    toolCallId; title; toolKind; status; detail? };
```

- 同类型相邻条目会合并（`appendText` 把连续的 chunk 拼到最后一项）；
- 工具条目通过 `toolCallId → index` 索引表 O(1) 查找更新（`tool_call_update` 事件）；
- 渲染时连续条目用 `hr` 分隔，思考用 markdown 引用块（`> `）与正文区分；
- 卡片头部 `STATUS_HEADER` 实时反映 Agent 状态：`thinking` / `calling_tool` / `responding` / `complete` / `cancelled` / `failed`；
- 运行中卡片底部带"中断当前任务"按钮；finalize 时按钮消失、头部变为终态色。

### 渲染时机

`scheduleFlush()` 用 100ms 的 debounce 合并连续事件，避免高频 `patchCard` 触发限流。`flushing` 标志防止首次创建卡片时与 patch 竞态。`finalize(status)` 会等待 in-flight flush 完成，再做最后一次 patch。

---

## 中断 / 取消链路

用户有两种方式中断当前 prompt：

1. **`/cancel`、`取消`、`/stop`、`停止`** 任意命令消息；
2. 点击运行中卡片底部的"中断当前任务"按钮。

两条路径最终都进入 `ChatRuntime.cancel()`：

```
按钮点击 → bridge.handleCardAction
              └─ value.cancel === true → handleCancelButton(chatId)
                                          └─ runtime.cancel()
                                              ├─ client.cancelPendingPermission()
                                              ├─ connection.cancel({ sessionId })
                                              └─ queue.length = 0
```

Agent 收到 cancel 后 `prompt()` 以 `stopReason: "cancelled"` 返回，`finalize("cancelled")` 把卡片头改成 "⛔ 已取消"。Agent 子进程**不会**被杀掉——下次消息直接复用同一 session。

`shutdown()` 才会真正杀掉子进程，用在 `/new` / `/restart` 命令、空闲超时、或 Agent 认证失败 / 已死等场景。

---

## 工具调用授权流程

```
agent.requestPermission(params)
        │
        ▼
LarkAcpClient.requestPermission
  ├─ requestId = uuid()
  ├─ pendingPermissions.set(requestId, { resolve, timer, cardMessageId })
  ├─ 起 permissionTimeoutMs 超时（默认 5 分钟）
  └─ presenter.sendInterruptCard()  → 飞书互动卡片
                                       payload: { r: requestId, o: optionId, c: chatId, ... }

用户点击按钮 → 飞书 card.action.trigger
        │
        ▼
LarkBridge.handleCardAction
  └─ runtime.handleCardAction(requestId, optionId)
       └─ pp.resolve({ outcome: "selected", optionId })  → ACP agent

超时 / 会话结束 / sendInterruptCard 失败：
  └─ pp.resolve({ outcome: "cancelled" })，原卡片 patch 成"已失效"
```

`sendInterruptCard` 失败时**默认 cancel 而非 allow**，避免静默放行。

---

## 多会话并发与生命周期

`LarkBridge` 持有 `Map<chatId, ChatRuntime>`：

- **懒创建**：首条消息触发 `acquireRuntime`，调用 `spawnAgent` 或 `spawnAndResumeAgent`；
- **FIFO 串行**：单个 chat 内消息按到达顺序排队，避免同一 session 上并发 prompt；
- **空闲驱逐**：默认 24h 不活跃即 `shutdown()`，回收子进程；
- **总数上限**：默认 10 个并发 chat，达到上限时驱逐 lastActivity 最久的；
- **跨进程恢复**：`SessionStore` 持久化 `chatId → sessionId`，进程重启后下次消息会优先 `unstable_resumeSession` / `loadSession`；都不行才 `newSession`。

---

## 配置项

```ts
new LarkBridge({
  feishu: { appId, appSecret },

  agent: {
    command: "claude",
    args: ["--acp"],
    cwd: "/path/to/project",
    env: { ... },
    showThoughts: true,        // 是否在卡片中渲染 agent_thought_chunk
    showTools: true,           // 是否渲染 tool_call / tool_call_update
    showCancelButton: true,    // 是否渲染卡片底部"中断当前任务"按钮
    permissionTimeoutMs: 300_000,  // 授权卡片自动 cancel 超时
  },

  session: {
    idleTimeoutMs: 24 * 3600_000,  // 0 = never
    maxConcurrentChats: 10,
  },

  sessionStore: new FileSessionStore({ path: "./sessions.json" }),
  // 或 new PostgresSessionStore({ ... })
});
```

---

## 飞书消息 → ACP ContentBlock

`interpreter/lark-interpreter.ts` 处理飞书消息的所有类型：

| 飞书消息类型 | 转换结果 |
| --- | --- |
| `text` | `{ type: "text", text }`；`@mention` 会替换成名字 |
| `image` | 通过 SDK `im.messageResource.get` 下载，base64 内嵌为 `{ type: "image", data, mimeType }` |
| `post` | 富文本展平：内联 `<img>` 切分段落，文本/链接/at 拼回纯文本 |
| `file` / `audio` / `media` | 描述性文本占位（不下载） |
| `sticker` / `share_chat` / `share_user` / `location` / `merge_forward` | 描述性文本占位 |
| 图片下载失败 | 退化为文本 `[图片下载失败: <key>]` |

每条消息前会被注入一段上下文文本：

```
[上下文: 群聊 "项目协作群" (oc_xxx) 中用户 张三 (ou_xxx) 的消息]
```

---

## Agent 输出 → 飞书 post 富文本

仅用于系统通知（取消提示、Agent 错误）的 `replyText` 走 `presenter/lark-markdown.ts`：

- `marked@18` 解析 markdown AST；
- 标题 → 加粗段落；段落 → 内联文本/链接/样式；
- 代码块 → `code_block`（语言走白名单 + 别名映射，非白名单语言 fallback 无 language）；
- 列表 / 引用 → 飞书 `md` 标签（飞书 post 中唯一原生支持列表/引用的元素）；
- 表格 → 列宽对齐的 `code_block`（`md` 标签不支持表格）；
- 长消息按 `\n\`\`\`\n` / `\n\n` / `\n` 边界拆分到 `MAX_MARKDOWN_CHUNK = 4000` 以下；
- 行内代码 → 用反引号包裹的纯文本（post 没有 inline-code 元素）；
- 图片 → 退化为可点击链接（post 的 `img` 需要 `image_key`，agent 发的 URL 没法直接用）。

Agent 的主输出**不**走 `replyText`——它进入 unified card 的时间线，由 `presenter/lark-presenter.ts` 渲染成卡片的 `markdown` 元素。

---

## TypeScript 工程约定

完整规范见 [`CLAUDE.md`](./CLAUDE.md)。要点：

- 默认抛异常 + JSDoc `@throws`，仅在解析 / 校验等"失败是预期分支"的边界用 Result 风格；
- 禁 `any` / 不安全 `as` / `!`；解析外部数据走 schema 校验；
- 默认 `type` 而非 `interface`（仅 declaration merging 用 interface）；
- 默认不写注释，仅在 *why* 非显然时简短说明；
- discriminated union + 穷尽 `switch` 替代散落的 `if/else if`；
- ESM + NodeNext，import 路径写 `.js` 后缀。

`tsconfig.json` 启用：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`noFallthroughCasesInSwitch`。

---

## 当前进度（WIP）

- ✅ Bridge / interpreter / presenter / acp / session-store 重构完成，类型检查干净；
- ✅ Unified card：思考 / 文本 / 工具调用合并渲染、状态头、中断按钮；
- ✅ `showThoughts` / `showTools` / `showCancelButton` 配置开关；
- ✅ 取消链路双通道（命令 + 按钮）；
- ✅ 飞书图片消息真实下载并 base64 内嵌；
- ✅ markdown → 飞书 post 走 `marked` AST 而非正则；
- ⏳ `bin/lark-acp.ts` CLI 入口未跟随重构同步，目前不可直接运行；
- ⏳ 测试：尚无 unit / integration test（计划用 vitest + testcontainers）；
- ⏳ Postgres session store 未实测；
- ⏳ 文档：API doc 注释完整度参差，待补齐。

参考：

- ACP 协议：https://agentcommunicationprotocol.dev/core-concepts/architecture
- 飞书开放平台：https://open.larksuite.com/document/server-docs/getting-started/getting-started

License: MIT
