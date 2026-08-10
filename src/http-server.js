// Remote MCP server over Streamable HTTP — the connector-friendly transport.
// Same 12 tools as the stdio server (createServer from index.js), but callers
// authenticate per request with `Authorization: Bearer bd_...` (a BasicDeploy
// API key). The key is stashed in AsyncLocalStorage for the duration of the
// request so client.js uses it; tools/list needs no key (introspection).
//
// Stateless mode: each POST /mcp spins up a fresh transport+server, handles the
// one JSON-RPC message, and tears down — no server-held sessions, which is the
// simplest correct shape behind a load balancer.
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./index.js";
import { apiKeyStore } from "./context.js";

const PORT = Number(process.env.PORT || 8091);
const HOST = process.env.HOST || "0.0.0.0";

function bearer(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  return undefined;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

// Liveness — cheap, unauthenticated.
app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

app.post("/mcp", async (req, res) => {
  const apiKey = bearer(req);
  // Fresh, stateless transport per request (no session id generator).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  try {
    const server = createServer();
    await server.connect(transport);
    // Run inside the API-key context so client.js picks it up for tool calls.
    await apiKeyStore.run({ apiKey }, async () => {
      await transport.handleRequest(req, res, req.body);
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal error: ${err?.message || err}` },
        id: null,
      });
    }
  }
});

// Stateless server: no standalone SSE stream / session resumption.
const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST /mcp (stateless Streamable HTTP)." },
    id: null,
  });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, HOST, () => {
  console.error(`BasicDeploy MCP server (Streamable HTTP) listening on ${HOST}:${PORT}`);
});
