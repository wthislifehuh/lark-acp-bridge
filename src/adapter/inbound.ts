/**
 * Inbound adapter — convert a Feishu message event into ACP ContentBlock[].
 *
 * Post element structure is based on the Feishu Open Platform docs:
 * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { FeishuMessageEvent, FeishuMention } from "../feishu/types.js";

// ---- Post message element types (matched to Feishu docs) ----

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
  width?: number;
  height?: number;
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

type PostElement = PostElText | PostElA | PostElAt | PostElImg | PostElMedia | PostElEmotion | PostElCodeBlock | PostElHr;

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

// ---- Public API ----

export function feishuMessageToPrompt(event: FeishuMessageEvent): acp.ContentBlock[] {
  const { message } = event;

  switch (message.message_type) {
    case "text":
      return parseText(message.content, message.mentions);
    case "post":
      return parsePost(message.content);
    case "image":
      return parseImage(message.content);
    default:
      return [{ type: "text", text: `[${message.message_type} 消息 — 暂不支持]` }];
  }
}

// ---- Private parsers ----

function parseText(raw: string, mentions?: FeishuMention[]): acp.ContentBlock[] {
  const payload = safeParse<TextPayload>(raw);
  let text = payload?.text ?? "";

  if (mentions) {
    for (const m of mentions) {
      text = text.replace(new RegExp(`@_user_\\d+`, "g"), "").trim();
    }
  }
  text = text.trim();
  if (!text) return [];
  return [{ type: "text", text }];
}

function parsePost(raw: string): acp.ContentBlock[] {
  const payload = safeParse<PostPayload>(raw);
  if (!payload) return [{ type: "text", text: "[富文本消息解析失败]" }];

  const lines: string[] = [];

  if (payload.title) {
    lines.push(`**${payload.title}**`, "");
  }

  const paragraphs = payload.content;
  if (!paragraphs?.length) return [];

  for (const para of paragraphs) {
    if (!para.length) {
      lines.push("");
      continue;
    }

    const first = para[0];
    if (first.tag === "code_block") {
      const code = first as PostElCodeBlock;
      const lang = code.language ?? "";
      lines.push(`\`\`\`${lang}\n${code.text}\n\`\`\``);
      continue;
    }

    if (first.tag === "hr") {
      lines.push("---");
      continue;
    }

    const line = para.map(el => elementToText(el)).filter(Boolean).join("");
    if (line.trim()) lines.push(line);
  }

  if (!lines.length) return [];
  return [{ type: "text", text: lines.join("\n") }];
}

function parseImage(raw: string): acp.ContentBlock[] {
  const payload = safeParse<ImagePayload>(raw);
  const key = payload?.image_key ?? "unknown";
  return [{ type: "text", text: `[用户发送了一张图片: ${key}]` }];
}

// ---- Element renderers ----

function elementToText(el: PostElement): string {
  switch (el.tag) {
    case "text": {
      const s = el as PostElText;
      let t = s.text;
      if (s.style?.length) {
        for (const st of s.style) {
          switch (st) {
            case "bold": t = `**${t}**`; break;
            case "italic": t = `*${t}*`; break;
            case "underline": t = `<u>${t}</u>`; break;
            case "lineThrough": t = `~~${t}~~`; break;
          }
        }
      }
      return t;
    }
    case "a": {
      const s = el as PostElA;
      const label = s.text ?? s.href ?? "";
      return s.href ? `[${label}](${s.href})` : label;
    }
    case "at": {
      const s = el as PostElAt;
      return `@{${s.user_name ?? s.user_id}}`;
    }
    case "img": {
      const s = el as PostElImg;
      return `![图片](${s.image_key})`;
    }
    case "media": {
      const s = el as PostElMedia;
      return `[视频/文件: ${s.file_key ?? s.image_key ?? "unknown"}]`;
    }
    case "emotion": {
      const s = el as PostElEmotion;
      return `:${s.emoji_type}:`;
    }
    case "code_block":
    case "hr":
      return ""; // handled at paragraph level
  }
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
