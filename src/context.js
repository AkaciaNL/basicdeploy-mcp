// Per-request context for the HTTP transport. The stdio server reads a single
// API key from the environment; the HTTP server serves many callers, each with
// their own key from the request's Authorization header. We carry that key
// through the async call chain with AsyncLocalStorage so client.js can pick it
// up without threading it through every tool signature.
import { AsyncLocalStorage } from "node:async_hooks";

export const apiKeyStore = new AsyncLocalStorage();

/** The API key for the current request (HTTP), or undefined (stdio → env fallback). */
export function currentApiKey() {
  return apiKeyStore.getStore()?.apiKey;
}
