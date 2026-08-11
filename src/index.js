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
      "or restarting processes inside the container.",
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
      "The runtime (Node.js, Python, or Go) is auto-detected from the archive contents. " +
      "If containerId is omitted, a new container (with DB + S3) is created for the app; " +
      "if provided, the archive is deployed into that existing container. " +
      "Returns the resulting container and its public URL.",
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
  create_container:{ readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  deploy_app:      { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  set_always_on:   { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  wake_container:  { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  sleep_container: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  share_container: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  exec_command:    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  delete_container:{ readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

// Tools with their annotations merged in, as the MCP tools/list response wants them.
const TOOLS_ANNOTATED = TOOLS.map((t) => ({
  ...t,
  annotations: { title: t.name, ...(ANNOTATIONS[t.name] || {}) },
}));

function text(t) {
  return { content: [{ type: "text", text: t }] };
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
        return text("No containers found.");
      }
      const lines = containers.map(
        (c) =>
          `- ${c.subdomain} [${c.status}] ${containerUrl(c)} (id: ${c.id}, created: ${c.createdAt})`
      );
      return text(`${containers.length} container(s):\n${lines.join("\n")}`);
    }

    case "create_container": {
      const memoryBytes = args.memoryMb != null ? Math.round(args.memoryMb) * 1024 * 1024 : undefined;
      const c = await api.createContainer(memoryBytes, args.alwaysOn);
      return text(
        `Created container (database and S3 bucket provisioned automatically).\n` +
          containerSummary(c)
      );
    }

    case "set_always_on": {
      const c = await api.setAlwaysOn(args.containerId, args.enabled);
      return text(`always-on ${args.enabled ? "enabled" : "disabled"} for ${c.subdomain}.\n${containerSummary(c)}`);
    }

    case "wake_container": {
      const c = await api.wakeContainer(args.containerId);
      return text(`Woke ${c.subdomain} (status: ${c.status}).\n${containerSummary(c)}`);
    }

    case "sleep_container": {
      const c = await api.sleepContainer(args.containerId);
      return text(`Slept ${c.subdomain} (status: ${c.status}).\n${containerSummary(c)}`);
    }

    case "get_account": {
      const me = await api.getAccount();
      const p = me.plan || {};
      const sizes = Array.isArray(p.memorySizes)
        ? p.memorySizes.map((b) => `${Math.round(b / (1024 * 1024))}MB`).join(", ")
        : "n/a";
      const limit = p.effectiveMaxContainers ?? p.maxContainers;
      return text(
        `Account plan: ${p.displayName || p.name || "Free"}\n` +
          `  container limit: ${limit} (plan base ${p.maxContainers}, always-on add-ons ${me.containerAddons ?? 0})\n` +
          `  selectable memory sizes: ${sizes}\n` +
          `  storage limit: ${p.maxStorageBytes != null ? Math.round(p.maxStorageBytes / (1024 * 1024 * 1024)) + "GB" : "n/a"} per container\n` +
          `  custom domains: ${p.maxCustomDomains ?? 0}\n` +
          `  auto-sleep: ${p.autoSleep ? "yes (containers sleep when idle unless always-on)" : "no (always-on)"}`
      );
    }

    case "get_container": {
      const c = await api.getContainer(args.containerId);
      return text(
        containerSummary(c) +
          `\n  hostPort:  ${c.hostPort}` +
          `\n  sshPort:   ${c.sshPort}` +
          `\n  database:  ${c.dbName} (user: ${c.dbUsername})` +
          `\n  s3Bucket:  ${c.s3Bucket}` +
          `\n  volume:    ${c.volumePath}` +
          `\n  lastAccessed: ${c.lastAccessed}`
      );
    }

    case "exec_command": {
      const result = await api.execCommand(args.containerId, args.command);
      const status = result.exitCode === 0 ? "succeeded" : `failed (exit code ${result.exitCode})`;
      const output = result.output?.trim() ? result.output : "(no output)";
      return text(`Command ${status}.\nExit code: ${result.exitCode}\nOutput:\n${output}`);
    }

    case "get_logs": {
      const tail = args.tail ?? 200;
      const result = await api.getLogs(args.containerId, tail);
      const logs = result.logs?.trim() ? result.logs : "(no log output)";
      return text(`Last ${tail} log lines for container ${args.containerId}:\n${logs}`);
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
      return text(summary);
    }

    case "share_container": {
      const result = await api.shareContainer(args.containerId, args.email, args.expiresInHours);
      const expiryNote = args.expiresInHours
        ? ` (expires in ${args.expiresInHours}h)`
        : "";
      return text(
        result?.message || `Shared container ${args.containerId} with ${args.email}${expiryNote}.`
      );
    }

    case "delete_container": {
      await api.deleteContainer(args.containerId);
      return text(
        `Container ${args.containerId} permanently deleted (container, database, and files destroyed).`
      );
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
