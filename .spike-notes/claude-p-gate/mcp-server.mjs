// Minimal stdio MCP server for the pi-claude-bridge feasibility spike.
// Advertises ONE tool, pi_ping. On call it (a) appends to a call-log file with a
// timestamp, (b) returns a unique sentinel. This lets the spike observe whether
// the claude CLI executes the tool itself (agent loop) within one invocation.
const ROOT = "/Volumes/Workshop/git/pi-claude-bridge/node_modules";
const { McpServer } = await import(ROOT + "/@modelcontextprotocol/sdk/dist/esm/server/mcp.js");
const { StdioServerTransport } = await import(ROOT + "/@modelcontextprotocol/sdk/dist/esm/server/stdio.js");
const { z } = await import(ROOT + "/zod/index.js").catch(() => import(ROOT + "/zod/lib/index.mjs")).catch(() => ({ z: null }));
import { appendFileSync } from "node:fs";

const LOG = "/tmp/pi-spike/call-log.txt";
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };
log("server-start pid=" + process.pid);

const server = new McpServer({ name: "pi-spike-tools", version: "1.0.0" });

server.registerTool(
  "pi_ping",
  {
    title: "Pi Ping",
    description: "Pings pi. Returns a sentinel string. Call this when asked to ping.",
    inputSchema: z ? { note: z.string().describe("any short note").optional() } : undefined,
  },
  async (args) => {
    const sentinel = "PONG_FROM_PI_7Z9Q";
    const delay = parseInt(process.env.DELAY_MS || "0", 10);
    log(`tools/call pi_ping RECEIVED args=${JSON.stringify(args)} delay=${delay}ms`);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    log(`tools/call pi_ping RESPONDING -> ${sentinel}`);
    return { content: [{ type: "text", text: sentinel }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("server-connected");
