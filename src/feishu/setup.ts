import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { saveConfig, loadSavedConfig } from "../config.js";
import { FeishuClient } from "./client.js";

// ~/.lark-channel/config.json schema (matches lark-cli's lark-channel-bridge format)
interface LarkChannelConfig {
  accounts: { app: { id: string; secret: string; tenant?: string } };
}

function larkChannelConfigPath(): string {
  return path.join(os.homedir(), ".lark-channel", "config.json");
}

function readLarkChannelConfig(): { appId: string; appSecret: string } | null {
  try {
    const raw = fs.readFileSync(larkChannelConfigPath(), "utf-8");
    const cfg = JSON.parse(raw) as LarkChannelConfig;
    const { id, secret } = cfg.accounts?.app ?? {};
    if (id && secret) return { appId: id, appSecret: secret };
  } catch {
    // not present or malformed
  }
  return null;
}

/**
 * Resolve the lark-cli binary path.
 * Priority: local node_modules/.bin → global PATH
 * @larksuite/cli is a direct dependency so the local binary should always win.
 */
function resolveLarkCliBin(): string {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  // dist/src/feishu/ → project root is 3 levels up
  const projectRoot = path.resolve(__dir, "..", "..", "..");
  const localBin = path.join(projectRoot, "node_modules", ".bin", "lark-cli");
  try {
    execSync(`"${localBin}" --version`, { stdio: "ignore" });
    return localBin;
  } catch {
    // fall back to global
    return "lark-cli";
  }
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

async function runLarkCliSetup(log: (msg: string) => void): Promise<boolean> {
  const bin = resolveLarkCliBin();
  log(`Running: ${bin} config init --new`);
  log("A browser window will open — follow the prompts to create your Feishu app.\n");

  const initOk = await new Promise<boolean>((resolve) => {
    const proc = spawn(bin, ["config", "init", "--new"], { stdio: "inherit", shell: true });
    proc.on("close", (code) => resolve(code === 0));
  });
  return initOk;
}

/**
 * After config init --new, extract the App ID from `lark-cli config show`
 * (lark-cli never exposes the secret in plaintext — we ask the user for it).
 */
async function extractAppIdFromLarkCli(): Promise<string | null> {
  const bin = resolveLarkCliBin();
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn(bin, ["config", "show"], { shell: true, stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      try {
        // lark-cli prints JSON to stdout: { appId: "...", appSecret: "****", ... }
        const json = JSON.parse(out.trim()) as { appId?: string };
        resolve(json.appId ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function printBotLink(appId: string, appSecret: string, log: (msg: string) => void): Promise<void> {
  try {
    const client = new FeishuClient({ appId, appSecret });
    const link = await client.getBotChatLink();
    if (link) {
      log(`\n🤖 Chat with your bot directly:`);
      log(`   ${link}\n`);
    }
  } catch {
    // non-fatal
  }
}

export async function runSetup(
  storageDir: string,
  log: (msg: string) => void = console.log,
): Promise<{ appId: string; appSecret: string }> {
  // 1. Check ~/.lark-channel/config.json first (lark-cli native format)
  const larkChannel = readLarkChannelConfig();
  if (larkChannel) {
    log(`✓ Found existing config in ~/.lark-channel/config.json (App ID: ${larkChannel.appId})`);
    saveConfig(storageDir, { feishu: larkChannel });
    return larkChannel;
  }

  // 2. Check our own saved config
  const saved = loadSavedConfig(storageDir);
  if (saved?.feishu?.appId && saved?.feishu?.appSecret) {
    log(`✓ Found existing config in ~/.feishu-acp/config.json (App ID: ${saved.feishu.appId})`);
    return { appId: saved.feishu.appId, appSecret: saved.feishu.appSecret };
  }

  console.log(`
┌─────────────────────────────────────────┐
│         feishu-acp first-time setup     │
└─────────────────────────────────────────┘
`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // 3. Ask: existing bot or create new?
    console.log(`Do you already have a Feishu self-built app (bot)?`);
    console.log(`  [1] Yes — I have an existing app, let me enter the credentials`);
    console.log(`  [2] No  — Create a new app automatically via lark-cli (recommended)\n`);
    const choice = await prompt(rl, "Choice [1/2]: ");

    if (choice === "1") {
      // ── Existing bot: just ask for App ID + Secret ──────────────────────
      console.log(`\nFind your credentials at https://open.feishu.cn/app → your app → Credentials & Basic Info\n`);
      const appId     = await prompt(rl, "App ID:     ");
      const appSecret = await prompt(rl, "App Secret: ");

      if (!appId || !appSecret) throw new Error("App ID and App Secret are required");

      await saveCreds(storageDir, appId, appSecret);
      log(`\n✓ Config saved!`);
      await printBotLink(appId, appSecret, log);
      return { appId, appSecret };
    }

    // ── Create new bot via lark-cli ──────────────────────────────────────
    const success = await runLarkCliSetup(log);

    if (success) {
      const appId = await extractAppIdFromLarkCli();
      if (appId) {
        log(`\n✓ App created! App ID: ${appId}`);
        log(`\nPaste your App Secret (Feishu Open Platform → your app → Credentials & Basic Info):\n`);
        const appSecret = await prompt(rl, "App Secret: ");
        if (appSecret) {
          await saveCreds(storageDir, appId, appSecret);
          log(`\n✓ Setup complete!`);
          await printBotLink(appId, appSecret, log);
          return { appId, appSecret };
        }
      }
      log("⚠ Could not read App ID from lark-cli — please enter manually.");
    } else {
      log("⚠ lark-cli setup failed — please enter manually.");
    }

    // ── Fallback: manual entry ───────────────────────────────────────────
    console.log(`\nManual setup — make sure your app has:`);
    console.log(`  • Bot capability enabled`);
    console.log(`  • Permissions: im:message, im:message:send_as_bot`);
    console.log(`  • Event subscription: im.message.receive_v1 (long connection)\n`);
    const appId     = await prompt(rl, "App ID:     ");
    const appSecret = await prompt(rl, "App Secret: ");

    if (!appId || !appSecret) throw new Error("App ID and App Secret are required");

    await saveCreds(storageDir, appId, appSecret);
    log(`\n✓ Config saved!`);
    await printBotLink(appId, appSecret, log);
    return { appId, appSecret };
  } finally {
    rl.close();
  }
}

function saveCreds(storageDir: string, appId: string, appSecret: string): void {
  // Write ~/.lark-channel/config.json (lark-cli compatible format)
  const larkChannelDir = path.join(os.homedir(), ".lark-channel");
  fs.mkdirSync(larkChannelDir, { recursive: true });
  fs.writeFileSync(
    path.join(larkChannelDir, "config.json"),
    JSON.stringify({ accounts: { app: { id: appId, secret: appSecret, tenant: "feishu" } } }, null, 2),
    "utf-8",
  );
  // Write ~/.feishu-acp/config.json
  saveConfig(storageDir, { feishu: { appId, appSecret } });
}
