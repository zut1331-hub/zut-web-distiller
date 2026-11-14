/**
 * Optional ZUT Agent Network integration.
 *
 * Nothing in this file ever runs unless the agent or user explicitly
 * calls the connect_zut tool first. It deliberately reuses ZUT's
 * EXISTING admission (Ed25519 challenge-response) and messaging
 * system rather than inventing a parallel "numeric passport" or
 * "internal inbox" - those already exist on ZUT.
 *
 * IMPORTANT: the exact endpoint paths and field names below are
 * PLACEHOLDERS copied from this project's earlier /protocol and
 * /admission design. Confirm each one against the live
 * https://zutonline.com/protocol and https://zutonline.com/admission
 * pages (or GET /api/public/agents/runtime/tool) before relying on
 * this in production, and update the three marked constants below.
 */
import crypto from "node:crypto";
import { loadConfig, saveConfig, type ZutIdentity } from "./config.js";

const ZUT_BASE = "https://zutonline.com/api/public";

// --- TODO: confirm these three against the live admission protocol ---
const ADMISSION_REQUEST_PATH = "/agents/admission/request"; // PLACEHOLDER
const ADMISSION_VERIFY_PATH = "/agents/admission/verify"; // PLACEHOLDER
const MESSAGE_EVENTS_PATH = "/agents/runtime/events"; // PLACEHOLDER (existing events/inbox read)
// -----------------------------------------------------------------

function generateKeyPair(): { publicKeyB64: string; privateKeyB64: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyB64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

function sign(privateKeyB64: string, message: string): string {
  const keyObj = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, Buffer.from(message), keyObj).toString("base64");
}

/**
 * Runs ZUT's existing verified-admission handshake. Only called from
 * the connect_zut tool, which itself is only called when the user/agent
 * explicitly asks to connect - never automatically.
 */
export async function connectToZut(displayName: string, specialty: string): Promise<ZutIdentity> {
  const { publicKeyB64, privateKeyB64 } = generateKeyPair();

  const reqRes = await fetch(`${ZUT_BASE}${ADMISSION_REQUEST_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: displayName,
      type: "tool",
      capabilities: ["web-distillation"],
      bio: specialty,
      public_key: publicKeyB64,
    }),
  });
  if (!reqRes.ok) {
    throw new Error(`Admission request failed: ${reqRes.status} ${await reqRes.text()}`);
  }
  const { nonce } = (await reqRes.json()) as { nonce: string };

  const signature = sign(privateKeyB64, nonce);
  const verifyRes = await fetch(`${ZUT_BASE}${ADMISSION_VERIFY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_key: publicKeyB64, nonce, signature }),
  });
  if (!verifyRes.ok) {
    throw new Error(`Admission verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  }
  const { agent_id, token } = (await verifyRes.json()) as { agent_id: string; token: string };

  const identity: ZutIdentity = { agentId: agent_id, publicKeyB64, privateKeyB64, token };
  const cfg = loadConfig();
  saveConfig({ ...cfg, zutConnected: true, zutIdentity: identity });
  return identity;
}

export function disconnectFromZut(): void {
  saveConfig({ zutConnected: false });
}

/** Reads this agent's own message inbox via ZUT's existing events/heartbeat
 * mechanism - NOT a new "internal inbox". */
export async function checkInbox(): Promise<unknown> {
  const cfg = loadConfig();
  if (!cfg.zutConnected || !cfg.zutIdentity) {
    throw new Error("Not connected to ZUT. Call connect_zut first.");
  }
  const res = await fetch(`${ZUT_BASE}${MESSAGE_EVENTS_PATH}`, {
    headers: { Authorization: `Bearer ${cfg.zutIdentity.token}` },
  });
  if (!res.ok) {
    throw new Error(`Could not read events: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// --- Shared distillation cache (TODO: confirm paths once Lovable builds them) ---
const CACHE_READ_PATH = "/distiller/cache"; // PLACEHOLDER - GET ?url=
const CACHE_WRITE_PATH = "/distiller/cache"; // PLACEHOLDER - POST

export async function cacheRead(url: string): Promise<unknown | null> {
  const cfg = loadConfig();
  if (!cfg.zutConnected) return null; // caching is part of the opt-in, not forced
  try {
    const res = await fetch(`${ZUT_BASE}${CACHE_READ_PATH}?url=${encodeURIComponent(url)}`);
    if (res.status === 404) return null;
    if (!res.ok) return null; // cache being unreachable must never break distillation
    return await res.json();
  } catch {
    return null;
  }
}

export async function cacheWrite(url: string, distilled: unknown): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.zutConnected) return;
  try {
    await fetch(`${ZUT_BASE}${CACHE_WRITE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, distilled }),
    });
  } catch {
    // sharing a cache entry is a courtesy, never a requirement - a failed
    // write must never surface as an error to the agent
  }
}
