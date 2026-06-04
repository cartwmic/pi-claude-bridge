// mcp-readiness-server.mjs — instrumented stdio MCP server for the MCP-attach-race proof.
//
// Mirrors the production shim's wiring (low-level Server + StdioServerTransport,
// exactly src/mcp/shim.ts) so we can TIMESTAMP the moment `claude` completes its
// tools/list handshake — i.e. the instant the bridged tool roster becomes
// available to the model. The high-level McpServer hides tools/list; the
// low-level Server lets us log it.
//
// One server is spawned per `claude` process (claude is the MCP CLIENT). It logs
// absolute Date.now() for every protocol milestone to a per-spawn JSONL file
// (--log <path>). Same system clock as the harness → directly comparable to the
// claude-p "Enter sent" timestamp.
import { appendFileSync } from "node:fs";

const ROOT = "/Volumes/Workshop/git/pi-claude-bridge/node_modules";
const { Server } = await import(ROOT + "/@modelcontextprotocol/sdk/dist/esm/server/index.js");
const { StdioServerTransport } = await import(ROOT + "/@modelcontextprotocol/sdk/dist/esm/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(ROOT + "/@modelcontextprotocol/sdk/dist/esm/types.js");

const logPath = (() => {
  const i = process.argv.indexOf("--log");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "/tmp/pi-spike-rca/default.mcp.log";
})();
const log = (event, extra = {}) => {
  try { appendFileSync(logPath, JSON.stringify({ t: Date.now(), iso: new Date().toISOString(), event, ...extra }) + "\n"); } catch {}
};

log("server-start", { pid: process.pid });

const server = new Server({ name: "pi-spike-tools", version: "1.0.0" }, { capabilities: { tools: {} } });

const startupDelayMs = (() => {
  const i = process.argv.indexOf("--startup-delay-ms");
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : 0;
})();

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // tools/list RECEIVED → claude has connected + initialized and is fetching the
  // roster. tools/list RESPONDING → the tools are about to enter the model's roster.
  // --startup-delay-ms HOLDS the response, deterministically pushing the roster's
  // availability PAST the prompt-Enter point (race lost by construction).
  log("tools/list:received", { startupDelayMs });
  if (startupDelayMs > 0) await new Promise((r) => setTimeout(r, startupDelayMs));
  const tools = [{
    name: "pi_ping",
    description: "Pings pi. Returns a sentinel string. Call this whenever asked to ping.",
    inputSchema: { type: "object", properties: { note: { type: "string", description: "any short note" } } },
  }];
  log("tools/list:responding", { n: tools.length });
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // A REAL structured tool call reached us → the model successfully routed a tool
  // (the roster was present). This is the success signature.
  log("tools/call:received", { name: req.params?.name });
  return { content: [{ type: "text", text: "PONG_FROM_PI_7Z9Q" }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
log("server-connected");
