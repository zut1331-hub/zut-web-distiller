/**
 * Optional ZUT Agent Network integration.
 *
 * Nothing in this file ever runs unless the agent or user explicitly
 * calls the connect_zut tool first. It deliberately reuses ZUT's
 * EXISTING admission (Ed25519 challenge-response) and events system
 * rather than inventing a parallel "numeric passport" or new inbox.
 *
 * All endpoint paths and field names below are confirmed against the
 * live zutonline.com API (November 2026).
 *
 * ONE KNOWN LIMITATION: ZUT currently has no token-authenticated
 * REST endpoint for reading direct-message threads. check_zut_inbox
 * reads the generic agent_events queue instead. It returns events
 * such as game_turn, challenge, and system notices - NOT direct
 * messages. Direct messages are only readable through the browser
 * UI at zutonline.com/messages.
 */
import crypto from "node:crypto";
import { loadConfig, saveConfig, type ZutIdentity } from "./config.js";

const ZUT_BASE = "https://zutonline.com/api/public";

// Admission: 3-step Ed25519 challenge-response (confirmed)
const ADMISSION_REQUEST_PATH  = "/agents/admission/request";
const ADMISSION_CHALLENGE_PATH = "/agents/admission/challenge";
const ADMISSION_VERIFY_PATH   = "/agents/admission/verify";

// Runtime events queue (confirmed - NOT a direct-message inbox)
const EVENTS_PATH = "/agents/runtime/events";

// Shared Web Distiller cache (confirmed)
const CACHE_PATH = "/distiller/cache";

// ---------------------------------------------------------------- crypto

function generateKeyPair(): { publicKeyB64: string; privateKeyB64: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    // ZUT expects the raw Ed25519 public key, base64-encoded.
    // exportType "spki" for a public key gives us the DER-encoded SubjectPublicKeyInfo,
    // which starts with an ASN.1 header; we slice the last 32 bytes to get the raw key.
    publicKeyB64: publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64"),
    privateKeyB64: privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
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

// ---------------------------------------------------------------- admission

/**
 * Full 3-step Ed25519 admission handshake.
 * Only called from connect_zut when the user explicitly opts in.
 */
export async function connectToZut(
  displayName: string,
  specialty: string,
): Promise<ZutIdentity> {
  const { publicKeyB64, privateKeyB64 } = generateKeyPair();

  // Step 1: register identity and public key
  const reqRes = await fetch(`${ZUT_BASE}${ADMISSION_REQUEST_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: displayName,
      public_key: publicKeyB64,
      key_algorithm: "ed25519",
      agent_type: "tool",
      capabilities: ["web-distillation"],
      bio: specialty,
    }),
  });
  if (!reqRes.ok) {
    throw new Error(
      `Admission request failed: ${reqRes.status} ${await reqRes.text()}`,
    );
  }
  const { request_id } = (await reqRes.json()) as { request_id: string };

  // Step 2: get the nonce to sign
  const chalRes = await fetch(`${ZUT_BASE}${ADMISSION_CHALLENGE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id }),
  });
  if (!chalRes.ok) {
    throw new Error(
      `Challenge request failed: ${chalRes.status} ${await chalRes.text()}`,
    );
  }
  const { nonce } = (await chalRes.json()) as { nonce: string };

  // Step 3: sign and verify
  const signature = sign(privateKeyB64, nonce);
  const verRes = await fetch(`${ZUT_BASE}${ADMISSION_VERIFY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id, nonce, signature }),
  });
  if (!verRes.ok) {
    throw new Error(
      `Admission verify failed: ${verRes.status} ${await verRes.text()}`,
    );
  }
  const { agent_id, agent_token } = (await verRes.json()) as {
    agent_id: string;
    agent_token: string;
  };

  const identity: ZutIdentity = {
    agentId: agent_id,
    publicKeyB64,
    privateKeyB64,
    token: agent_token,
  };
  const cfg = loadConfig();
  saveConfig({ ...cfg, zutConnected: true, zutIdentity: identity });
  return identity;
}

export function disconnectFromZut(): void {
  saveConfig({ zutConnected: false });
}

// ---------------------------------------------------------------- events

/**
 * Reads the generic agent_events queue via ZUT's existing runtime
 * events endpoint. NOTE: this is NOT a direct-message reader - ZUT
 * has no REST endpoint for that yet. Use zutonline.com/messages in a
 * browser for direct messages.
 */
export async function checkInbox(): Promise<unknown> {
  const cfg = loadConfig();
  if (!cfg.zutConnected || !cfg.zutIdentity) {
    throw new Error("Not connected to ZUT. Call connect_zut first.");
  }
  const res = await fetch(`${ZUT_BASE}${EVENTS_PATH}`, {
    headers: { Authorization: `Bearer ${cfg.zutIdentity.token}` },
  });
  if (!res.ok) {
    throw new Error(`Could not read events: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------- cache

export async function cacheRead(url: string): Promise<unknown | null> {
  const cfg = loadConfig();
  if (!cfg.zutConnected) return null;
  try {
    const res = await fetch(
      `${ZUT_BASE}${CACHE_PATH}?url=${encodeURIComponent(url)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { distilled?: unknown };
    return data.distilled ?? null;
  } catch {
    return null;
  }
}

export async function cacheWrite(
  url: string,
  distilled: unknown,
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.zutConnected || !cfg.zutIdentity) return;
  try {
    await fetch(`${ZUT_BASE}${CACHE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.zutIdentity.token}`,
      },
      body: JSON.stringify({ url, distilled }),
    });
  } catch {
    // A failed cache write must never surface as an error to the agent
  }
}
