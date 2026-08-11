// Remote MCP server over Streamable HTTP — the connector-friendly transport.
// Same 12 tools as the stdio server (createServer from index.js). Two ways to
// authenticate per request:
//   1. Authorization: Bearer bd_...      — a BasicDeploy API key (unchanged).
//   2. Authorization: Bearer <oauth jwt> — a Zitadel access token from the OAuth
//      connector flow; verified here (JWKS) and exchanged for a BasicDeploy session.
// The resolved credential is stashed in AsyncLocalStorage so client.js uses it.
//
// OAuth endpoints (/authorize, /token, /register, /.well-known/*) are served by the
// SDK's mcpAuthRouter over a ProxyOAuthServerProvider that fronts Zitadel — see
// oauth.js for why (Zitadel lacks Dynamic Client Registration).
//
// Stateless mode: each POST /mcp spins up a fresh transport+server, handles the one
// JSON-RPC message, and tears down — the simplest correct shape behind a proxy.
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createServer } from "./index.js";
import { apiKeyStore } from "./context.js";
import {
  oauthEnabled,
  createProvider,
  verifyAccessToken,
  exchangeEmailForSession,
} from "./oauth.js";

const PORT = Number(process.env.PORT || 8091);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL || "https://mcp.basicdeploy.com").replace(/\/+$/, "");
const RESOURCE_METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;

function bearer(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  return undefined;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

// OAuth authorization-server + protected-resource endpoints (only when configured).
// Mounted at the root, as the SDK requires: serves /.well-known/oauth-authorization-server,
// /.well-known/oauth-protected-resource, /authorize, /token, /register, /revoke.
if (oauthEnabled) {
  app.use(
    mcpAuthRouter({
      provider: createProvider(),
      issuerUrl: new URL(PUBLIC_URL),
      resourceServerUrl: new URL(`${PUBLIC_URL}/mcp`),
      resourceName: "BasicDeploy",
      scopesSupported: ["openid", "email", "profile", "offline_access"],
    })
  );
} else {
  console.error("MCP OAuth disabled (MCP_OAUTH_CLIENT_ID unset) — API-key auth only.");
}

// Liveness — cheap, unauthenticated.
app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

// Ask the client to start the OAuth flow: 401 pointing at our protected-resource
// metadata (RFC 9728). This is what makes claude.ai kick off DCR + login.
function requireAuth(res) {
  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`
  );
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Authentication required." },
    id: null,
  });
}

app.post("/mcp", async (req, res) => {
  const cred = bearer(req);

  // Resolve the incoming credential to the Bearer the tool calls should use:
  //  - a bd_ API key passes straight through (unchanged behaviour);
  //  - an OAuth access token is verified against Zitadel and exchanged for a
  //    BasicDeploy session token.
  let apiKey;
  if (cred && cred.startsWith("bd_")) {
    apiKey = cred;
  } else if (cred && oauthEnabled) {
    try {
      const info = await verifyAccessToken(cred);
      apiKey = await exchangeEmailForSession(info.extra.email);
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
