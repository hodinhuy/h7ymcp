import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EDITION, editionEnvValue } from "./edition.js";

export type BashMode = "off" | "safe" | "full";
export type BashTranscriptMode = "compact" | "full";
export type CodexSessionsMode = "off" | "metadata" | "read";
export type WriteMode = "off" | "handoff" | "workspace";
export type ToolMode = "minimal" | "standard" | "full";
export type HttpAuthMode = "none" | "bearer" | "oauth";
export type OAuthApprovalMode = "token" | "manual";
export type ConnectorMode = "agent" | "handoff" | "pro";
export const CONNECTOR_MODES = ["agent", "handoff", "pro"] as const;
export const BASH_MODES = ["off", "safe", "full"] as const;
export const BASH_TRANSCRIPT_MODES = ["compact", "full"] as const;
export const CODEX_SESSIONS_MODES = ["off", "metadata", "read"] as const;
export const WRITE_MODES = ["off", "handoff", "workspace"] as const;
export const TOOL_MODES = ["minimal", "standard", "full"] as const;
export const HTTP_AUTH_MODES = ["none", "bearer", "oauth"] as const;
export const OAUTH_APPROVAL_MODES = ["token", "manual"] as const;

export interface CodexProConfig {
  defaultRoot: string;
  allowedRoots: string[];
  host: string;
  port: number;
  widgetDomain: string;
  authToken?: string;
  requireHttpToken: boolean;
  httpAuthMode: HttpAuthMode;
  oauthApprovalMode: OAuthApprovalMode;
  oauthScopes: string[];
  bashMode: BashMode;
  bashTranscript: BashTranscriptMode;
  bashSessionId?: string;
  requireBashSession: boolean;
  codexSessions: CodexSessionsMode;
  codexDir: string;
  writeMode: WriteMode;
  toolMode: ToolMode;
  inheritEnv: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxOutputBytes: number;
  maxSearchResults: number;
  maxHttpSessions: number;
  httpSessionTtlMs: number;
  blockedGlobs: string[];
  contextDir: string;
  toolCards: boolean;
}

const DEFAULT_BLOCKED_GLOBS = [
  ".git",
  ".git/**",
  "**/.git/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/.ssh/**",
  "dist",
  "dist/**",
  "**/dist/**",
  "build",
  "build/**",
  "**/build/**",
  ".next",
  ".next/**",
  "**/.next/**",
  "coverage",
  "coverage/**",
  "**/coverage/**",
  ".cache",
  ".cache/**",
  "**/.cache/**"
];

function parseArgs(argv: string[]): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const withoutPrefix = raw.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (eqIndex >= 0) {
      key = withoutPrefix.slice(0, eqIndex);
      value = withoutPrefix.slice(eqIndex + 1);
    } else {
      key = withoutPrefix;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (key === "allow-root") {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else if (prev) out[key] = [String(prev), String(value)];
      else out[key] = [String(value)];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function expandHome(input: string): string {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function splitList(value: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitRoots(value: string | undefined): string[] {
  return splitList(value, path.delimiter);
}

function toRealDir(input: string): string {
  const expanded = expandHome(input);
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function numberFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function normalizeBashMode(value: string | undefined): BashMode {
  if (value === "off" || value === "safe" || value === "full") return value;
  return "safe";
}

export function normalizeBashTranscriptMode(value: string | undefined): BashTranscriptMode {
  if (value === "compact" || value === "full") return value;
  return "compact";
}

export function normalizeCodexSessionsMode(value: string | undefined): CodexSessionsMode {
  if (value === "metadata" || value === "read") return value;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return "metadata";
  return "off";
}

export function normalizeBashSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error("PERSONAL_BASH_SESSION_ID must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.");
  }
  return trimmed;
}

export function defaultWriteModeForConnectorMode(mode: ConnectorMode): WriteMode {
  return mode === "agent" ? "workspace" : "handoff";
}

export function normalizeWriteMode(value: string | undefined, fallback: WriteMode = "handoff"): WriteMode {
  if (value === "off" || value === "handoff" || value === "workspace") return value;
  return fallback;
}

export function effectiveWriteMode(mode: ConnectorMode, requested: string | undefined): WriteMode {
  const value = normalizeWriteMode(requested, defaultWriteModeForConnectorMode(mode));
  if (mode === "agent") return value;
  return value === "off" ? "off" : "handoff";
}

export function normalizeConnectorMode(value: string | undefined): ConnectorMode {
  if (value === "handoff" || value === "pro") return value;
  return "agent";
}

export function normalizeToolMode(value: string | undefined): ToolMode {
  if (value === "minimal" || value === "standard" || value === "full") return value;
  return "standard";
}

export function normalizeHttpAuthMode(value: string | undefined, fallback: HttpAuthMode): HttpAuthMode {
  if (value === "none" || value === "bearer" || value === "oauth") return value;
  return fallback;
}

export function normalizeOAuthApprovalMode(value: string | undefined, fallback: OAuthApprovalMode): OAuthApprovalMode {
  if (value === "token" || value === "manual") return value;
  return fallback;
}

export function normalizeWidgetDomain(value: string | undefined): string {
  const raw = value?.trim() || EDITION.defaultWidgetDomain;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`PERSONAL_WIDGET_DOMAIN must be a valid origin URL, got: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("PERSONAL_WIDGET_DOMAIN must use https.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PERSONAL_WIDGET_DOMAIN must be an origin only, for example https://widgets.example.com.");
  }
  return parsed.origin;
}

export function normalizeContextDir(value: string | undefined): string {
  const raw = (value?.trim() || ".ai-bridge").replaceAll("\\", "/");
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error("PERSONAL_CONTEXT_DIR must be a workspace-relative hidden directory, for example .ai-bridge.");
  }

  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("PERSONAL_CONTEXT_DIR must stay inside the workspace.");
  }

  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("PERSONAL_CONTEXT_DIR must be a simple relative directory path.");
  }
  if (!parts[0].startsWith(".")) {
    throw new Error("PERSONAL_CONTEXT_DIR must start with a hidden directory such as .ai-bridge.");
  }

  const blocked = new Set([".git", ".ssh", ".gnupg", ".cache", "node_modules", "src", "dist", "build", ".next", "coverage"]);
  if (parts.some((part) => blocked.has(part))) {
    throw new Error("PERSONAL_CONTEXT_DIR cannot point at source, dependency, build, cache, or credential directories.");
  }
  return normalized;
}

export function normalizeTunnelMode(value: string | undefined, fallback: "none" | "cloudflare" | "cloudflare-named" | "ngrok" = "none"): "none" | "cloudflare" | "cloudflare-named" | "ngrok" {
  if (value === "none" || value === "cloudflare" || value === "cloudflare-named" || value === "ngrok") return value;
  return fallback;
}

export function boolFrom(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function loadConfig(argv = process.argv.slice(2)): CodexProConfig {
  const args = parseArgs(argv);

  const rootFromArgs = typeof args.root === "string" ? args.root : undefined;
  const root = rootFromArgs ?? editionEnvValue("ROOT", ["CODEBASE_BRIDGE_REPO_ROOT"]) ?? process.cwd();
  const defaultRoot = toRealDir(root);

  const allowRootArgs = Array.isArray(args["allow-root"])
    ? args["allow-root"]
    : typeof args["allow-root"] === "string"
      ? [args["allow-root"]]
      : [];
  const envAllowedRoots = [
    ...splitRoots(editionEnvValue("ALLOWED_ROOTS")),
    ...splitRoots(process.env.CODEBASE_BRIDGE_ALLOWED_ROOTS)
  ];

  const allowHome = editionEnvValue("ALLOW_HOME") === "1" || args["allow-home"] === true;
  const requestedAllowed = [defaultRoot, ...allowRootArgs, ...envAllowedRoots, ...(allowHome ? [os.homedir()] : [])];
  const allowedRoots = [...new Set(requestedAllowed.map(toRealDir))];

  const portArg = typeof args.port === "string" ? args.port : undefined;
  const hostArg = typeof args.host === "string" ? args.host : undefined;
  const bashArg = typeof args.bash === "string" ? args.bash : undefined;
  const bashTranscriptArg = typeof args["bash-transcript"] === "string" ? args["bash-transcript"] : undefined;
  const bashSessionArg = typeof args["bash-session"] === "string" ? args["bash-session"] : undefined;
  const codexSessionsArg = typeof args["codex-sessions"] === "string" ? args["codex-sessions"] : undefined;
  const codexDirArg = typeof args["codex-dir"] === "string" ? args["codex-dir"] : undefined;
  const requireBashSessionArg =
    args["require-bash-session"] === true
      ? "true"
      : typeof args["require-bash-session"] === "string"
        ? args["require-bash-session"]
        : undefined;
  const writeArg = typeof args.write === "string" ? args.write : undefined;
  const modeArg = typeof args.mode === "string" ? args.mode : undefined;
  const toolModeArg = typeof args["tool-mode"] === "string" ? args["tool-mode"] : undefined;
  const authModeArg = typeof args.auth === "string" ? args.auth : typeof args["http-auth"] === "string" ? args["http-auth"] : undefined;
  const widgetDomainArg = typeof args["widget-domain"] === "string" ? args["widget-domain"] : undefined;
  const toolCardsArg =
    args["tool-cards"] === true
      ? "true"
      : typeof args["tool-cards"] === "string"
        ? args["tool-cards"]
        : undefined;
  const extraBlockedGlobs = splitList(editionEnvValue("BLOCKED_GLOBS"), ",");
  const host = hostArg ?? process.env.HOST ?? editionEnvValue("HOST") ?? "127.0.0.1";
  const authToken = editionEnvValue("HTTP_TOKEN", ["CODEBASE_BRIDGE_HTTP_TOKEN"]);
  const allowNoToken = boolFrom(editionEnvValue("ALLOW_NO_HTTP_TOKEN"), false);
  const requireHttpToken =
    boolFrom(editionEnvValue("REQUIRE_HTTP_TOKEN"), false) ||
    boolFrom(editionEnvValue("TUNNEL_MODE"), false) ||
    (!isLoopbackHost(host) && !allowNoToken);
  const authModeFallback: HttpAuthMode = authToken || requireHttpToken ? "bearer" : "none";
  const httpAuthMode = normalizeHttpAuthMode(authModeArg ?? editionEnvValue("HTTP_AUTH_MODE"), authModeFallback);
  const oauthApprovalMode = normalizeOAuthApprovalMode(editionEnvValue("OAUTH_APPROVAL"), authToken ? "token" : "manual");
  const connectorMode = normalizeConnectorMode(modeArg ?? editionEnvValue("MODE"));
  const bashSessionId = normalizeBashSessionId(bashSessionArg ?? editionEnvValue("BASH_SESSION_ID"));
  const requireBashSession = boolFrom(requireBashSessionArg ?? editionEnvValue("REQUIRE_BASH_SESSION"), false);
  if (requireBashSession && !bashSessionId) {
    throw new Error("PERSONAL_REQUIRE_BASH_SESSION requires PERSONAL_BASH_SESSION_ID or --bash-session.");
  }

  return {
    defaultRoot,
    allowedRoots,
    host,
    port: numberFrom(portArg ?? process.env.PORT ?? editionEnvValue("PORT"), 8787, 1, 65535),
    widgetDomain: normalizeWidgetDomain(widgetDomainArg ?? editionEnvValue("WIDGET_DOMAIN")),
    authToken,
    requireHttpToken,
    httpAuthMode,
    oauthApprovalMode,
    oauthScopes: ["mcp:tools"],
    bashMode: normalizeBashMode(bashArg ?? editionEnvValue("BASH_MODE")),
    bashTranscript: normalizeBashTranscriptMode(bashTranscriptArg ?? editionEnvValue("BASH_TRANSCRIPT")),
    bashSessionId,
    requireBashSession,
    codexSessions: normalizeCodexSessionsMode(codexSessionsArg ?? editionEnvValue("CODEX_SESSIONS")),
    codexDir: expandHome(codexDirArg || editionEnvValue("CODEX_DIR") || path.join(os.homedir(), ".codex")),
    writeMode: effectiveWriteMode(connectorMode, writeArg ?? editionEnvValue("WRITE_MODE")),
    toolMode: normalizeToolMode(toolModeArg ?? editionEnvValue("TOOL_MODE")),
    inheritEnv: editionEnvValue("INHERIT_ENV") === "1",
    maxReadBytes: numberFrom(editionEnvValue("MAX_READ_BYTES"), 180_000, 4_000, 2_000_000),
    maxWriteBytes: numberFrom(editionEnvValue("MAX_WRITE_BYTES"), 1_000_000, 1_000, 10_000_000),
    maxOutputBytes: numberFrom(editionEnvValue("MAX_OUTPUT_BYTES"), 120_000, 4_000, 2_000_000),
    maxSearchResults: numberFrom(editionEnvValue("MAX_SEARCH_RESULTS"), 200, 5, 2_000),
    maxHttpSessions: numberFrom(editionEnvValue("MAX_HTTP_SESSIONS"), 64, 1, 512),
    httpSessionTtlMs: numberFrom(editionEnvValue("HTTP_SESSION_TTL_MS"), 30 * 60_000, 60_000, 24 * 60 * 60_000),
    blockedGlobs: [...DEFAULT_BLOCKED_GLOBS, ...extraBlockedGlobs],
    contextDir: normalizeContextDir(editionEnvValue("CONTEXT_DIR")),
    toolCards: boolFrom(toolCardsArg ?? editionEnvValue("TOOL_CARDS"), false)
  };
}
