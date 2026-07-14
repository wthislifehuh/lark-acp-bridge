/**
 * Lark message interpreter — translate a Lark message event into
 * the ACP `ContentBlock[]` shape an agent expects as its prompt.
 *
 * Content shapes are based on the Lark Open Platform docs:
 * https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content
 */

import type * as acp from "@agentclientprotocol/sdk";
import type * as Lark from "@larksuiteoapi/node-sdk";

type LarkRawMention = NonNullable<Lark.RawMessageEvent["message"]["mentions"]>[number];

// ---- Post message element types (matched to Lark docs) ----

interface PostElText {
  tag: "text";
  text: string;
  un_escape?: boolean;
  style?: ("bold" | "underline" | "lineThrough" | "italic")[];
}

interface PostElA {
  tag: "a";
  text?: string;
  href?: string;
  style?: string[];
}

interface PostElAt {
  tag: "at";
  user_id: string;
  user_name?: string;
  style?: string[];
}

interface PostElImg {
  tag: "img";
  image_key: string;
}

interface PostElMedia {
  tag: "media";
  file_key?: string;
  image_key?: string;
}

interface PostElEmotion {
  tag: "emotion";
  emoji_type: string;
}

interface PostElCodeBlock {
  tag: "code_block";
  language?: string;
  text: string;
}

interface PostElHr {
  tag: "hr";
}

type PostElement =
  | PostElText
  | PostElA
  | PostElAt
  | PostElImg
  | PostElMedia
  | PostElEmotion
  | PostElCodeBlock
  | PostElHr;

type PostParagraph = PostElement[];

interface PostPayload {
  title?: string;
  content?: PostParagraph[];
}

interface TextPayload {
  text?: string;
}

interface ImagePayload {
  image_key?: string;
}

interface FilePayload {
  file_key?: string;
  file_name?: string;
}

interface AudioPayload {
  file_key?: string;
  duration?: number;
}

interface MediaPayload {
  file_key?: string;
  image_key?: string;
  file_name?: string;
  duration?: number;
}

interface StickerPayload {
  file_key?: string;
}

interface ShareChatPayload {
  chat_id?: string;
}

interface ShareUserPayload {
  user_id?: string;
}

interface LocationPayload {
  name?: string;
  longitude?: string;
  latitude?: string;
}

// ---- Public API ----

/**
 * Target of an `/invite` / `/remove` access command.
 *
 * `openIds` are the non-bot mention targets carried by the message; the
 * interpreter surfaces them from `message.mentions` so the bridge doesn't
 * have to re-parse the raw event.
 */
export type AccessCommandTarget =
  | { readonly type: "user"; readonly openIds: readonly string[] }
  | { readonly type: "admin"; readonly openIds: readonly string[] }
  | { readonly type: "group" };

/**
 * High-level commands a user can issue via plain-text messages.
 *
 * Detection is intentionally strict: session commands (`cancel` / `new`)
 * only match exact, whitespace-trimmed text; access commands match a
 * leading `/invite` `/remove` `/access` `/mention` token. Anything else
 * falls through to {@link InterpretedMessage} `kind: "prompt"`.
 */
export type LarkCommand =
  | { readonly kind: "cancel" }
  | { readonly kind: "new" }
  | { readonly kind: "help" }
  | { readonly kind: "status" }
  | { readonly kind: "config" }
  | { readonly kind: "access-show" }
  | { readonly kind: "access-usage"; readonly usage: string }
  | { readonly kind: "mention-toggle"; readonly enabled: boolean }
  | { readonly kind: "invite"; readonly target: AccessCommandTarget }
  | { readonly kind: "remove"; readonly target: AccessCommandTarget };

/**
 * Outcome of interpreting a Lark inbound message.
 *
 * - `empty`: no actionable content (e.g. a stripped-to-nothing self-mention).
 * - `command`: a recognised slash-style command — bridge should act on it
 *   directly without sending anything to the agent.
 * - `prompt`: ACP content blocks ready to forward to the agent.
 */
export type InterpretedMessage =
  | { readonly kind: "empty" }
  | { readonly kind: "command"; readonly command: LarkCommand }
  | { readonly kind: "prompt"; readonly blocks: acp.ContentBlock[] };

export interface InterpretOptions {
  /**
   * Bot's own `open_id`, used to recognise and drop self-mentions in text
   * messages. When omitted, all mentions are rendered as `@{name}`.
   */
  readonly botOpenId?: string;
}

const CANCEL_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/cancel", "/stop", "取消", "停止"]);
const NEW_SESSION_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/new", "/restart"]);
const HELP_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/help", "帮助"]);
const STATUS_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/status", "状态"]);
const CONFIG_COMMAND_TOKENS: ReadonlySet<string> = new Set(["/config", "配置"]);

/**
 * Interpret a Lark inbound message event.
 *
 * Text messages (and only text messages) are eligible to be classified as
 * commands. Every other message type becomes a `prompt` (or `empty`).
 *
 * No binary attachments are downloaded — images, files, audio, video and
 * stickers are all rendered as descriptive text placeholders carrying
 * `message_id` / `image_key` / `file_key` so the agent can fetch them
 * out-of-band (e.g. through a future Lark MCP tool) if it needs to.
 */
export function interpretLarkMessage(
  event: Lark.RawMessageEvent,
  opts: InterpretOptions = {},
): InterpretedMessage {
  const { message } = event;

  if (message.message_type === "text") {
    const text = extractTextContent(message.content, message.mentions, opts.botOpenId);
    if (!text) return { kind: "empty" };
    const command = detectCommand(text, message.mentions, opts.botOpenId);
    if (command) return { kind: "command", command };
    return { kind: "prompt", blocks: [{ type: "text", text }] };
  }

  return blocksToPrompt(parseNonTextMessage(message));
}

function parseNonTextMessage(message: Lark.RawMessageEvent["message"]): acp.ContentBlock[] {
  switch (message.message_type) {
    case "post":
      return parsePost(message.content, message.message_id);
    case "image":
      return parseImage(message.content, message.message_id);
    case "file":
      return parseFile(message.content);
    case "audio":
      return parseAudio(message.content);
    case "media":
      return parseMedia(message.content);
    case "sticker":
      return parseSticker(message.content);
    case "share_chat":
      return parseShareChat(message.content);
    case "share_user":
      return parseShareUser(message.content);
    case "location":
      return parseLocation(message.content);
    case "merge_forward":
      return [{ type: "text", text: "[合并转发消息 — 请通过工具调用获取子消息]" }];
    default:
      return [{ type: "text", text: `[${message.message_type} 消息 — 暂不支持]` }];
  }
}

function blocksToPrompt(blocks: acp.ContentBlock[]): InterpretedMessage {
  return blocks.length ? { kind: "prompt", blocks } : { kind: "empty" };
}

const INVITE_USAGE =
  "用法: /invite user @用户... | /invite admin @用户... | /invite group（当前群）";
const REMOVE_USAGE =
  "用法: /remove user @用户... | /remove admin @用户... | /remove group（当前群）";
const MENTION_USAGE = "用法: /mention on | /mention off";

function detectCommand(
  text: string,
  mentions: LarkRawMention[] | undefined,
  botOpenId: string | undefined,
): LarkCommand | null {
  if (CANCEL_COMMAND_TOKENS.has(text)) return { kind: "cancel" };
  if (NEW_SESSION_COMMAND_TOKENS.has(text)) return { kind: "new" };
  if (HELP_COMMAND_TOKENS.has(text)) return { kind: "help" };
  if (STATUS_COMMAND_TOKENS.has(text)) return { kind: "status" };
  if (CONFIG_COMMAND_TOKENS.has(text)) return { kind: "config" };

  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0]?.toLowerCase();
  if (!head?.startsWith("/")) return null;

  switch (head) {
    case "/access":
      return { kind: "access-show" };
    case "/mention": {
      const arg = tokens[1]?.toLowerCase();
      if (arg === "on") return { kind: "mention-toggle", enabled: true };
      if (arg === "off") return { kind: "mention-toggle", enabled: false };
      return { kind: "access-usage", usage: MENTION_USAGE };
    }
    case "/invite":
    case "/remove": {
      const target = parseAccessTarget(tokens[1]?.toLowerCase(), mentions, botOpenId);
      if (!target) {
        return { kind: "access-usage", usage: head === "/invite" ? INVITE_USAGE : REMOVE_USAGE };
      }
      return head === "/invite" ? { kind: "invite", target } : { kind: "remove", target };
    }
    default:
      return null;
  }
}

/** Build an {@link AccessCommandTarget} from a subcommand token + message mentions. */
function parseAccessTarget(
  sub: string | undefined,
  mentions: LarkRawMention[] | undefined,
  botOpenId: string | undefined,
): AccessCommandTarget | null {
  if (sub === "group") return { type: "group" };
  if (sub !== "user" && sub !== "admin") return null;
  const openIds = collectMentionTargets(mentions, botOpenId);
  if (openIds.length === 0) return null;
  return { type: sub, openIds };
}

/** Non-bot mention `open_id`s, de-duplicated, in first-seen order. */
function collectMentionTargets(
  mentions: LarkRawMention[] | undefined,
  botOpenId: string | undefined,
): readonly string[] {
  if (!mentions) return [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const openId = m.id.open_id;
    if (!openId || openId === botOpenId) continue;
    seen.add(openId);
  }
  return [...seen];
}

// ---- Private parsers ----

/**
 * Decode a Lark text-message payload into a plain string with mentions
 * inlined. The bot's own self-mention is stripped entirely (it's routing
 * metadata, not user content); other users' mentions become `@{name}`.
 */
function extractTextContent(
  raw: string,
  mentions: LarkRawMention[] | undefined,
  botOpenId: string | undefined,
): string {
  const payload = safeParse<TextPayload>(raw);
  let text = payload?.text ?? "";

  if (mentions) {
    for (const m of mentions) {
      const key = m.key;
      if (!key) continue;
      const isSelf = botOpenId !== undefined && m.id.open_id === botOpenId;
      const replacement = isSelf ? "" : `@{${m.name ?? m.id.open_id ?? key}}`;
      text = text.replaceAll(key, replacement);
    }
  }
  return text.trim();
}

function parsePost(raw: string, messageId: string): acp.ContentBlock[] {
  const payload = safeParse<PostPayload>(raw);
  if (!payload) return [{ type: "text", text: "[富文本消息解析失败]" }];

  const lineBuffer: string[] = [];

  if (payload.title) {
    lineBuffer.push(`**${payload.title}**`, "");
  }

  const paragraphs = payload.content;
  if (!paragraphs?.length) {
    const text = lineBuffer.join("\n").trim();
    return text ? [{ type: "text", text }] : [];
  }

  for (const para of paragraphs) {
    if (!para.length) {
      lineBuffer.push("");
      continue;
    }

    const first = para[0];
    if (first?.tag === "code_block") {
      const lang = first.language ?? "";
      lineBuffer.push(`\`\`\`${lang}\n${first.text}\n\`\`\``);
      continue;
    }
    if (first?.tag === "hr") {
      lineBuffer.push("---");
      continue;
    }

    const lineParts: string[] = [];
    for (const el of para) {
      if (el.tag === "img") {
        lineParts.push(imagePlaceholder(messageId, el.image_key));
        continue;
      }
      const rendered = elementToText(el);
      if (rendered) lineParts.push(rendered);
    }
    if (lineParts.length) lineBuffer.push(lineParts.join(""));
  }

  const text = lineBuffer.join("\n").trim();
  return text ? [{ type: "text", text }] : [];
}

function parseImage(raw: string, messageId: string): acp.ContentBlock[] {
  const payload = safeParse<ImagePayload>(raw);
  const key = payload?.image_key;
  if (!key) return [{ type: "text", text: "[图片消息缺少 image_key]" }];
  return [{ type: "text", text: imagePlaceholder(messageId, key) }];
}

function imagePlaceholder(messageId: string, imageKey: string): string {
  return `[图片 (message_id=${messageId}, image_key=${imageKey})]`;
}

function parseFile(raw: string): acp.ContentBlock[] {
  const p = safeParse<FilePayload>(raw);
  const name = p?.file_name ?? "未命名";
  const key = p?.file_key ?? "unknown";
  return [{ type: "text", text: `[文件: ${name} (file_key=${key})]` }];
}

function parseAudio(raw: string): acp.ContentBlock[] {
  const p = safeParse<AudioPayload>(raw);
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key ?? "unknown";
  return [{ type: "text", text: `[音频: ${dur} (file_key=${key})]` }];
}

function parseMedia(raw: string): acp.ContentBlock[] {
  const p = safeParse<MediaPayload>(raw);
  const name = p?.file_name ?? "未命名";
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key ?? "unknown";
  return [{ type: "text", text: `[视频: ${name} ${dur} (file_key=${key})]` }];
}

function parseSticker(raw: string): acp.ContentBlock[] {
  const p = safeParse<StickerPayload>(raw);
  const key = p?.file_key ?? "unknown";
  return [{ type: "text", text: `[表情包 (file_key=${key})]` }];
}

function parseShareChat(raw: string): acp.ContentBlock[] {
  const p = safeParse<ShareChatPayload>(raw);
  const id = p?.chat_id ?? "unknown";
  return [{ type: "text", text: `[群名片: chat_id=${id}]` }];
}

function parseShareUser(raw: string): acp.ContentBlock[] {
  const p = safeParse<ShareUserPayload>(raw);
  const id = p?.user_id ?? "unknown";
  return [{ type: "text", text: `[个人名片: user_id=${id}]` }];
}

function parseLocation(raw: string): acp.ContentBlock[] {
  const p = safeParse<LocationPayload>(raw);
  const name = p?.name ?? "未命名地点";
  const lat = p?.latitude ?? "?";
  const lon = p?.longitude ?? "?";
  return [{ type: "text", text: `[位置: ${name} (${lat}, ${lon})]` }];
}

// ---- Element renderers ----

function elementToText(el: PostElement): string {
  switch (el.tag) {
    case "text": {
      let t = el.text;
      if (el.style?.length) {
        for (const st of el.style) {
          switch (st) {
            case "bold":
              t = `**${t}**`;
              break;
            case "italic":
              t = `*${t}*`;
              break;
            case "underline":
              t = `<u>${t}</u>`;
              break;
            case "lineThrough":
              t = `~~${t}~~`;
              break;
          }
        }
      }
      return t;
    }
    case "a": {
      const label = el.text ?? el.href ?? "";
      return el.href ? `[${label}](${el.href})` : label;
    }
    case "at":
      return `@{${el.user_name ?? el.user_id}}`;
    case "media":
      return `[视频/文件: ${el.file_key ?? el.image_key ?? "unknown"}]`;
    case "emotion":
      return `:${el.emoji_type}:`;
    case "img":
    case "code_block":
    case "hr":
      return ""; // handled at paragraph / block level
  }
}

// ---- Helpers ----

// Deliberate cast-without-validation helper: payload shapes follow Lark's
// documented message formats and every downstream field access is defensive
// (`?.` / `??`), so a zod schema per message type would only duplicate that.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
