/**
 * Local configuration for zut-web-distiller.
 *
 * Everything in this file lives ONLY on the user's own machine, in
 * their home directory. Nothing here is read or written automatically
 * on startup beyond checking whether the user has already opted in -
 * generating a key and contacting ZUT happens ONLY when the agent (or
 * the user) explicitly calls the connect_zut tool. There is no
 * "silent handshake": distill_page works fully offline-from-ZUT until
 * someone deliberately asks to connect.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".zut-web-distiller");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface ZutIdentity {
  agentId: string;
  publicKeyB64: string;
  privateKeyB64: string; // local only - never sent anywhere
  token: string;
}

export interface LocalConfig {
  zutConnected: boolean;
  zutIdentity?: ZutIdentity;
}

function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): LocalConfig {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { zutConnected: false };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { zutConnected: false };
  }
}

export function saveConfig(cfg: LocalConfig): void {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function isZutConnected(): boolean {
  return loadConfig().zutConnected === true;
}
