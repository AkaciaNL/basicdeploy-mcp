#!/usr/bin/env node
// BasicDeploy MCP server — exposes container deployment and management tools
// to AI coding agents (Claude Code, Cursor, ...) over stdio.

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as api from "./client.js";

function containerUrl(container) {
  return container?.subdomain ? `https://${container.subdomain}.basicdeploy.com` : "(no subdomain)";
}

function containerSummary(c) {
  return [
    `Container ${c.id}`,
    `  subdomain: ${c.subdomain}`,
    `  url:       ${containerUrl(c)}`,
    `  status:    ${c.status}`,
    `  createdAt: ${c.createdAt}`,
  ].join("\n");
}

const TOOLS = [
  {
    name: "list_containers",
    description:
      "List all BasicDeploy containers owned by (or shared with) the authenticated user. " +
      "Returns each container's id, subdomain, public URL, status, and creation time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_container",
    description:
      "Create a new empty BasicDeploy container. A PostgreSQL database and an S3 bucket are " +
      "provisioned automatically for it. Returns the container's id, subdomain, and public URL. " +
      "Its public URL is proxied to PORT 8080 inside the container, so whatever you deploy MUST listen on " +
      "0.0.0.0:8080 (any other port/binding returns 503). " +
      "Use deploy_app or exec_command afterwards to put an application in it. Optional memoryMb " +
      "(256/512/1024/2048) and alwaysOn require the plan/add-ons to allow them (see get_account); " +
      "larger sizes need Pro/Scale, and always-on on Free consumes a paid add-on slot.",
    inputSchema: {
      type: "object",
      properties: {
        memoryMb: {
          type: "number",
          description: "Memory for the container in MB: 256, 512, 1024, or 2048. Defaults to the plan's default.",
        },
        alwaysOn: {
          type: "boolean",
          description: "Keep the container running 24/7 (never auto-sleep). On Free this uses a paid add-on slot.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "set_always_on",
    description:
      "Turn a container's always-on (24/7, never sleeps) flag on or off. On Free this consumes a " +
      "paid always-on add-on slot (fails if none is free); on Pro/Scale every container is always-on " +
      "already. Returns the updated container.",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string", description: "The container's UUID." },
        enabled: { type: "boolean", description: "true to enable always-on, false to disable." },
      },
      required: ["containerId", "enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "wake_container",
    description:
      "Wake a slept container so it serves traffic again (start it). A no-op if it is already " +
      "running. Note: any web request to the container's public URL also wakes it automatically. " +
      "Returns the updated container.",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string", description: "The container's UUID." },
      },
      required: ["containerId"],
      additionalProperties: false,
    },
  },
  {
    name: "sleep_container",
    description:
      "Sleep a running container: stop it to free memory while keeping its volume, database, and " +
      "public URL, so it wakes again on the next request. Returns the updated container.",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string", description: "The container's UUID." },
      },
      required: ["containerId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_account",
    description:
      "Show the account's plan and capabilities: plan tier, container limit (plan base + add-ons), " +
      "the memory sizes you may select, storage limit, how many always-on add-ons you hold, and " +
      "whether containers auto-sleep. Use this to see what you're allowed to set.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_container",
    description:
      "Get full details of one container: id, subdomain, public URL, status, ports, database name " +
      "and username, S3 bucket, volume path, and timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string", description: "UUID of the container" },
      },
      required: ["containerId"],
      additionalProperties: false,
    },
  },
  {
    name: "exec_command",
    description:
      "Run a shell command inside a container (like docker exec). Returns the combined " +
      "stdout/stderr output and the exit code. Useful for inspecting files, installing packages, " +
      "or restarting processes inside the container. " +
      "DEPLOYING WITHOUT A TARBALL (the way to deploy over a remote/chat connector, where there is " +
      "no shared filesystem for deploy_app): write your app's files into the container with exec_command " +
      "(e.g. heredoc/echo or install from git), install deps, then start the server. CRITICAL: the " +
      "container's public URL (https://<subdomain>.basicdeploy.com) is ALWAYS proxied to PORT 8080 inside " +
      "the container, so your app MUST listen on 0.0.0.0:8080 — NOT localhost/127.0.0.1, and NOT 3000/5000/etc. " +
      "Any other port or binding returns HTTP 503 at the public URL even though the process is running. The " +
      "routing is wired when the container is created; you do NOT need deploy_app to 'register' it. There is " +
      "no init/supervisor: a process you start runs only until the container sleeps or restarts and is NOT " +
      "relaunched — for a long-running web server enable always-on (set_always_on) and start it detached.",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string", description: "UUID of the container" },
        command: { type: "string", description: "Shell command to execute inside the container" },
      },
      required: ["containerId", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "get_logs",
    description:
      "Fetch recent logs from a container. Use this to debug crashes or check application output.",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string", description: "UUID of the container" },
        tail: {
          type: "integer",
          description: "Number of log lines to return from the end (default 200)",
          default: 200,
        },
      },
      required: ["containerId"],
      additionalProperties: false,
    },
  },
  {
    name: "deploy_app",
    description:
      "Deploy an application from a local tarball (.tar, .tar.gz, .tgz, or .zip) to BasicDeploy. " +
      "The runtime (Node.js, Python, or Go) is auto-detected from the archive contents; the app must " +
      "listen on 0.0.0.0:8080. If containerId is omitted, a new container (with DB + S3) is created for " +
      "the app; if provided, the archive is deployed into that existing container. Returns the resulting " +
      "container and its public URL. " +
      "IMPORTANT: tarballPath is a path on the machine running THIS MCP client (i.e. the local/stdio " +
      "install). When BasicDeploy is added as a REMOTE connector (Claude/ChatGPT/Gemini chat) there is no " +
      "shared filesystem, so this tool cannot read your tarball — deploy with exec_command instead (write " +
      "the files into the container and start the server on 0.0.0.0:8080).",
    inputSchema: {
      type: "object",
      properties: {
        containerId: {
          type: "string",
          description: "Optional UUID of an existing container to deploy into. Omit to create a new one.",
        },
        tarballPath: {
          type: "string",
          description: "Absolute path on local disk to the app archive (.tar, .tar.gz, .tgz, .zip)",
        },
      },
      required: ["tarballPath"],
      additionalProperties: false,
    },
  },
  {
    name: "share_container",
    description:
      "Share a container with another BasicDeploy user by email, giving them access to it. " +
      "The recipient is emailed a link that signs them in and opens the container. " +
      "Optionally pass expiresInHours to make the share expire after that many hours " +
      "(omit for a share that never expires).",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string", description: "UUID of the container" },
        email: { type: "string", description: "Email address of the user to share with" },
        expiresInHours: {
          type: "integer",
          minimum: 1,
          description:
            "Optional. Hours until the share expires. Omit for an unlimited (never-expiring) share.",
        },
      },
      required: ["containerId", "email"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_container",
    description:
      "PERMANENTLY delete a container. This destroys the container, its database, and all its " +
      "files (S3 bucket contents included) and cannot be undone. Only call this when the user " +
      "has clearly asked for the container to be removed.",
    inputSchema: {
      type: "object",
      properties: {
        containerId: { type: "string", description: "UUID of the container to delete" },
      },
      required: ["containerId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_docs",
    description:
      "Fetch the BasicDeploy documentation as Markdown so you can answer the user's questions and deploy " +
      "correctly without leaving the chat. Covers: what BasicDeploy is, deploying an app (the 0.0.0.0:8080 " +
      "rule), the runtime and preset env vars, the PostgreSQL database and S3 object storage, the REST API, " +
      "the MCP tools, custom domains, SSH, plans/pricing, and hosted auth-as-a-service (OpenID Connect) for " +
      "your app's own end-users. Optional 'topic' returns only the matching section(s).",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Optional keyword to return only matching doc section(s): e.g. overview, deploy, database, " +
            "storage, env, auth, api, mcp, domains, ssh, plans.",
        },
      },
      additionalProperties: false,
    },
  },
];

// MCP tool annotations (behaviour hints). Required for the OpenAI/ChatGPT Apps
// directory submission and useful to every host:
//   readOnlyHint    — true only when the tool changes nothing.
//   destructiveHint — true when it can delete/overwrite/irreversibly change.
//   openWorldHint   — true when it changes publicly-visible internet state
//                     (e.g. a deployed app / public URL).
const ANNOTATIONS = {
  list_containers: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_account:     { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_container:   { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_logs:        { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_docs:        { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  create_container:{ readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  deploy_app:      { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  set_always_on:   { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  wake_container:  { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  sleep_container: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  share_container: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  exec_command:    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  delete_container:{ readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

// --- Output schemas (structured results) --------------------------------------
// A curated, NON-SECRET view of a container. Credentials (DB URL, S3 keys, SSH
// key) are deliberately excluded from structuredContent; they remain in the text
// content for the owner. additionalProperties:false keeps the structured payload
// to exactly these fields.
const CONTAINER_SCHEMA = {
  type: "object",
  description: "A BasicDeploy container (non-secret fields).",
  properties: {
    id: { type: "string", description: "Container UUID." },
    subdomain: { type: "string", description: "Container subdomain." },
    url: { type: "string", description: "Public HTTPS URL." },
    status: { type: "string", description: "Lifecycle status, e.g. running or sleeping." },
    memoryBytes: { type: "integer", description: "Memory limit in bytes." },
    storageBytes: { type: "integer", description: "Storage used in bytes." },
    createdAt: { type: "string", description: "Creation time (ISO 8601)." },
  },
  required: ["id", "subdomain", "status", "url"],
  additionalProperties: false,
};

const OUTPUT_SCHEMAS = {
  list_containers: {
    type: "object",
    properties: {
      count: { type: "integer", description: "Number of containers." },
      containers: { type: "array", items: CONTAINER_SCHEMA },
    },
    required: ["containers"],
    additionalProperties: false,
  },
  create_container: CONTAINER_SCHEMA,
  get_container: CONTAINER_SCHEMA,
  set_always_on: CONTAINER_SCHEMA,
  wake_container: CONTAINER_SCHEMA,
  sleep_container: CONTAINER_SCHEMA,
  get_account: { type: "object", description: "Account plan, limits and add-ons.", additionalProperties: true },
  get_logs: {
    type: "object",
    properties: { logs: { type: "string", description: "Recent log output." } },
    required: ["logs"],
    additionalProperties: false,
  },
  exec_command: {
    type: "object",
    properties: {
      exitCode: { type: "integer", description: "Process exit code." },
      output: { type: "string", description: "Combined stdout/stderr." },
    },
    additionalProperties: true,
  },
  deploy_app: {
    type: "object",
    properties: {
      containerId: { type: "string", description: "Target container UUID." },
      message: { type: "string" },
    },
    required: ["containerId"],
    additionalProperties: true,
  },
  share_container: {
    type: "object",
    properties: { message: { type: "string" } },
    additionalProperties: true,
  },
  delete_container: {
    type: "object",
    properties: { deleted: { type: "boolean" }, message: { type: "string" } },
    required: ["deleted"],
    additionalProperties: false,
  },
  get_docs: {
    type: "object",
    properties: { markdown: { type: "string", description: "Documentation in Markdown." } },
    required: ["markdown"],
    additionalProperties: false,
  },
};

// Tools with their annotations + output schemas merged in, as tools/list wants them.
const TOOLS_ANNOTATED = TOOLS.map((t) => ({
  ...t,
  annotations: { title: t.name, ...(ANNOTATIONS[t.name] || {}) },
  ...(OUTPUT_SCHEMAS[t.name] ? { outputSchema: OUTPUT_SCHEMAS[t.name] } : {}),
}));

function text(t) {
  return { content: [{ type: "text", text: t }] };
}

// A result carrying BOTH the human text and the structured payload. The spec
// asks for the serialized JSON in a text block too (back-compat), so we append it.
function withData(t, data) {
  const content = [{ type: "text", text: t }];
  return { content, structuredContent: data };
}

// Curated non-secret container fields for structuredContent.
function containerData(c) {
  if (!c) return undefined;
  const d = { id: c.id, subdomain: c.subdomain, url: containerUrl(c), status: c.status };
  if (c.memoryBytes != null) d.memoryBytes = c.memoryBytes;
  if (c.storageBytes != null) d.storageBytes = c.storageBytes;
  if (c.createdAt != null) d.createdAt = c.createdAt;
  return d;
}

function errorResult(err) {
  return {
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

async function handleTool(name, args = {}) {
  switch (name) {
    case "list_containers": {
      const containers = await api.listContainers();
      if (!containers || containers.length === 0) {
        return withData("No containers found.", { count: 0, containers: [] });
      }
      const lines = containers.map(
        (c) =>
          `- ${c.subdomain} [${c.status}] ${containerUrl(c)} (id: ${c.id}, created: ${c.createdAt})`
      );
      return withData(`${containers.length} container(s):\n${lines.join("\n")}`, {
        count: containers.length,
        containers: containers.map(containerData),
      });
    }

    case "create_container": {
      const memoryBytes = args.memoryMb != null ? Math.round(args.memoryMb) * 1024 * 1024 : undefined;
      const c = await api.createContainer(memoryBytes, args.alwaysOn);
      return withData(
        `Created container (database and S3 bucket provisioned automatically).\n` +
          containerSummary(c) +
          `\n\nDeploy note: the public URL is routed to PORT 8080 inside the container — your app MUST ` +
          `listen on 0.0.0.0:8080 or the URL returns 503. DATABASE_URL and S3_ENDPOINT/S3_ACCESS_KEY/` +
          `S3_SECRET_KEY/S3_BUCKET are preset in the container env. Call get_docs for the full guide.`,
        containerData(c)
      );
    }

    case "set_always_on": {
      const c = await api.setAlwaysOn(args.containerId, args.enabled);
      return withData(`always-on ${args.enabled ? "enabled" : "disabled"} for ${c.subdomain}.\n${containerSummary(c)}`, containerData(c));
    }

    case "wake_container": {
      const c = await api.wakeContainer(args.containerId);
      return withData(`Woke ${c.subdomain} (status: ${c.status}).\n${containerSummary(c)}`, containerData(c));
    }

    case "sleep_container": {
      const c = await api.sleepContainer(args.containerId);
      return withData(`Slept ${c.subdomain} (status: ${c.status}).\n${containerSummary(c)}`, containerData(c));
    }

    case "get_account": {
      const me = await api.getAccount();
      const p = me.plan || {};
      const sizes = Array.isArray(p.memorySizes)
        ? p.memorySizes.map((b) => `${Math.round(b / (1024 * 1024))}MB`).join(", ")
        : "n/a";
      const limit = p.effectiveMaxContainers ?? p.maxContainers;
      return withData(
        `Account plan: ${p.displayName || p.name || "Free"}\n` +
          `  container limit: ${limit} (plan base ${p.maxContainers}, always-on add-ons ${me.containerAddons ?? 0})\n` +
          `  selectable memory sizes: ${sizes}\n` +
          `  storage limit: ${p.maxStorageBytes != null ? Math.round(p.maxStorageBytes / (1024 * 1024 * 1024)) + "GB" : "n/a"} per container\n` +
          `  custom domains: ${p.maxCustomDomains ?? 0}\n` +
          `  auto-sleep: ${p.autoSleep ? "yes (containers sleep when idle unless always-on)" : "no (always-on)"}`,
        me
      );
    }

    case "get_container": {
      const c = await api.getContainer(args.containerId);
      return withData(
        containerSummary(c) +
          `\n  hostPort:  ${c.hostPort}` +
          `\n  sshPort:   ${c.sshPort}` +
          `\n  database:  ${c.dbName} (user: ${c.dbUsername})` +
          `\n  s3Bucket:  ${c.s3Bucket}` +
          `\n  volume:    ${c.volumePath}` +
          `\n  lastAccessed: ${c.lastAccessed}`,
        containerData(c)
      );
    }

    case "exec_command": {
      const result = await api.execCommand(args.containerId, args.command);
      const status = result.exitCode === 0 ? "succeeded" : `failed (exit code ${result.exitCode})`;
      const output = result.output?.trim() ? result.output : "(no output)";
      return withData(`Command ${status}.\nExit code: ${result.exitCode}\nOutput:\n${output}`, {
        exitCode: result.exitCode,
        output: result.output ?? "",
      });
    }

    case "get_logs": {
      const tail = args.tail ?? 200;
      const result = await api.getLogs(args.containerId, tail);
      const logs = result.logs?.trim() ? result.logs : "(no log output)";
      return withData(`Last ${tail} log lines for container ${args.containerId}:\n${logs}`, {
        logs: result.logs ?? "",
      });
    }

    case "deploy_app": {
      const filename = basename(args.tarballPath);
      let fileBuffer;
      try {
        fileBuffer = await readFile(args.tarballPath);
      } catch (err) {
        throw new Error(`Could not read tarball at ${args.tarballPath}: ${err.message}`);
      }

      // Real deploy pipeline (unpack to /workspace, detect runtime, start): into an
      // existing container when containerId is given, else a fresh one.
      const result = await api.deployApp(fileBuffer, filename, args.containerId);
      const targetId = result.containerId || args.containerId;
      let summary = args.containerId
        ? `Deploying ${filename} into container ${targetId}.`
        : `Deployment started (containerId: ${targetId}).`;
      try {
        const c = await api.getContainer(targetId);
        summary = `Deployed ${filename} ${args.containerId ? "into existing container" : "to a new container"}.\n${containerSummary(c)}`;
      } catch {
        // container details may not be readable yet while deployment is in progress
      }
      return withData(summary, { containerId: targetId, message: result.message || "Deployment started." });
    }

    case "share_container": {
      const result = await api.shareContainer(args.containerId, args.email, args.expiresInHours);
      const expiryNote = args.expiresInHours
        ? ` (expires in ${args.expiresInHours}h)`
        : "";
      const msg = result?.message || `Shared container ${args.containerId} with ${args.email}${expiryNote}.`;
      return withData(msg, { message: msg });
    }

    case "delete_container": {
      await api.deleteContainer(args.containerId);
      return withData(
        `Container ${args.containerId} permanently deleted (container, database, and files destroyed).`,
        { deleted: true, message: `Container ${args.containerId} permanently deleted.` }
      );
    }

    case "get_docs": {
      const base = (process.env.BASICDEPLOY_URL || "https://basicdeploy.com").replace(/\/+$/, "");
      const [docsRes, llmsRes] = await Promise.all([
        fetch(`${base}/docs/index.md`, { headers: { Accept: "text/markdown" } }).catch(() => null),
        fetch(`${base}/llms.txt`).catch(() => null),
      ]);
      let docs = docsRes && docsRes.ok ? await docsRes.text() : "";
      const llms = llmsRes && llmsRes.ok ? await llmsRes.text() : "";
      if (!docs && !llms) {
        throw new Error("Could not fetch BasicDeploy documentation right now. See https://basicdeploy.com/docs");
      }
      const topic = (args.topic || "").trim().toLowerCase();
      if (topic && docs) {
        const sections = docs.split(/\n(?=#{1,3} )/);
        const hits = sections.filter((s) => s.toLowerCase().includes(topic));
        if (hits.length) docs = hits.join("\n\n");
      }
      const parts = [];
      if (docs) parts.push(docs);
      if (llms && !topic) parts.push(`\n\n---\n# Connector / LLM quick reference (llms.txt)\n\n${llms}`);
      const md = parts.join("\n");
      return withData(md, { markdown: md });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Build a fresh MCP Server wired with the tools. Shared by the stdio entrypoint
// (below) and the HTTP entrypoint (http-server.js), so both transports expose the
// exact same tools and behaviour.
export function createServer() {
  const server = new Server(
    { name: "basicdeploy-mcp", version: "1.0.7" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_ANNOTATED }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args);
    } catch (err) {
      return errorResult(err);
    }
  });

  return server;
}

export { TOOLS };

// Run over stdio ONLY when this file is executed directly (the npx/bin path).
// When imported (by http-server.js) this side effect must not fire.
const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("BasicDeploy MCP server running on stdio");
}
