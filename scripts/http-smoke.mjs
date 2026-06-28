import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

async function canonicalFixturePath(filePath) {
  const parent = await fs.realpath(path.dirname(filePath));
  return path.join(parent, path.basename(filePath));
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15000);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout waiting for process exit\n${stderr}`));
    }, timeoutMs);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

async function waitForHealthJson(url, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for ${url}\n${lastError}`);
}

async function expectHttpTokenRequired(name, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `personal-http-no-token-${name}-`));
  const port = await getFreePort();
  const env = {
    ...process.env,
    PERSONAL_ROOT: root,
    PERSONAL_ALLOWED_ROOTS: root,
    PERSONAL_HOST: '127.0.0.1',
    PERSONAL_PORT: String(port),
    PERSONAL_BASH_MODE: 'safe',
    PERSONAL_WRITE_MODE: 'handoff',
    ...overrides
  };
  delete env.PERSONAL_HTTP_TOKEN;
  delete env.CODEXPRO_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  delete env.PERSONAL_ALLOW_NO_HTTP_TOKEN;
  delete env.CODEXPRO_ALLOW_NO_HTTP_TOKEN;

  const child = spawn('node', ['dist/http.js'], {
    cwd: path.resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = await waitForExit(child);
  if (result.code === 0) {
    throw new Error(`expected ${name} HTTP server without token to fail closed`);
  }
  if (!result.stderr.includes('HTTP_TOKEN is required')) {
    throw new Error(`expected ${name} missing-token failure, got:\n${result.stderr}`);
  }
}

function mergeHeaders(token, headers = {}) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers
  };
}

async function listTools(url, token, headers = {}) {
  const client = new Client({ name: 'codexpro-http-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: mergeHeaders(token, headers) }
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close();
  }
}

function toolNames(tools) {
  return tools.map((tool) => tool.name);
}

function securitySchemeTypes(tools, name) {
  const tool = tools.find((item) => item.name === name) ?? {};
  return (tool.securitySchemes ?? tool._meta?.securitySchemes ?? []).map((scheme) => `${scheme.type}${scheme.scheme ? `:${scheme.scheme}` : ''}`);
}

function hasWidgetMeta(tools, name, uri) {
  const tool = tools.find((item) => item.name === name);
  const meta = tool?._meta ?? {};
  return meta.ui?.resourceUri === uri && meta['openai/outputTemplate'] === uri;
}

function hasToolCardStatusMeta(tools, name) {
  const tool = tools.find((item) => item.name === name);
  const meta = tool?._meta ?? {};
  return Boolean(meta['openai/toolInvocation/invoking'] || meta['openai/toolInvocation/invoked']);
}

await expectHttpTokenRequired('non-loopback', { PERSONAL_HOST: '0.0.0.0' });
await expectHttpTokenRequired('tunnel-mode', { PERSONAL_TUNNEL_MODE: '1' });

async function withClient(url, token, fn, headers = {}) {
  const client = new Client({ name: 'codexpro-http-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: mergeHeaders(token, headers) }
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${text}`);
  }
  return result;
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function pkceChallenge(verifier) {
  return base64Url(createHash('sha256').update(verifier).digest());
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-http-smoke-'));
const realRoot = await fs.realpath(root);
const profileHome = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-http-profile-home-'));
await fs.mkdir(path.join(root, '.codex', 'skills', 'http-smoke-skill'), { recursive: true });
await fs.writeFile(path.join(root, '.codex', 'skills', 'http-smoke-skill', 'SKILL.md'), [
  '---',
  'name: http-smoke-skill',
  'description: HTTP smoke test skill discovery.',
  '---',
  '',
  '# HTTP Smoke Skill',
  ''
].join('\n'), 'utf8');
const port = await getFreePort();
const token = 'personal-http-smoke-token';
const child = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PERSONAL_ROOT: root,
    PERSONAL_ALLOWED_ROOTS: root,
    PERSONAL_PORT: String(port),
    PERSONAL_HTTP_TOKEN: token,
    PERSONAL_BASH_MODE: 'safe',
    PERSONAL_WRITE_MODE: 'handoff',
    PERSONAL_TOOL_MODE: 'full',
    PERSONAL_TOOL_CARDS: '0',
    PERSONAL_WIDGET_DOMAIN: 'https://widgets.personal.test',
    PERSONAL_HOME: profileHome
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForListening(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const unauthorized = await fetch(`${baseUrl}/healthz`);
  if (unauthorized.status !== 401) {
    throw new Error(`expected unauthenticated healthz to return 401, got ${unauthorized.status}`);
  }

  const authorized = await fetch(`${baseUrl}/healthz`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (authorized.status !== 200) {
    throw new Error(`expected authenticated healthz to return 200, got ${authorized.status}`);
  }

  const queryAuthorized = await fetch(`${baseUrl}/healthz?codexpro_token=${encodeURIComponent(token)}`);
  if (queryAuthorized.status !== 401) {
    throw new Error(`expected URL-token healthz to return 401, got ${queryAuthorized.status}`);
  }

  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  if (favicon.status !== 200 || !favicon.headers.get('content-type')?.includes('image/svg+xml')) {
    throw new Error(`expected unauthenticated favicon to return SVG 200, got ${favicon.status} ${favicon.headers.get('content-type')}`);
  }

  const home = await fetch(`${baseUrl}/`);
  const homeText = await home.text();
  if (home.status !== 200 || !home.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`expected authenticated onboarding page to return HTML 200, got ${home.status}`);
  }
  if (!homeText.includes('H7Y MCP Local Control') || !homeText.includes('CLI controls') || !homeText.includes('Connect ChatGPT') || !homeText.includes('Runtime guardrails')) {
    throw new Error('onboarding page did not include expected admin setup copy');
  }
  if (!homeText.includes('Connection profile') || !homeText.includes('data-profile-form')) {
    throw new Error('onboarding page did not include the saved profile editor');
  }
  for (const fieldName of ['tunnelName', 'ngrokConfig', 'cloudflareConfig', 'cloudflareTokenFile', 'toolCards', 'noInstallCloudflared']) {
    if (!homeText.includes(`name="${fieldName}"`)) {
      throw new Error(`onboarding page did not include profile field ${fieldName}`);
    }
  }
  if (homeText.includes(token)) {
    throw new Error('onboarding page leaked the raw auth token');
  }

  const profileBefore = await fetch(`${baseUrl}/admin/profile`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const profileBeforeJson = await profileBefore.json();
  if (profileBefore.status !== 200 || profileBeforeJson.exists !== false) {
    throw new Error(`expected empty admin profile response, got ${profileBefore.status} ${JSON.stringify(profileBeforeJson)}`);
  }
  if (JSON.stringify(profileBeforeJson).includes(token)) {
    throw new Error('admin profile GET leaked the raw auth token');
  }

  const invalidProfile = await fetch(`${baseUrl}/admin/profile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tunnel: 'ngrok',
      hostname: 'codexpro-http-smoke.ngrok-free.app',
      requireBashSession: true,
      bashSession: ''
    })
  });
  if (invalidProfile.status !== 400) {
    throw new Error(`expected invalid guarded profile to return 400, got ${invalidProfile.status}`);
  }

  const profileSave = await fetch(`${baseUrl}/admin/profile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tunnel: 'ngrok',
      hostname: 'https://codexpro-http-smoke.ngrok-free.app/mcp',
      port,
      mode: 'agent',
      bash: 'safe',
      bashTranscript: 'full',
      codexSessions: 'metadata',
      codexDir: path.join(root, '.codex'),
      bashSession: 'http-main',
      requireBashSession: true,
      write: 'workspace',
      toolMode: 'full',
      toolCards: true,
      widgetDomain: 'https://widgets.personal.test',
      ngrokConfig: path.join(root, 'ngrok.yml'),
      cloudflareTokenFile: 'cloudflare-token',
      noInstallCloudflared: true
    })
  });
  const profileSaveJson = await profileSave.json();
  if (profileSave.status !== 200 || profileSaveJson.saved !== true) {
    throw new Error(`expected admin profile save to pass, got ${profileSave.status} ${JSON.stringify(profileSaveJson)}`);
  }
  if (JSON.stringify(profileSaveJson).includes(token)) {
    throw new Error('admin profile save response leaked the raw auth token');
  }
  const savedProfile = JSON.parse(await fs.readFile(profileSaveJson.profile_path, 'utf8'));
  const expectedNgrokConfig = path.join(savedProfile.root, 'ngrok.yml');
  const expectedCloudflareTokenFile = path.join(savedProfile.root, 'cloudflare-token');
  if (
    savedProfile.tunnel !== 'ngrok' ||
    savedProfile.hostname !== 'codexpro-http-smoke.ngrok-free.app' ||
    savedProfile.bashTranscript !== 'full' ||
    savedProfile.codexSessions !== 'metadata' ||
    savedProfile.bashSession !== 'http-main' ||
    savedProfile.requireBashSession !== true ||
    savedProfile.toolCards !== true ||
    savedProfile.ngrokConfig !== expectedNgrokConfig ||
    savedProfile.cloudflareTokenFile !== expectedCloudflareTokenFile ||
    savedProfile.noInstallCloudflared !== true ||
    savedProfile.token !== token
  ) {
    throw new Error(`admin profile save wrote unexpected profile: ${JSON.stringify(savedProfile)}`);
  }

  const queryTools = await listTools(`${baseUrl}/mcp`, token);
  const queryToolNames = toolNames(queryTools);
  for (const expected of ['server_config', 'codexpro_self_test', 'codexpro_inventory', 'open_current_workspace', 'open_workspace', 'workspace_snapshot', 'load_skill', 'show_changes', 'codex_context', 'handoff_to_agent', 'handoff_to_codex', 'export_pro_context']) {
    if (!queryToolNames.includes(expected)) {
      throw new Error(`bearer MCP tools/list missing ${expected}; got ${queryToolNames.join(', ')}`);
    }
  }
  for (const hidden of ['write', 'edit']) {
    if (queryToolNames.includes(hidden)) {
      throw new Error(`HTTP handoff mode should not advertise ${hidden}; got ${queryToolNames.join(', ')}`);
    }
  }
  const toolCardUri = 'ui://widget/codexpro-tool-card-v9.html';
  for (const visualTool of queryToolNames) {
    if (hasWidgetMeta(queryTools, visualTool, toolCardUri) || hasToolCardStatusMeta(queryTools, visualTool)) {
      throw new Error(`${visualTool} exposed widget metadata while PERSONAL_TOOL_CARDS is off`);
    }
  }

  const headerTools = await listTools(`${baseUrl}/mcp`, token);
  const headerToolNames = toolNames(headerTools);
  if (!headerToolNames.includes('server_config')) {
    throw new Error(`bearer MCP tools/list missing server_config; got ${headerToolNames.join(', ')}`);
  }
  if (!securitySchemeTypes(headerTools, 'server_config').includes('http:bearer')) {
    throw new Error(`bearer MCP tools/list exposed wrong auth metadata: ${JSON.stringify(headerTools.find((tool) => tool.name === 'server_config'))}`);
  }

  const mcpUrl = `${baseUrl}/mcp`;
  await withClient(mcpUrl, token, async (client) => {
    try {
      const resources = await client.listResources();
      const toolCard = resources.resources.find((resource) => resource.uri === toolCardUri);
      if (toolCard) {
        throw new Error(`HTTP MCP should not register tool-card resources while PERSONAL_TOOL_CARDS is off: ${toolCardUri}`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !/Method not found/i.test(error.message)) {
        throw error;
      }
    }
  });

  const currentOpened = await withClient(mcpUrl, token, async (client) => {
    const result = await callTool(client, 'open_current_workspace', { include_tree: false });
    if (result.structuredContent.codexpro_tool !== 'open_current_workspace') {
      throw new Error('HTTP tool result was not tagged for widget rendering');
    }
    if (result.structuredContent.tool_mode !== 'full') {
      throw new Error(`open_current_workspace did not expose tool_mode: ${result.structuredContent.tool_mode}`);
    }
    if (!result.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'http-smoke-skill')) {
      throw new Error('HTTP open_current_workspace did not discover workspace skill inventory');
    }
    return result.structuredContent.workspace_id;
  });

  await withClient(mcpUrl, token, async (client) => {
    const inventory = await callTool(client, 'codexpro_inventory', {
      include_global_skills: false,
      include_mcp_servers: false
    });
    if (inventory.structuredContent.codexpro_tool !== 'codexpro_inventory') {
      throw new Error('HTTP inventory result was not tagged for widget rendering');
    }
    const loadedSkill = await callTool(client, 'load_skill', {
      name: 'http-smoke-skill',
      source: 'workspace'
    });
    if (loadedSkill.structuredContent.skill?.name !== 'http-smoke-skill' || !loadedSkill.structuredContent.text?.includes('# HTTP Smoke Skill')) {
      throw new Error('HTTP load_skill did not return bounded SKILL.md content');
    }
  });

  const opened = await withClient(mcpUrl, token, async (client) => {
    const result = await callTool(client, 'open_workspace', { include_tree: false });
    return result.structuredContent.workspace_id;
  });
  if (opened !== currentOpened) {
    throw new Error(`open_current_workspace returned ${currentOpened}, open_workspace default returned ${opened}`);
  }

  await withClient(mcpUrl, token, async (client) => {
    const list = await callTool(client, 'list_workspaces');
    const ids = list.structuredContent.workspaces.map((workspace) => workspace.id);
    if (!ids.includes(opened)) {
      throw new Error(`cross-session list_workspaces missing ${opened}; got ${ids.join(', ')}`);
    }

    const snapshot = await callTool(client, 'workspace_snapshot', { workspace_id: opened, max_depth: 1 });
    if (snapshot.structuredContent.workspace_id !== opened) {
      throw new Error(`workspace_snapshot returned ${snapshot.structuredContent.workspace_id}, expected ${opened}`);
    }

    const tree = await callTool(client, 'tree', { workspace_id: opened, max_depth: 1, max_entries: 10 });
    if (tree.structuredContent.workspace_id !== opened) {
      throw new Error(`tree returned ${tree.structuredContent.workspace_id}, expected ${opened}`);
    }

    const codexContext = await callTool(client, 'codex_context', { workspace_id: opened });
    if (codexContext.structuredContent.workspace_id !== opened) {
      throw new Error(`codex_context returned ${codexContext.structuredContent.workspace_id}, expected ${opened}`);
    }
  });

  try {
    await fs.stat(path.join(root, '.ai-bridge'));
    throw new Error('read-only HTTP smoke path created .ai-bridge unexpectedly');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await withClient(mcpUrl, token, async (client) => {
    const exported = await callTool(client, 'export_pro_context', {
      workspace_id: opened,
      max_files: 4,
      max_total_bytes: 80000
    });
    if (exported.structuredContent.path !== '.ai-bridge/pro-context.md') {
      throw new Error(`unexpected pro context path: ${exported.structuredContent.path}`);
    }
  });
  await fs.stat(path.join(root, '.ai-bridge', 'pro-context.md'));
} finally {
  child.kill('SIGTERM');
  await waitForExit(child).catch(() => {});
}

const oauthRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-http-oauth-'));
const oauthPort = await getFreePort();
const oauthApprovalToken = 'personal-http-oauth-approval-token';
const oauthChild = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PERSONAL_ROOT: oauthRoot,
    PERSONAL_ALLOWED_ROOTS: oauthRoot,
    PERSONAL_PORT: String(oauthPort),
    PERSONAL_HTTP_TOKEN: oauthApprovalToken,
    PERSONAL_HTTP_AUTH_MODE: 'oauth',
    PERSONAL_BASH_MODE: 'safe',
    PERSONAL_WRITE_MODE: 'handoff'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  await waitForListening(oauthChild);
  const oauthBase = `http://127.0.0.1:${oauthPort}`;
  const publicHost = 'oauth-smoke.example.test';
  const forwarded = {
    Host: publicHost,
    'x-forwarded-host': publicHost,
    'x-forwarded-proto': 'https'
  };

  const metadata = await fetch(`${oauthBase}/.well-known/oauth-authorization-server`, { headers: forwarded });
  const metadataJson = await metadata.json();
  if (metadata.status !== 200 || metadataJson.authorization_endpoint !== `https://${publicHost}/authorize` || metadataJson.registration_endpoint !== `https://${publicHost}/register`) {
    throw new Error(`unexpected OAuth metadata: ${metadata.status} ${JSON.stringify(metadataJson)}`);
  }

  const resourceMetadata = await fetch(`${oauthBase}/.well-known/oauth-protected-resource/mcp`, { headers: forwarded });
  const resourceMetadataJson = await resourceMetadata.json();
  if (resourceMetadata.status !== 200 || resourceMetadataJson.resource !== `https://${publicHost}/mcp`) {
    throw new Error(`unexpected protected resource metadata: ${resourceMetadata.status} ${JSON.stringify(resourceMetadataJson)}`);
  }

  const registration = await fetch(`${oauthBase}/register`, {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'http-oauth-smoke',
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tools'
    })
  });
  const registrationJson = await registration.json();
  if (registration.status !== 201 || !registrationJson.client_id) {
    throw new Error(`unexpected OAuth registration response: ${registration.status} ${JSON.stringify(registrationJson)}`);
  }

  const verifier = 'oauth-smoke-verifier-0123456789';
  const authorization = await fetch(
    `${oauthBase}/authorize?response_type=code&client_id=${encodeURIComponent(registrationJson.client_id)}&redirect_uri=${encodeURIComponent('https://chatgpt.com/connector/oauth/callback')}&code_challenge=${encodeURIComponent(pkceChallenge(verifier))}&code_challenge_method=S256&scope=${encodeURIComponent('mcp:tools')}&state=oauth-smoke&resource=${encodeURIComponent(`https://${publicHost}/mcp`)}`,
    { headers: forwarded }
  );
  const authorizationHtml = await authorization.text();
  const requestId = authorizationHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
  if (authorization.status !== 200 || !requestId || !authorizationHtml.includes('Bearer approval token')) {
    throw new Error(`unexpected OAuth authorize page: ${authorization.status} ${authorizationHtml.slice(0, 240)}`);
  }

  const approval = await fetch(`${oauthBase}/oauth/approve`, {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId, approval_token: oauthApprovalToken }).toString(),
    redirect: 'manual'
  });
  const approvalLocation = approval.headers.get('location') || '';
  const approvalCode = new URL(approvalLocation).searchParams.get('code');
  if (approval.status !== 302 || !approvalCode || !approvalLocation.includes('state=oauth-smoke')) {
    throw new Error(`unexpected OAuth approval redirect: ${approval.status} ${approvalLocation}`);
  }

  const tokenResponse = await fetch(`${oauthBase}/token`, {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registrationJson.client_id,
      code: approvalCode,
      code_verifier: verifier,
      redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
      resource: `https://${publicHost}/mcp`
    }).toString()
  });
  const tokenJson = await tokenResponse.json();
  if (tokenResponse.status !== 200 || !tokenJson.access_token || tokenJson.token_type !== 'bearer') {
    throw new Error(`unexpected OAuth token response: ${tokenResponse.status} ${JSON.stringify(tokenJson)}`);
  }

  const oauthTools = await listTools(`${oauthBase}/mcp`, tokenJson.access_token, forwarded);
  if (!toolNames(oauthTools).includes('server_config')) {
    throw new Error(`OAuth MCP tools/list missing server_config; got ${toolNames(oauthTools).join(', ')}`);
  }
  if (!securitySchemeTypes(oauthTools, 'server_config').includes('oauth2')) {
    throw new Error(`OAuth MCP tools/list exposed wrong auth metadata: ${JSON.stringify(oauthTools.find((tool) => tool.name === 'server_config'))}`);
  }
} finally {
  oauthChild.kill('SIGTERM');
  await waitForExit(oauthChild).catch(() => {});
}

const oauthManualRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-http-oauth-manual-'));
const oauthManualPort = await getFreePort();
const oauthManualBearer = 'personal-http-oauth-manual-bearer';
const oauthManualChild = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PERSONAL_ROOT: oauthManualRoot,
    PERSONAL_ALLOWED_ROOTS: oauthManualRoot,
    PERSONAL_PORT: String(oauthManualPort),
    PERSONAL_HTTP_TOKEN: oauthManualBearer,
    PERSONAL_HTTP_AUTH_MODE: 'oauth',
    PERSONAL_OAUTH_APPROVAL: 'manual',
    PERSONAL_TUNNEL_MODE: '1',
    PERSONAL_BASH_MODE: 'safe',
    PERSONAL_WRITE_MODE: 'handoff'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  await waitForListening(oauthManualChild);
  const oauthBase = `http://127.0.0.1:${oauthManualPort}`;
  const publicHost = 'oauth-manual-smoke.example.test';
  const forwarded = {
    Host: publicHost,
    'x-forwarded-host': publicHost,
    'x-forwarded-proto': 'https'
  };

  const registration = await fetch(`${oauthBase}/register`, {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'http-oauth-manual-smoke',
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tools'
    })
  });
  const registrationJson = await registration.json();
  if (registration.status !== 201 || !registrationJson.client_id) {
    throw new Error(`unexpected OAuth manual registration response: ${registration.status} ${JSON.stringify(registrationJson)}`);
  }

  const verifier = 'oauth-manual-smoke-verifier-0123456789';
  const authorization = await fetch(
    `${oauthBase}/authorize?response_type=code&client_id=${encodeURIComponent(registrationJson.client_id)}&redirect_uri=${encodeURIComponent('https://chatgpt.com/connector/oauth/callback')}&code_challenge=${encodeURIComponent(pkceChallenge(verifier))}&code_challenge_method=S256&scope=${encodeURIComponent('mcp:tools')}&state=oauth-manual-smoke&resource=${encodeURIComponent(`https://${publicHost}/mcp`)}`,
    { headers: forwarded }
  );
  const authorizationHtml = await authorization.text();
  const requestId = authorizationHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
  if (authorization.status !== 200 || !requestId || authorizationHtml.includes('Bearer approval token')) {
    throw new Error(`unexpected OAuth manual authorize page: ${authorization.status} ${authorizationHtml.slice(0, 240)}`);
  }

  const approval = await fetch(`${oauthBase}/oauth/approve`, {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId }).toString(),
    redirect: 'manual'
  });
  const approvalLocation = approval.headers.get('location') || '';
  const approvalCode = new URL(approvalLocation).searchParams.get('code');
  if (approval.status !== 302 || !approvalCode || !approvalLocation.includes('state=oauth-manual-smoke')) {
    throw new Error(`unexpected OAuth manual approval redirect: ${approval.status} ${approvalLocation}`);
  }
} finally {
  oauthManualChild.kill('SIGTERM');
  await waitForExit(oauthManualChild).catch(() => {});
}

const disabledRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-http-disabled-tools-'));
const disabledPort = await getFreePort();
const disabledToken = 'personal-http-disabled-token';
const disabledChild = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PERSONAL_ROOT: disabledRoot,
    PERSONAL_ALLOWED_ROOTS: disabledRoot,
    PERSONAL_PORT: String(disabledPort),
    PERSONAL_HTTP_TOKEN: disabledToken,
    PERSONAL_BASH_MODE: 'off',
    PERSONAL_WRITE_MODE: 'off',
    PERSONAL_TOOL_MODE: 'full'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  await waitForListening(disabledChild);
  const disabledBase = `http://127.0.0.1:${disabledPort}`;
  const disabledTools = await listTools(`${disabledBase}/mcp`, disabledToken);
  const disabledToolNames = toolNames(disabledTools);
  for (const hiddenTool of ['bash', 'write', 'edit']) {
    if (disabledToolNames.includes(hiddenTool)) {
      throw new Error(`HTTP disabled mode should not advertise ${hiddenTool}; got ${disabledToolNames.join(', ')}`);
    }
  }
  await withClient(`${disabledBase}/mcp`, disabledToken, async (client) => {
    const config = await callTool(client, 'server_config');
    if (config.structuredContent.bashMode !== 'off' || config.structuredContent.writeMode !== 'off') {
      throw new Error(`HTTP disabled mode server_config mismatch: ${JSON.stringify(config.structuredContent)}`);
    }
  });
} finally {
  disabledChild.kill('SIGTERM');
  await waitForExit(disabledChild).catch(() => {});
}

const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'h7ymcp-http-smoke-'));
await fs.mkdir(path.join(cliRoot, '.codex'), { recursive: true });
const cliPort = await getFreePort();
const cliChild = spawn(process.execPath, [
  'scripts/codexpro.mjs',
  'start',
  '--root',
  cliRoot,
  '--tunnel',
  'none',
  '--no-auth',
  '--port',
  String(cliPort),
  '--codex-sessions',
  'metadata',
  '--codex-dir',
  '.codex'
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    PERSONAL_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'h7ymcp-http-home-'))
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  await waitForHealthJson(`http://127.0.0.1:${cliPort}/healthz`);
  await withClient(`http://127.0.0.1:${cliPort}/mcp`, undefined, async (client) => {
    const config = await callTool(client, 'server_config');
    const expectedCliCodexDir = path.join(config.structuredContent.defaultRoot, '.codex');
    if (config.structuredContent.codexDir !== expectedCliCodexDir) {
      throw new Error(`relative --codex-dir resolved to ${config.structuredContent.codexDir}, expected ${expectedCliCodexDir}`);
    }
  });
} finally {
  cliChild.kill('SIGTERM');
  await waitForExit(cliChild).catch(() => {});
}

console.log('✓ http smoke test passed');
