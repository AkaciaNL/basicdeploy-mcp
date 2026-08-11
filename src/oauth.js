// OAuth for the remote MCP server — lets claude.ai (and any MCP client that speaks
// OAuth) connect without a hand-pasted API key.
//
// The hard part: claude.ai uses OAuth Dynamic Client Registration (RFC 7591) to
// register itself, but our IdP (self-hosted Zitadel v4) does NOT implement DCR yet
// (zitadel/zitadel#9810). So this module makes the MCP server itself the OAuth
// authorization server *facade* that claude.ai talks to:
//
//   claude.ai ──DCR──▶ /register        (facade below: binds to ONE pre-registered
//                                          Zitadel app, returns its client_id)
//   claude.ai ─authz─▶ /authorize ──▶ Zitadel /oauth/v2/authorize  (branded login)
//   claude.ai ─token─▶ /token     ──▶ Zitadel /oauth/v2/token
//   claude.ai ──MCP──▶ /mcp  with the Zitadel access token (verified here via JWKS)
//
// The SDK's ProxyOAuthServerProvider gives us authorize/token proxying and the
// metadata router for free; we only supply the local DCR registerClient, a getClient
// for the fixed Zitadel app, and verifyAccessToken (JWKS + userinfo → email).
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = (process.env.ZITADEL_ISSUER || "https://auth.basicdeploy.com").replace(/\/+$/, "");
// The single Zitadel OIDC app pre-registered for the Claude connector (public /
// PKCE, JWT access tokens). Every DCR request is bound to this client_id.
const CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID || "";
// claude.ai's fixed OAuth callbacks — also registered as redirect URIs on the
// Zitadel app, so Zitadel redirects the browser straight back to Claude.
const REDIRECT_URIS = (process.env.MCP_OAUTH_REDIRECT_URIS ||
  "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const oauthEnabled = Boolean(CLIENT_ID);

// The Zitadel OIDC app as an RFC 7591 client record. Returned for BOTH getClient
// (authorize/token validation) and as the DCR result. token_endpoint_auth_method
// "none" = public client, so no secret is needed at the token endpoint (PKCE).
function zitadelClient() {
  return {
    client_id: CLIENT_ID,
    redirect_uris: REDIRECT_URIS,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "openid email profile offline_access",
  };
}

export function createProvider() {
  const provider = new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: `${ISSUER}/oauth/v2/authorize`,
      tokenUrl: `${ISSUER}/oauth/v2/token`,
      revocationUrl: `${ISSUER}/oauth/v2/revoke`,
      // NOTE: deliberately no registrationUrl — Zitadel has no DCR endpoint, so we
      // register locally (the clientsStore.registerClient override below).
    },
    // Resolve the presented client_id. We only know the one Zitadel app; anything
    // else is unknown. (The DCR facade always hands Claude this same client_id.)
    getClient: async (clientId) => (clientId === CLIENT_ID ? zitadelClient() : undefined),
    verifyAccessToken,
  });

  // DCR facade: the base ProxyOAuthServerProvider only exposes registerClient when
  // an upstream registrationUrl is set. Override clientsStore to register LOCALLY —
  // accept Claude's metadata, ignore the generated id, and bind to the Zitadel app.
  Object.defineProperty(provider, "clientsStore", {
    get() {
      return {
        getClient: (clientId) =>
          clientId === CLIENT_ID ? zitadelClient() : undefined,
        registerClient: async (client) => ({
          ...client,
          ...zitadelClient(),
        }),
      };
    },
  });

  return provider;
}

// --- Access-token verification (for incoming /mcp requests) ---------------------

const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/oauth/v2/keys`));
// token -> { email, sub, exp(ms) }. Avoids a userinfo round-trip on every call;
// entries are dropped at token expiry (and never outlive it).
const tokenCache = new Map();

/**
 * Verify a Zitadel access token (JWT signed by the instance, checked against its
 * JWKS) and resolve the user's email. Throws if the token is invalid/expired.
 * Returns an MCP AuthInfo-shaped object; `extra.email` drives the account mapping.
 */
export async function verifyAccessToken(token) {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.exp > now) {
    return authInfo(token, cached);
  }

  // Authenticity + expiry + issuer. (Audience varies by Zitadel project/client, so
  // it is not pinned here; authenticity + issuer + the userinfo call below suffice.)
  const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER });

  // Zitadel access tokens do not carry email by default, so ask userinfo (the token
  // authorizes the call). This also re-confirms the token is active server-side.
  const resp = await fetch(`${ISSUER}/oidc/v1/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`userinfo failed: ${resp.status}`);
  }
  const info = await resp.json();
  const email = info.email;
  if (!email) {
    throw new Error("no email claim for access token");
  }
  const exp = (payload.exp ? payload.exp * 1000 : now + 60_000);
  const entry = { email, sub: payload.sub, exp };
  tokenCache.set(token, entry);
  return authInfo(token, entry);
}

function authInfo(token, entry) {
  return {
    token,
    clientId: CLIENT_ID,
    scopes: ["openid", "email"],
    expiresAt: Math.floor(entry.exp / 1000),
    extra: { email: entry.email, sub: entry.sub },
  };
}

// --- Zitadel identity -> BasicDeploy session ------------------------------------

const BACKEND_INTERNAL_URL = (process.env.BASICDEPLOY_INTERNAL_URL || "").replace(/\/+$/, "");
const INTERNAL_SECRET = process.env.MCP_INTERNAL_SECRET || "";

/**
 * Exchange an OAuth-verified email for a short-lived BasicDeploy session token, via
 * a service-secret-guarded internal backend endpoint (reached over the docker
 * network, never exposed publicly). The returned BasicDeploy JWT is what the tool
 * calls use as their Bearer — so the rest of the server is unchanged. Throws if the
 * email has no BasicDeploy account (404) or the exchange fails.
 */
export async function exchangeEmailForSession(email) {
  if (!BACKEND_INTERNAL_URL || !INTERNAL_SECRET) {
    throw new Error("OAuth session exchange not configured (BASICDEPLOY_INTERNAL_URL / MCP_INTERNAL_SECRET)");
  }
  const resp = await fetch(`${BACKEND_INTERNAL_URL}/api/internal/mcp-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_SECRET,
    },
    body: JSON.stringify({ email }),
  });
  if (!resp.ok) {
    throw new Error(`session exchange failed: ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.token) {
    throw new Error("session exchange returned no token");
  }
  return data.token;
}
