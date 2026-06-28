import path from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodexProConfig } from "./config.js";
import { CodexProError } from "./guard.js";
import { EDITION } from "./edition.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";
import { OPTIONAL_TOOL_CARD_META, errorResult, tagToolResult, toolCardMeta } from "./serverShared.js";

export function descriptorOptionsForConfig(config: CodexProConfig, options: Record<string, unknown>): Record<string, unknown> {
  if (config.toolCards) return options;
  const meta = { ...((options._meta as Record<string, unknown> | undefined) ?? {}) };
  for (const key of OPTIONAL_TOOL_CARD_META) delete meta[key];
  return { ...options, _meta: meta };
}

function toolCallLoggingEnabled(): boolean {
  return process.env.PERSONAL_LOG_TOOL_CALLS === "1" || process.env.PERSONAL_LOG_REQUESTS === "1" || process.env.CODEXPRO_LOG_TOOL_CALLS === "1" || process.env.CODEXPRO_LOG_REQUESTS === "1";
}

function logToolCall(name: string, status: "ok" | "error", started: number): void {
  if (!toolCallLoggingEnabled()) return;
  console.error(`[${EDITION.productName}Tool] ${name} ${status} ${Date.now() - started}ms`);
}

export function registerToolCardResource(server: McpServer, config: CodexProConfig): void {
  const s = server as any;
  if (typeof s.registerResource !== "function") {
    throw new Error(`Unsupported MCP SDK: ${EDITION.productName} widgets require registerResource.`);
  }

  const registerUri = (uri: string, name: string): void => {
    s.registerResource(
      name,
      uri,
      {
        title: `${EDITION.productName} Tool Card`,
        description: `Compact visual renderer for ${EDITION.productName} workspace orientation, source changes, and handoffs.`,
        mimeType: TOOL_CARD_MIME_TYPE
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: TOOL_CARD_MIME_TYPE,
            text: toolCardWidgetHtml,
            _meta: {
              ui: {
                prefersBorder: true,
                domain: config.widgetDomain,
                csp: {
                  connectDomains: [],
                  resourceDomains: []
                }
              },
              "openai/widgetDescription": `Renders ${EDITION.productName} workspace orientation, diagnostics, file diffs, change reviews, terminal checks, Pro context exports, and handoff plans as compact developer cards with bounded previews.`,
              "openai/widgetPrefersBorder": true,
              "openai/widgetDomain": config.widgetDomain,
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: []
              }
            }
          }
        ]
      })
    );
  };

  registerUri(TOOL_CARD_URI, "codexpro-tool-card");
  for (const legacyUri of TOOL_CARD_LEGACY_URIS) {
    registerUri(legacyUri, `codexpro-tool-card-${legacyUri.match(/v\d+/)?.[0] ?? "legacy"}`);
  }
}

function isContextPath(config: CodexProConfig, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

export function assertWriteToolAllowed(config: CodexProConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
  if (config.writeMode === "handoff") {
    throw new CodexProError(
      `Source writes are disabled because CODEXPRO_WRITE_MODE=handoff. ` +
        `Use handoff_to_agent or handoff_to_codex, or write/edit only inside ${config.contextDir}/.`
    );
  }
  throw new CodexProError("write/edit tools are disabled because CODEXPRO_WRITE_MODE=off. handoff_to_agent and handoff_to_codex are still available for planning.");
}

export function registerToolCompat(
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  const wrapped = async (args: any) => {
    const started = Date.now();
    try {
      const result = tagToolResult(await handler(args ?? {}), name, options);
      logToolCall(name, result?.isError ? "error" : "ok", started);
      return result;
    } catch (error) {
      const result = tagToolResult(errorResult(error), name, options);
      logToolCall(name, "error", started);
      return result;
    }
  };

  const securitySchemes =
    config.httpAuthMode === "oauth"
      ? [{ type: "oauth2", scopes: config.oauthScopes }]
      : config.httpAuthMode === "bearer"
        ? [{ type: "http", scheme: "bearer" }]
        : [{ type: "noauth" }];
  const fullOptions: Record<string, unknown> = {
    securitySchemes,
    ...options,
    _meta: {
      securitySchemes,
      ...(options._meta as Record<string, unknown> | undefined)
    }
  };

  const s = server as any;
  if (typeof s.registerTool === 'function') {
    s.registerTool(name, fullOptions, wrapped);
    return;
  }

  if (typeof s.tool === 'function') {
    s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
    return;
  }

  throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
}

const MINIMAL_TOOL_NAMES = [
  "server_config",
  "codexpro_self_test",
  "open_current_workspace",
  "open_workspace",
  "read",
  "write",
  "edit",
  "bash",
  "show_changes"
] as const;

const STANDARD_TOOL_NAMES = [
  ...MINIMAL_TOOL_NAMES,
  "tree",
  "search",
  "load_skill",
  "read_handoff",
  "export_pro_context",
  "handoff_to_agent"
] as const;

const FULL_TOOL_NAMES = [
  "server_config",
  "codexpro_self_test",
  "codexpro_inventory",
  "load_skill",
  "list_workspaces",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "tree",
  "search",
  "read",
  "write",
  "edit",
  "bash",
  "git_status",
  "git_diff",
  "show_changes",
  "read_handoff",
  "codex_context",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex"
] as const;

function codexSessionToolNames(config: CodexProConfig): string[] {
  if (config.codexSessions === "off") return [];
  return config.codexSessions === "read"
    ? ["codex_sessions", "read_codex_session"]
    : ["codex_sessions"];
}

export function toolNamesForMode(config: CodexProConfig): string[] {
  const names: string[] =
    config.toolMode === "full"
      ? [...FULL_TOOL_NAMES]
      : config.toolMode === "minimal"
        ? [...MINIMAL_TOOL_NAMES]
        : [...STANDARD_TOOL_NAMES];
  if (config.bashMode === "off") {
    const bashIndex = names.indexOf("bash");
    if (bashIndex !== -1) names.splice(bashIndex, 1);
  }
  if (config.writeMode !== "workspace") {
    for (const writeTool of ["write", "edit"]) {
      const toolIndex = names.indexOf(writeTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  for (const name of codexSessionToolNames(config)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const MINIMAL_TOOLS = new Set<string>(MINIMAL_TOOL_NAMES);
const STANDARD_TOOLS = new Set<string>(STANDARD_TOOL_NAMES);
const registeredToolNamesByServer = new WeakMap<object, string[]>();

function rememberRegisteredTool(server: McpServer, name: string): void {
  const key = server as object;
  const names = registeredToolNamesByServer.get(key) ?? [];
  if (!registeredToolNamesByServer.has(key)) registeredToolNamesByServer.set(key, names);
  if (!names.includes(name)) names.push(name);
}

export function registeredToolNames(server: McpServer): string[] {
  return [...(registeredToolNamesByServer.get(server as object) ?? [])];
}

function shouldRegisterTool(config: CodexProConfig, name: string): boolean {
  if (name === "bash" && config.bashMode === "off") return false;
  if ((name === "write" || name === "edit") && config.writeMode !== "workspace") return false;
  if (name === "codex_sessions") return config.codexSessions !== "off";
  if (name === "read_codex_session") return config.codexSessions === "read";
  if (config.toolMode === "full") return true;
  if (config.toolMode === "minimal") return MINIMAL_TOOLS.has(name);
  return STANDARD_TOOLS.has(name);
}

export function registerCodexTool(
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  if (!shouldRegisterTool(config, name)) return;
  registerToolCompat(config, server, name, descriptorOptionsForConfig(config, options), handler);
  rememberRegisteredTool(server, name);
}
