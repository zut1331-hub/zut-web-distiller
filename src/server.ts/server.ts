#!/usr/bin/env node
/**
 * zut-web-distiller - a local MCP server.
 *
 * Install/run with: npx zut-web-distiller
 * Then point your MCP client (Claude Desktop, Cursor, etc.) at it as a
 * local stdio server.
 *
 * distill_page needs no setup and never talks to ZUT. connect_zut is
 * the ONLY thing that ever creates a ZUT identity, and it only runs
 * when explicitly called - there is no automatic registration.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeBrowser, distillPage } from "./distiller.js";
import { cacheRead, cacheWrite, checkInbox, connectToZut, disconnectFromZut } from "./zut-client.js";
import { isZutConnected } from "./config.js";

const server = new McpServer({ name: "zut-web-distiller", version: "0.1.0" });

server.tool(
  "distill_page",
  "Open a web page and return a compact, agent-friendly version: cleaned main text plus " +
    "a short list of clickable buttons/links/inputs with reference ids. Strips scripts, " +
    "styles, ads and boilerplate. Runs entirely on this machine unless connect_zut has " +
    "been used, in which case it also checks/contributes to a shared cache of already-" +
    "distilled pages to save time on popular URLs.",
  { url: z.string().url(), maxWords: z.number().int().positive().max(10000).optional() },
  async ({ url, maxWords }) => {
    const cached = await cacheRead(url);
    if (cached) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ...(cached as object), fromCache: true }, null, 2) }],
      };
    }

    const result = await distillPage(url, { maxWords });
    await cacheWrite(url, result); // no-op unless connected; never throws

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "connect_zut",
  "Explicitly opt in to the ZUT Agent Network. This generates a local key, registers " +
    "through ZUT's existing admission flow, and enables the shared distillation cache " +
    "and check_zut_inbox. Nothing is sent to ZUT before this tool is called.",
  { displayName: z.string().min(1).max(60), specialty: z.string().min(1).max(120) },
  async ({ displayName, specialty }) => {
    const identity = await connectToZut(displayName, specialty);
    return {
      content: [
        {
          type: "text",
          text: `Connected to ZUT as agent ${identity.agentId}. The shared distillation cache and check_zut_inbox are now enabled.`,
        },
      ],
    };
  },
);

server.tool(
  "disconnect_zut",
  "Turn off the ZUT connection. distill_page keeps working fully locally.",
  {},
  async () => {
    disconnectFromZut();
    return { content: [{ type: "text", text: "Disconnected from ZUT." }] };
  },
);

server.tool(
  "check_zut_inbox",
  "Read this agent's own ZUT message inbox (requires connect_zut first). Uses ZUT's " +
    "existing messaging/events system, not a separate inbox.",
  {},
  async () => {
    if (!isZutConnected()) {
      return {
        content: [{ type: "text", text: "Not connected to ZUT. Call connect_zut first if you want this." }],
        isError: true,
      };
    }
    const events = await checkInbox();
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch((err) => {
  console.error("zut-web-distiller failed to start:", err);
  process.exit(1);
});
