// Remote MCP server over Streamable HTTP — the connector-friendly transport.
// Same 12 tools as the stdio server (createServer from index.js). Two ways to
// authenticate per request:
//   1. Authorization: Bearer bd_...      — a BasicDeploy API key (unchanged).
//   2. OAuth (Claude / ChatGPT / Gemini) — a Keycloak access token, validated here
//      (JWKS + iss + aud + exp) and exchanged for a BasicDeploy session.
// The resolved credential is stashed in AsyncLocalStorage so client.js uses it.
//
// Keycloak (realm `basicdeploy`) is the authorization server: it serves DCR,
// authorize, token, and the login page directly. This server only serves the RFC
// 9728 Protected Resource Metadata + the 401 challenge that starts the flow.
//
// Stateless mode: each POST /mcp spins up a fresh transport+server, handles the one
// JSON-RPC message, and tears down — the simplest correct shape behind a proxy.
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./index.js";
import { apiKeyStore } from "./context.js";
import {
  oauthEnabled,
  PROTECTED_RESOURCE_METADATA,
  WWW_AUTHENTICATE,
  verifyAccessToken,
  exchangeEmailForSession,
} from "./oauth.js";

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

// RFC 9728 Protected Resource Metadata — served at BOTH the path-aware form (which
// Claude probes first) and the origin form. Points MCP clients at the Keycloak
// realm as the authorization server.
if (oauthEnabled) {
  const prm = (_req, res) => res.status(200).json(PROTECTED_RESOURCE_METADATA);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.get("/.well-known/oauth-protected-resource", prm);
} else {
  console.error("MCP OAuth disabled (BASICDEPLOY_INTERNAL_URL / MCP_INTERNAL_SECRET unset) — API-key auth only.");
}

// 401 + WWW-Authenticate: the RFC 9728 challenge that makes a host begin OAuth.
function requireAuth(res) {
  res.set("WWW-Authenticate", WWW_AUTHENTICATE);
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Authentication required." },
    id: null,
  });
}

app.post("/mcp", async (req, res) => {
  const cred = bearer(req);

  // Resolve the incoming credential to the Bearer the tool calls should use:
  //  - a bd_ API key passes straight through (unchanged);
  //  - an OAuth access token is verified against Keycloak (incl. audience) and
  //    exchanged for a BasicDeploy session token.
  let apiKey;
  if (cred && cred.startsWith("bd_")) {
    apiKey = cred;
  } else if (cred && oauthEnabled) {
    try {
      const info = await verifyAccessToken(cred);
      apiKey = await exchangeEmailForSession(info.email);
    } catch (err) {
      console.error(`OAuth token rejected: ${err?.message || err}`);
      return requireAuth(res);
    }
  } else {
    return requireAuth(res);
  }

  // Fresh, stateless transport per request (no session id generator).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  try {
    const server = createServer();
    await server.connect(transport);
    // Run inside the credential context so client.js picks it up for tool calls.
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
