// OAuth for the remote MCP server — lets Claude, ChatGPT, and Gemini (and any
// spec-compliant MCP client) connect via OAuth instead of a hand-pasted API key.
//
// Our authorization server is self-hosted Keycloak (realm `basicdeploy`), which
// natively provides RFC 7591 Dynamic Client Registration, RFC 8414 metadata, PKCE,
// and userinfo — so, unlike the old Zitadel setup, NO facade/proxy is needed. The
// clients discover and talk to Keycloak directly; this server only has to:
//   1. serve RFC 9728 Protected Resource Metadata,
//   2. answer unauthenticated calls with 401 + WWW-Authenticate (RFC 9728),
//   3. validate the Keycloak access token (JWKS, iss, aud, exp) on every request,
//   4. map the verified identity (email) to a BasicDeploy session.
//
// The `aud` check is load-bearing (MCP spec MUST): Keycloak is configured with an
// Audience mapper hard-coding this resource into every token, because Keycloak does
// not honor the RFC 8707 `resource` parameter the clients send.
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = (process.env.KEYCLOAK_ISSUER || "https://auth.basicdeploy.com/realms/basicdeploy").replace(/\/+$/, "");
// The resource identifier for THIS MCP server, exactly as the user types the URL.
const RESOURCE = process.env.MCP_RESOURCE || "https://mcp.basicdeploy.com/mcp";
const BACKEND_INTERNAL_URL = (process.env.BASICDEPLOY_INTERNAL_URL || "").replace(/\/+$/, "");
const INTERNAL_SECRET = process.env.MCP_INTERNAL_SECRET || "";

// OAuth is on when the identity→session exchange is configured. Absent that, the
// server runs API-key-only (unchanged legacy behaviour).
export const oauthEnabled = Boolean(BACKEND_INTERNAL_URL && INTERNAL_SECRET);

// RFC 9728 Protected Resource Metadata document (served at both well-known paths).
// `authorization_servers` lists a SINGLE issuer — Claude uses only the first entry
// and never falls back.
export const PROTECTED_RESOURCE_METADATA = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: ["openid", "email", "profile", "offline_access"],
  bearer_methods_supported: ["header"],
  resource_name: "BasicDeploy",
};

// The URL clients are pointed at via the 401 WWW-Authenticate header. Path-aware
// form (…/oauth-protected-resource/mcp) is what Claude probes first.
const RESOURCE_ORIGIN = new URL(RESOURCE).origin;
export const RESOURCE_METADATA_URL = `${RESOURCE_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

// The 401 challenge value. `resource_metadata` is load-bearing; `error` marks it a
// token problem so the host starts the OAuth/Connect flow.
export const WWW_AUTHENTICATE =
  `Bearer error="invalid_token", resource_metadata="${RESOURCE_METADATA_URL}"`;

// --- Access-token verification --------------------------------------------------

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`));
// token -> { email, sub, exp(ms) }; entries never outlive the token.
const tokenCache = new Map();

/**
 * Verify a Keycloak access token: JWKS signature + issuer + audience (MUST equal
 * this resource) + expiry. Then resolve the user's email (from the token, else
 * userinfo). Throws on any failure — the caller returns a 401 challenge.
 */
export async function verifyAccessToken(token) {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.exp > now) return cached;

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: ISSUER,
    audience: RESOURCE,
  });

  let email = payload.email;
  if (!email) {
    const resp = await fetch(`${ISSUER}/protocol/openid-connect/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) email = (await resp.json()).email;
  }
  if (!email) throw new Error("no email claim on token");

  const entry = {
    email,
    sub: payload.sub,
    exp: payload.exp ? payload.exp * 1000 : now + 60_000,
  };
  tokenCache.set(token, entry);
  return entry;
}

/**
 * Exchange an OAuth-verified email for a BasicDeploy session token via the backend's
 * service-secret-guarded internal endpoint (docker network only, nginx-blocked at
 * the edge). The returned BasicDeploy JWT is what the tool calls use as their Bearer
 * — so the rest of the server is unchanged. Throws if the email has no account.
 */
export async function exchangeEmailForSession(email) {
  const resp = await fetch(`${BACKEND_INTERNAL_URL}/api/internal/mcp-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": INTERNAL_SECRET },
    body: JSON.stringify({ email }),
  });
  if (!resp.ok) throw new Error(`session exchange failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.token) throw new Error("session exchange returned no token");
  return data.token;
}
