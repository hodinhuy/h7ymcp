import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Response } from "express";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { profileIdForRoot, runtimeDir } from "./profileStore.js";

export const DEFAULT_OAUTH_SCOPES = ["mcp:tools"] as const;

const ACCESS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

interface PendingAuthorization {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  resource?: string;
  createdAt: number;
}

interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  resource?: string;
  createdAt: number;
}

interface StoredAccessToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  refreshToken?: string;
}

interface StoredRefreshToken {
  token: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface PersistedOAuthState {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, StoredAccessToken>;
  refreshTokens: Record<string, StoredRefreshToken>;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function now(): number {
  return Date.now();
}

function withErrorRedirect(redirectUri: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.href;
}

class PersistentClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly state: LocalOAuthState) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.state.getClient(clientId);
  }

  async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): Promise<OAuthClientInformationFull> {
    const typed = client as OAuthClientInformationFull;
    if (!typed.client_id) {
      throw new InvalidRequestError("Registered client is missing client_id.");
    }
    this.state.saveClient(typed);
    return typed;
  }
}

export class LocalOAuthState {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly statePath: string;
  private persisted: PersistedOAuthState;

  constructor(root: string) {
    this.statePath = path.join(runtimeDir(), `oauth-${profileIdForRoot(root)}.json`);
    this.persisted = this.load();
    this.clientsStore = new PersistentClientsStore(this);
  }

  private load(): PersistedOAuthState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PersistedOAuthState;
      return {
        version: 1,
        clients: raw?.clients && typeof raw.clients === "object" ? raw.clients : {},
        accessTokens: raw?.accessTokens && typeof raw.accessTokens === "object" ? raw.accessTokens : {},
        refreshTokens: raw?.refreshTokens && typeof raw.refreshTokens === "object" ? raw.refreshTokens : {}
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { version: 1, clients: {}, accessTokens: {}, refreshTokens: {} };
      }
      throw error;
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.statePath, `${JSON.stringify(this.persisted, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(this.statePath, 0o600);
    } catch {
      // Best effort on filesystems that support chmod.
    }
  }

  private prune(): void {
    const current = now();
    for (const [id, pending] of this.pending) {
      if (pending.createdAt + AUTH_REQUEST_TTL_MS <= current) this.pending.delete(id);
    }
    for (const [code, record] of this.codes) {
      if (record.createdAt + AUTH_REQUEST_TTL_MS <= current) this.codes.delete(code);
    }
    let changed = false;
    for (const [token, record] of Object.entries(this.persisted.accessTokens)) {
      if (record.expiresAt <= current) {
        delete this.persisted.accessTokens[token];
        changed = true;
      }
    }
    for (const [token, record] of Object.entries(this.persisted.refreshTokens)) {
      if (record.expiresAt <= current) {
        delete this.persisted.refreshTokens[token];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    this.prune();
    return this.persisted.clients[clientId];
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.prune();
    this.persisted.clients[client.client_id] = client;
    this.persist();
  }

  beginAuthorization(client: OAuthClientInformationFull, params: AuthorizationParams): PendingAuthorization {
    this.prune();
    const request: PendingAuthorization = {
      id: randomUUID(),
      clientId: client.client_id,
      clientName: client.client_name || client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes: params.scopes ?? [],
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
      createdAt: now()
    };
    this.pending.set(request.id, request);
    return request;
  }

  completeAuthorization(requestId: string): AuthorizationCodeRecord {
    this.prune();
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new InvalidRequestError("Authorization request was not found or expired.");
    }
    this.pending.delete(requestId);
    const code: AuthorizationCodeRecord = {
      code: randomUUID(),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      state: pending.state,
      scopes: pending.scopes,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      createdAt: now()
    };
    this.codes.set(code.code, code);
    return code;
  }

  denyAuthorization(requestId: string): PendingAuthorization | undefined {
    this.prune();
    const pending = this.pending.get(requestId);
    if (pending) this.pending.delete(requestId);
    return pending;
  }

  challengeForAuthorizationCode(clientId: string, code: string): string {
    this.prune();
    const record = this.codes.get(code);
    if (!record || record.clientId !== clientId) {
      throw new InvalidGrantError("Invalid authorization code.");
    }
    return record.codeChallenge;
  }

  exchangeAuthorizationCode(clientId: string, code: string, redirectUri?: string, resource?: URL): OAuthTokens {
    this.prune();
    const record = this.codes.get(code);
    if (!record || record.clientId !== clientId) {
      throw new InvalidGrantError("Invalid authorization code.");
    }
    this.codes.delete(code);
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    if (resource && record.resource) {
      const allowed = checkResourceAllowed({ requestedResource: resource, configuredResource: record.resource });
      if (!allowed) throw new InvalidGrantError("resource does not match the authorized MCP server.");
    }
    const refreshToken = randomUUID();
    const accessToken = this.issueAccessToken({
      clientId,
      scopes: record.scopes,
      resource: resource?.href ?? record.resource,
      refreshToken
    });
    this.persisted.refreshTokens[refreshToken] = {
      token: refreshToken,
      clientId,
      scopes: record.scopes,
      resource: resource?.href ?? record.resource,
      expiresAt: now() + REFRESH_TOKEN_TTL_MS
    };
    this.persist();
    return accessToken;
  }

  exchangeRefreshToken(clientId: string, refreshToken: string, scopes?: string[], resource?: URL): OAuthTokens {
    this.prune();
    const record = this.persisted.refreshTokens[refreshToken];
    if (!record || record.clientId !== clientId || record.expiresAt <= now()) {
      throw new InvalidGrantError("Invalid refresh token.");
    }
    if (scopes && scopes.length) {
      const requested = new Set(scopes);
      if (!record.scopes.every((scope) => requested.has(scope)) && !scopes.every((scope) => record.scopes.includes(scope))) {
        throw new InvalidGrantError("Requested scope exceeds the original grant.");
      }
    }
    if (resource && record.resource) {
      const allowed = checkResourceAllowed({ requestedResource: resource, configuredResource: record.resource });
      if (!allowed) throw new InvalidGrantError("resource does not match the refresh token grant.");
    }
    return this.issueAccessToken({
      clientId,
      scopes: scopes?.length ? scopes : record.scopes,
      resource: resource?.href ?? record.resource,
      refreshToken
    });
  }

  verifyAccessToken(token: string): AuthInfo {
    this.prune();
    const record = this.persisted.accessTokens[token];
    if (!record || record.expiresAt <= now()) {
      throw new InvalidTokenError("Invalid or expired access token.");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      ...(record.resource ? { resource: new URL(record.resource) } : {})
    };
  }

  revokeToken(clientId: string, request: OAuthTokenRevocationRequest): void {
    const token = request.token;
    const accessToken = this.persisted.accessTokens[token];
    if (accessToken && accessToken.clientId === clientId) {
      delete this.persisted.accessTokens[token];
    }
    const refreshToken = this.persisted.refreshTokens[token];
    if (refreshToken && refreshToken.clientId === clientId) {
      delete this.persisted.refreshTokens[token];
    }
    this.persist();
  }

  private issueAccessToken(input: {
    clientId: string;
    scopes: string[];
    resource?: string;
    refreshToken?: string;
  }): OAuthTokens {
    const accessToken = randomUUID();
    const expiresAt = now() + ACCESS_TOKEN_TTL_MS;
    this.persisted.accessTokens[accessToken] = {
      token: accessToken,
      clientId: input.clientId,
      scopes: input.scopes,
      resource: input.resource,
      expiresAt,
      refreshToken: input.refreshToken
    };
    this.persist();
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: input.scopes.join(" "),
      ...(input.refreshToken ? { refresh_token: input.refreshToken } : {})
    };
  }
}

export class LocalOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly state: LocalOAuthState,
    private readonly options: {
      approvalBaseUrl: URL;
      authToken?: string;
      manualApproval?: boolean;
      oauthScopes: readonly string[];
      resourceServerUrl: URL;
    }
  ) {
    this.clientsStore = state.clientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource) {
      const expected = resourceUrlFromServerUrl(this.options.resourceServerUrl);
      const allowed = checkResourceAllowed({ requestedResource: params.resource, configuredResource: expected });
      if (!allowed) {
        throw new InvalidRequestError("Requested resource does not match this MCP server.");
      }
    }
    const request = this.state.beginAuthorization(client, params);
    const manualApproval = Boolean(this.options.manualApproval);
    const requiresToken = Boolean(this.options.authToken) && !manualApproval;
    const resource = params.resource?.href || this.options.resourceServerUrl.href;
    const scopes = (params.scopes?.length ? params.scopes : [...this.options.oauthScopes]).join(" ");
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${escapeHtml(client.client_name || client.client_id)}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7fb; color: #172033; }
    main { width: min(560px, calc(100% - 32px)); background: #fff; border: 1px solid #dbe3f0; border-radius: 18px; padding: 24px; box-shadow: 0 18px 50px rgba(20, 30, 60, 0.12); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p, li { line-height: 1.55; color: #44506a; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; word-break: break-all; }
    ul { padding-left: 18px; }
    label { display: grid; gap: 8px; margin: 16px 0 20px; font-weight: 600; color: #172033; }
    input { min-height: 44px; border: 1px solid #c8d4e6; border-radius: 12px; padding: 0 14px; font: inherit; }
    .buttons { display: flex; gap: 12px; flex-wrap: wrap; }
    button { min-height: 44px; border-radius: 12px; border: 1px solid #1d4ed8; padding: 0 16px; font: inherit; font-weight: 700; cursor: pointer; }
    .approve { background: #1d4ed8; color: #fff; }
    .deny { background: #fff; color: #1d4ed8; }
    .hint { margin-top: 16px; font-size: 13px; color: #5b677f; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize ${escapeHtml(client.client_name || client.client_id)}</h1>
    <p>This app wants to connect to your local ${escapeHtml(resource)} MCP server.</p>
    <ul>
      <li><strong>Client ID:</strong> <code>${escapeHtml(client.client_id)}</code></li>
      <li><strong>Redirect URI:</strong> <code>${escapeHtml(params.redirectUri)}</code></li>
      <li><strong>Scopes:</strong> <code>${escapeHtml(scopes || "(none)")}</code></li>
    </ul>
    <form method="post" action="${escapeHtml(new URL("/oauth/approve", this.options.approvalBaseUrl).href)}">
      <input type="hidden" name="request_id" value="${escapeHtml(request.id)}">
      <input type="hidden" name="decision" value="approve">
      ${
        requiresToken
          ? `<label>Bearer approval token
          <input name="approval_token" type="password" autocomplete="off" placeholder="Paste PERSONAL_HTTP_TOKEN">
        </label>`
          : ""
      }
      <div class="buttons">
        <button class="approve" type="submit">Approve</button>
        <button class="deny" type="submit" formaction="${escapeHtml(new URL("/oauth/deny", this.options.approvalBaseUrl).href)}" formnovalidate>Deny</button>
      </div>
    </form>
    <p class="hint">${
      requiresToken
        ? "Use the same bearer token your H7Y MCP launcher printed for this run. This keeps public tunnel OAuth approval from becoming open access."
        : manualApproval
          ? "Manual approval is enabled for this run. Anyone who can open this approval page can approve or deny the request."
          : "This server is running without an approval token."
    }</p>
  </main>
</body>
</html>`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.state.challengeForAuthorizationCode(client.client_id, authorizationCode);
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    return this.state.exchangeAuthorizationCode(client.client_id, authorizationCode, redirectUri, resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    return this.state.exchangeRefreshToken(client.client_id, refreshToken, scopes, resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return this.state.verifyAccessToken(token);
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.state.revokeToken(client.client_id, request);
  }

  async approve(req: { requestId: string; approvalToken?: string }, res: Response): Promise<void> {
    if (this.options.authToken && !this.options.manualApproval) {
      const provided = Buffer.from(req.approvalToken ?? "");
      const expected = Buffer.from(this.options.authToken);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        res.status(401).type("html").send("<h1>Invalid approval token</h1><p>The bearer approval token did not match this H7Y MCP run.</p>");
        return;
      }
    }
    const code = this.state.completeAuthorization(req.requestId);
    const redirect = new URL(code.redirectUri);
    redirect.searchParams.set("code", code.code);
    if (code.state) redirect.searchParams.set("state", code.state);
    res.redirect(302, redirect.href);
  }

  async deny(requestId: string, res: Response): Promise<void> {
    const pending = this.state.denyAuthorization(requestId);
    if (!pending) {
      res.status(400).type("html").send("<h1>Authorization request expired</h1>");
      return;
    }
    res.redirect(302, withErrorRedirect(pending.redirectUri, AccessDeniedError.errorCode, "The connection request was denied.", pending.state));
  }
}
