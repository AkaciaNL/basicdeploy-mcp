// Thin REST client for the BasicDeploy API.
// Uses the global fetch available in Node.js >= 18.

const BASE_URL = (process.env.BASICDEPLOY_URL || "https://basicdeploy.com").replace(/\/+$/, "");
const API_KEY = process.env.BASICDEPLOY_API_KEY;

// The API key is required to CALL any tool, but NOT to start the server or list its
// tools — so MCP clients (and registries like Glama) can introspect the server
// without credentials. The check happens per request, below.

/**
 * Perform a request against the BasicDeploy API and return the parsed JSON body
 * (or null for empty responses). Throws an Error with a readable message,
 * including the HTTP status and the server's `message` field, on failure.
 */
async function request(path, { method = "GET", body, headers = {} } = {}) {
  if (!API_KEY) {
    throw new Error(
      "BASICDEPLOY_API_KEY is not set. Create an API key at https://basicdeploy.com/api-keys " +
        'and set BASICDEPLOY_API_KEY="bd_..." in the server env.'
    );
  }
  const url = `${BASE_URL}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...headers,
    },
  };

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body; // fetch sets the multipart Content-Type + boundary itself
    } else {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new Error(`Could not reach BasicDeploy at ${BASE_URL}: ${err.message}`);
  }

  if (!response.ok) {
    let serverMessage = "";
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        serverMessage = json.message || json.error || text;
      } catch {
        serverMessage = text;
      }
    } catch {
      // ignore body read failures
    }
    const detail = serverMessage ? `: ${serverMessage}` : "";
    throw new Error(`BasicDeploy API error (HTTP ${response.status} ${method} ${path})${detail}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

// --- Containers ---

export function listContainers() {
  return request("/api/containers");
}

export function createContainer(memoryBytes, alwaysOn) {
  const body = {};
  if (memoryBytes != null) body.memoryBytes = memoryBytes;
  if (alwaysOn != null) body.alwaysOn = alwaysOn;
  return request("/api/containers", {
    method: "POST",
    ...(Object.keys(body).length ? { body } : {}),
  });
}

/**
 * Toggle a container's always-on flag (POST /api/containers/{id}/always-on).
 * On FREE this consumes a paid add-on slot (402 if none free); on PRO/SCALE it is
 * a no-op (already always-on). Returns the updated container.
 */
export function setAlwaysOn(containerId, enabled) {
  return request(`/api/containers/${encodeURIComponent(containerId)}/always-on`, {
    method: "POST",
    body: { enabled },
  });
}

/**
 * Wake a slept container (POST /api/containers/{id}/wake): start it so it serves
 * traffic again. A no-op if already running. Returns the updated container.
 * (Any web request to its public URL also wakes it automatically.)
 */
export function wakeContainer(containerId) {
  return request(`/api/containers/${encodeURIComponent(containerId)}/wake`, { method: "POST" });
}

/**
 * Sleep a running container (POST /api/containers/{id}/sleep): stop it to free RAM
 * while keeping its volume and routing, so it wakes again on the next request.
 * Returns the updated container.
 */
export function sleepContainer(containerId) {
  return request(`/api/containers/${encodeURIComponent(containerId)}/sleep`, { method: "POST" });
}

/**
 * The account's plan, limits and add-ons (GET /api/auth/me): plan tier, container
 * limit (base + add-ons), selectable memory sizes, storage limit, and how many
 * always-on add-ons are held.
 */
export function getAccount() {
  return request("/api/auth/me");
}

export function getContainer(containerId) {
  return request(`/api/containers/${encodeURIComponent(containerId)}`);
}

export function getLogs(containerId, tail = 200) {
  return request(
    `/api/containers/${encodeURIComponent(containerId)}/logs?tail=${encodeURIComponent(tail)}`
  );
}

export function deleteContainer(containerId) {
  return request(`/api/containers/${encodeURIComponent(containerId)}`, { method: "DELETE" });
}

export function execCommand(containerId, command) {
  return request(`/api/containers/${encodeURIComponent(containerId)}/exec`, {
    method: "POST",
    body: { command },
  });
}

export function shareContainer(containerId, email, expiresInHours) {
  const body = { email };
  // Only send expiresInHours when provided; omitting it means an unlimited share.
  if (expiresInHours !== undefined && expiresInHours !== null) {
    body.expiresInHours = expiresInHours;
  }
  return request(`/api/containers/${encodeURIComponent(containerId)}/share`, {
    method: "POST",
    body,
  });
}

/**
 * Upload an app archive into an existing container (POST /api/containers/{id}/upload).
 */
export function uploadToContainer(containerId, fileBuffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([fileBuffer]), filename);
  return request(`/api/containers/${encodeURIComponent(containerId)}/upload`, {
    method: "POST",
    body: form,
  });
}

/**
 * Deploy an app archive (POST /api/deploy): unpacks into /workspace, detects the
 * runtime and starts the app. Omit containerId to create + deploy a NEW container;
 * pass one to deploy INTO an existing container you own.
 * Returns { message, containerId }.
 */
export function deployApp(fileBuffer, filename, containerId) {
  const form = new FormData();
  form.append("file", new Blob([fileBuffer]), filename);
  if (containerId) form.append("containerId", containerId);
  return request("/api/deploy", { method: "POST", body: form });
}
