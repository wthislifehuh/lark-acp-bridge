import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import type { CardActionClicker, CardActionResult } from "../acp/lark-acp-client.js";
import { ToolContext } from "./tool-context.js";
import { registerLarkTools } from "./tools.js";

/** The HTTP member of the ACP `McpServer` union — the only transport we emit. */
type McpServerHttpConfig = Extract<acp.McpServer, { type: "http" }>;

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH_PREFIX = "/mcp/";
const SERVER_NAME = "lark";
const SERVER_VERSION = "0.1.0";

interface ChatEntry {
  readonly token: string;
  readonly ctx: ToolContext;
  /** Lazily created on the first HTTP request for this token. */
  mcp: { server: McpServer; transport: StreamableHTTPServerTransport } | null;
  /** In-flight lazy-connect, so concurrent first requests share one init. */
  connecting: Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> | null;
}

export interface LarkToolServerOptions {
  readonly http: LarkHttpClient;
  readonly logger: LarkLogger;
  /** Auto-fail a blocking interactive tool after this many ms (0 = never). */
  readonly askTimeoutMs: number;
}

/**
 * In-process MCP tool server (design doc `docs/lark-mcp-tool-server.md`).
 *
 * Hosts one loopback-only HTTP listener and a `token → chat` registry. Each
 * chat is injected into its agent's ACP session as a distinct
 * `http://127.0.0.1:<port>/mcp/<token>` endpoint, so a tool call self-routes
 * to its chat with no correlation logic. MCP servers/transports are created
 * lazily on the first request, so a chat whose agent never calls a tool costs
 * nothing beyond a map entry.
 */
export class LarkToolServer {
  private readonly opts: LarkToolServerOptions;
  private readonly logger: LarkLogger;
  private readonly byToken = new Map<string, ChatEntry>();
  private readonly byChat = new Map<string, ChatEntry>();
  private server: http.Server | null = null;
  private port = 0;

  constructor(opts: LarkToolServerOptions) {
    this.opts = opts;
    this.logger = opts.logger.child({ name: "lark-tools" });
  }

  /** Start the loopback HTTP listener. Idempotent. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((err: unknown) => {
        this.logger.warn({ err }, "tool request handler crashed");
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.logger.info({ port: this.port }, "lark tool server listening");
  }

  /** Close all sessions and the HTTP listener. */
  async stop(): Promise<void> {
    for (const chatId of [...this.byChat.keys()]) await this.unregister(chatId);
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  /**
   * Register `chatId` and return the ACP MCP-server config to inject into its
   * session. Call {@link start} first.
   *
   * @throws when the server has not been started.
   */
  register(chatId: string): McpServerHttpConfig {
    if (!this.server) throw new Error("LarkToolServer.register called before start()");
    const existing = this.byChat.get(chatId);
    if (existing) return this.mcpConfig(existing.token);

    const token = crypto.randomUUID();
    const ctx = new ToolContext({
      chatId,
      http: this.opts.http,
      logger: this.logger,
      askTimeoutMs: this.opts.askTimeoutMs,
    });
    const entry: ChatEntry = { token, ctx, mcp: null, connecting: null };
    this.byToken.set(token, entry);
    this.byChat.set(chatId, entry);
    return this.mcpConfig(token);
  }

  /** Tear down a chat's session, failing any pending interactive asks. */
  async unregister(chatId: string): Promise<void> {
    const entry = this.byChat.get(chatId);
    if (!entry) return;
    this.byChat.delete(chatId);
    this.byToken.delete(entry.token);
    entry.ctx.dispose();
    if (entry.mcp) {
      await entry.mcp.transport.close().catch(() => undefined);
      await entry.mcp.server.close().catch(() => undefined);
    }
  }

  /** The {@link ToolContext} for a chat, if registered. */
  contextForChat(chatId: string): ToolContext | undefined {
    return this.byChat.get(chatId)?.ctx;
  }

  /** Route a choice-card click to the chat's context. */
  resolveAsk(
    chatId: string,
    askId: string,
    optionId: string,
    clicker: CardActionClicker,
  ): CardActionResult {
    const ctx = this.byChat.get(chatId)?.ctx;
    if (!ctx) return "orphan";
    return ctx.resolveAsk(askId, optionId, clicker);
  }

  private mcpConfig(token: string): McpServerHttpConfig {
    return {
      type: "http",
      name: SERVER_NAME,
      url: `http://${LOOPBACK_HOST}:${String(this.port)}${MCP_PATH_PREFIX}${token}`,
      headers: [],
    };
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const path = url.split("?")[0] ?? "";
    if (!path.startsWith(MCP_PATH_PREFIX)) {
      res.writeHead(404).end();
      return;
    }
    const token = path.slice(MCP_PATH_PREFIX.length);
    const entry = this.byToken.get(token);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    const { transport } = await this.ensureConnected(entry);
    await transport.handleRequest(req, res);
  }

  private async ensureConnected(
    entry: ChatEntry,
  ): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> {
    if (entry.mcp) return entry.mcp;
    entry.connecting ??= this.connect(entry);
    const mcp = await entry.connecting;
    entry.mcp = mcp;
    entry.connecting = null;
    return mcp;
  }

  private async connect(
    entry: ChatEntry,
  ): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerLarkTools(server, entry.ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return { server, transport };
  }
}
