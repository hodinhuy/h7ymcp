import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function normalizeStartArgv(argv) {
  const normalized = [...argv];
  if (normalized[0] === 'stable') {
    normalized.shift();
    normalized.unshift('--tunnel', 'cloudflare-named');
  }
  if (normalized[0] === 'ngrok') {
    normalized.shift();
    normalized.unshift('--tunnel', 'ngrok');
  }
  if (normalized[0] === 'start' || normalized[0] === 'connect') normalized.shift();
  if (normalized[0] === 'help') normalized[0] = '--help';
  return normalized;
}

function connectorOptions(base, overrides = {}) {
  return {
    authMode: base.authMode,
    localBase: base.localBase,
    openChatgpt: base.openChatgpt,
    mode: base.mode,
    toolMode: base.toolMode,
    root: base.root,
    write: base.write,
    bash: base.bash,
    bashTranscript: base.bashTranscript,
    codexSessions: base.codexSessions,
    bashSession: base.bashSession,
    requireBashSession: base.requireBashSession,
    toolCards: base.toolCards,
    ...overrides
  };
}

function buildServerEnv(context, deps) {
  const { processEnv = process.env } = deps;
  const {
    root,
    allowRoots,
    host,
    port,
    bash,
    bashTranscript,
    bashSession,
    requireBashSession,
    codexSessions,
    write,
    toolMode,
    widgetDomain,
    toolCards,
    mode,
    tunnel,
    codexDir,
    args,
    authMode,
    oauthApprovalMode,
    token,
    editionEnv
  } = context;

  const serverEnv = {
    ...processEnv,
    PERSONAL_ROOT: root,
    PERSONAL_ALLOWED_ROOTS: allowRoots.join(path.delimiter),
    PERSONAL_HOST: host,
    PERSONAL_PORT: port,
    PERSONAL_BASH_MODE: bash,
    PERSONAL_BASH_TRANSCRIPT: bashTranscript,
    PERSONAL_BASH_SESSION_ID: bashSession,
    PERSONAL_REQUIRE_BASH_SESSION: requireBashSession ? '1' : '0',
    PERSONAL_CODEX_SESSIONS: codexSessions,
    PERSONAL_WRITE_MODE: write,
    PERSONAL_TOOL_MODE: toolMode,
    PERSONAL_WIDGET_DOMAIN: widgetDomain,
    PERSONAL_TOOL_CARDS: toolCards ? '1' : '0',
    PERSONAL_MODE: mode,
    PERSONAL_TUNNEL_MODE: tunnel === 'none' ? '0' : '1',
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: allowRoots.join(path.delimiter),
    CODEXPRO_HOST: host,
    CODEXPRO_PORT: port,
    CODEXPRO_BASH_MODE: bash,
    CODEXPRO_BASH_TRANSCRIPT: bashTranscript,
    CODEXPRO_BASH_SESSION_ID: bashSession,
    CODEXPRO_REQUIRE_BASH_SESSION: requireBashSession ? '1' : '0',
    CODEXPRO_CODEX_SESSIONS: codexSessions,
    CODEXPRO_WRITE_MODE: write,
    CODEXPRO_TOOL_MODE: toolMode,
    CODEXPRO_WIDGET_DOMAIN: widgetDomain,
    CODEXPRO_TOOL_CARDS: toolCards ? '1' : '0',
    CODEXPRO_MODE: mode,
    CODEXPRO_TUNNEL_MODE: tunnel === 'none' ? '0' : '1'
  };
  if (codexDir) serverEnv.CODEXPRO_CODEX_DIR = codexDir;
  if (args.logRequests || editionEnv('LOG_REQUESTS') === '1') {
    serverEnv.PERSONAL_LOG_REQUESTS = '1';
    serverEnv.CODEXPRO_LOG_REQUESTS = '1';
  }
  if (args.allowHome) {
    serverEnv.PERSONAL_ALLOW_HOME = '1';
    serverEnv.CODEXPRO_ALLOW_HOME = '1';
  }
  serverEnv.PERSONAL_HTTP_AUTH_MODE = authMode;
  serverEnv.CODEXPRO_HTTP_AUTH_MODE = authMode;
  serverEnv.PERSONAL_OAUTH_APPROVAL = oauthApprovalMode;
  serverEnv.CODEXPRO_OAUTH_APPROVAL = oauthApprovalMode;
  if (token) {
    serverEnv.PERSONAL_HTTP_TOKEN = token;
    serverEnv.CODEXPRO_HTTP_TOKEN = token;
  } else {
    delete serverEnv.PERSONAL_HTTP_TOKEN;
    delete serverEnv.CODEXPRO_HTTP_TOKEN;
  }
  return serverEnv;
}

export async function runStartCommand(argv, deps) {
  const {
    EDITION,
    projectRoot,
    usage,
    parseArgs,
    applyColorPreference,
    realDir,
    loadWorkspaceProfile,
    maybeConfigureFirstRun,
    statusLine,
    profileSummary,
    optionValue,
    envName,
    editionEnv,
    printStableUrlHelp,
    normalizeOauthApprovalChoice,
    writeOption,
    bashTranscriptOption,
    codexSessionsOption,
    resolveCodexDir,
    bashSessionOptions,
    optionBool,
    stableToken,
    assertPortAvailable,
    printStartSummary,
    spawnLogged,
    waitForHealth,
    resolveCloudflared,
    printConnectorBlock,
    runControlPanel,
    resolveNgrok,
    publicBaseFromHostname,
    ngrokConfigPath,
    waitForPublicHealth,
    waitForCloudflareUrl,
    resolveConfigPath,
    saveRuntimeConnection,
    cleanupChildren
  } = deps;

  const normalizedArgv = normalizeStartArgv(argv);
  const args = parseArgs(normalizedArgv);
  applyColorPreference(args);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  let profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  profile = await maybeConfigureFirstRun(root, args, profile);
  const effectiveArgs = { ...profile, ...args };
  if (profile.profilePath && !args.noProfile) {
    statusLine('ok', `Using saved profile: ${profile.profilePath}`);
    const summary = profileSummary(profile);
    if (summary) statusLine('ok', `${summary}. Future launches from this folder only need: ${EDITION.cliName} start`);
  }

  const tunnel = optionValue(args, profile, 'tunnel', [envName(EDITION.envPrefix, 'TUNNEL'), 'CODEXPRO_TUNNEL'], 'none');
  if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok'].includes(tunnel)) {
    throw new Error('--tunnel must be none, cloudflare, cloudflare-named, or ngrok');
  }
  const stableHostname = args.hostname
    ?? args.url
    ?? editionEnv('PUBLIC_HOSTNAME')
    ?? editionEnv('HOSTNAME')
    ?? process.env.NGROK_DOMAIN
    ?? profile.hostname
    ?? '';
  if (tunnel === 'cloudflare-named' && !stableHostname) {
    printStableUrlHelp();
    throw new Error('--hostname is required with stable URL mode.');
  }
  if (tunnel === 'ngrok' && !stableHostname) {
    throw new Error('--hostname is required with ngrok tunnel mode. Example: h7ymcp ngrok --hostname your-domain.ngrok-free.dev');
  }
  if (args.noAuth && tunnel !== 'none') {
    throw new Error('--no-auth is only allowed with --tunnel none. Public tunnels require CODEXPRO_HTTP_TOKEN.');
  }

  const rawAuthMode = String(args.auth ?? args.httpAuth ?? optionValue(args, profile, 'auth', [envName(EDITION.envPrefix, 'HTTP_AUTH_MODE'), 'CODEXPRO_HTTP_AUTH_MODE'], '')).trim().toLowerCase();
  let authMode = rawAuthMode || 'auto';
  if (args.noAuth) authMode = 'none';
  if (!['auto', 'none', 'bearer', 'oauth'].includes(authMode)) {
    throw new Error('--auth must be none, bearer, or oauth');
  }

  const configuredTokenValue = optionValue(args, profile, 'token', [envName(EDITION.envPrefix, 'HTTP_TOKEN'), 'CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
  const oauthApprovalFallback = configuredTokenValue ? 'token' : tunnel === 'none' ? 'manual' : 'token';
  const oauthApprovalMode = normalizeOauthApprovalChoice(
    optionValue(args, profile, 'oauthApproval', ['CODEXPRO_OAUTH_APPROVAL'], oauthApprovalFallback),
    oauthApprovalFallback
  );
  if (authMode === 'none' && tunnel !== 'none') {
    throw new Error('--auth none is only allowed with --tunnel none.');
  }

  const mode = optionValue(args, profile, 'mode', [envName(EDITION.envPrefix, 'MODE'), 'CODEXPRO_MODE'], 'agent');
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }

  const allowRoots = [root, ...(args.allowRoots ?? [])].map(realDir);
  const host = optionValue(args, profile, 'host', [envName(EDITION.envPrefix, 'HOST'), 'CODEXPRO_HOST'], '127.0.0.1');
  const port = String(optionValue(args, profile, 'port', [envName(EDITION.envPrefix, 'PORT'), 'CODEXPRO_PORT'], '8787'));
  const bash = optionValue(args, profile, 'bash', [envName(EDITION.envPrefix, 'BASH_MODE'), 'CODEXPRO_BASH_MODE'], 'safe');
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = resolveCodexDir(root, optionValue(args, profile, 'codexDir', [envName(EDITION.envPrefix, 'CODEX_DIR'), 'CODEXPRO_CODEX_DIR'], ''));
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = writeOption(args, profile, mode);
  const toolMode = optionValue(args, profile, 'toolMode', [envName(EDITION.envPrefix, 'TOOL_MODE'), 'CODEXPRO_TOOL_MODE'], 'standard');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', [envName(EDITION.envPrefix, 'WIDGET_DOMAIN'), 'CODEXPRO_WIDGET_DOMAIN'], EDITION.defaultWidgetDomain);
  const toolCards = optionBool(args, profile, 'toolCards', [envName(EDITION.envPrefix, 'TOOL_CARDS'), 'CODEXPRO_TOOL_CARDS'], false);
  if (!['off', 'safe', 'full'].includes(bash)) throw new Error('--bash must be off, safe, or full');
  if (!['off', 'handoff', 'workspace'].includes(write)) throw new Error('--write must be off, handoff, or workspace');
  if (!['minimal', 'standard', 'full'].includes(toolMode)) throw new Error('--tool-mode must be minimal, standard, or full');

  let token = authMode === 'none' ? '' : configuredTokenValue;
  if (authMode === 'oauth' && oauthApprovalMode === 'manual' && tunnel === 'none') token = '';
  if (!token && tunnel !== 'none') token = stableToken();
  if (authMode === 'auto') authMode = token ? 'bearer' : 'none';

  const serverEnv = buildServerEnv({
    root,
    allowRoots,
    host,
    port,
    bash,
    bashTranscript,
    bashSession,
    requireBashSession,
    codexSessions,
    write,
    toolMode,
    widgetDomain,
    toolCards,
    mode,
    tunnel,
    codexDir,
    args,
    authMode,
    oauthApprovalMode,
    token,
    editionEnv
  }, {});

  if (args.printEnv) {
    console.log(JSON.stringify({ ...serverEnv, PERSONAL_HTTP_TOKEN: token ? '<redacted>' : undefined, CODEXPRO_HTTP_TOKEN: token ? '<redacted>' : undefined }, null, 2));
  }

  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  if (!fs.existsSync(httpPath)) {
    throw new Error(`Missing ${httpPath}. Run npm install && npm run build first.`);
  }

  await assertPortAvailable(host, port);

  printStartSummary({
    root,
    mode,
    write,
    bash,
    toolMode,
    toolCards,
    bashTranscript,
    codexSessions,
    bashSession,
    requireBashSession,
    localUrl: `http://${host}:${port}/mcp`,
    tunnel:
      tunnel === 'cloudflare'
        ? 'quick'
        : tunnel === 'cloudflare-named'
          ? `stable (${stableHostname})`
          : tunnel === 'ngrok'
            ? `ngrok (${stableHostname})`
            : 'none'
  });

  const verboseLogs = Boolean(args.logRequests || editionEnv('LOG_REQUESTS') === '1' || process.env.CODEXPRO_LOG_REQUESTS === '1');
  statusLine('wait', 'Starting local MCP server');
  spawnLogged(EDITION.cliName, process.execPath, [httpPath], { cwd: projectRoot, env: serverEnv, verbose: verboseLogs });
  let tunnelChild;
  process.on('SIGINT', () => { cleanupChildren(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupChildren(); process.exit(143); });

  const localBase = `http://${host}:${port}`;
  await waitForHealth(`${localBase}/healthz`, token);
  statusLine('ok', `Local MCP ready at ${localBase}/mcp`);

  const runtimeOptions = {
    localBase,
    tunnel,
    mode,
    toolMode,
    write,
    bash,
    bashTranscript,
    codexSessions,
    bashSession,
    requireBashSession,
    toolCards
  };
  const baseOptions = {
    authMode,
    localBase,
    openChatgpt: Boolean(args.openChatgpt),
    mode,
    toolMode,
    root,
    write,
    bash,
    bashTranscript,
    codexSessions,
    bashSession,
    requireBashSession,
    toolCards
  };

  if (tunnel === 'none') {
    if (effectiveArgs.installCloudflared) {
      const installedCloudflared = await resolveCloudflared(effectiveArgs);
      if (installedCloudflared) console.log(`cloudflared ready: ${installedCloudflared}`);
    }
    const details = printConnectorBlock(`${localBase}/mcp`, token, connectorOptions(baseOptions, {
      copyUrl: args.copyUrl ? true : args.noCopyUrl ? false : undefined
    }));
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details);
    return;
  }

  if (tunnel === 'ngrok') {
    const ngrokPath = resolveNgrok(effectiveArgs);
    const publicBase = publicBaseFromHostname(stableHostname);
    const ngrokArgs = ['http', localBase, '--url', publicBase];
    const configPath = ngrokConfigPath(root, effectiveArgs);
    if (configPath) ngrokArgs.push('--config', configPath);
    statusLine('wait', `Opening ngrok endpoint for ${publicBase}`);
    tunnelChild = spawnLogged('ngrok', ngrokPath, ngrokArgs, { cwd: root, env: process.env, verbose: verboseLogs });
    try {
      await waitForPublicHealth(publicBase, token, tunnelChild, 'ngrok');
    } catch (error) {
      const tail = typeof tunnelChild.codexproLogTail === 'function' ? tunnelChild.codexproLogTail() : '';
      const hint = [
        '',
        'Ngrok stable domains need one-time setup before this can succeed:',
        '',
        '  ngrok config add-authtoken <your-ngrok-token>',
        '  find your free ngrok dev domain in the ngrok dashboard',
        '  h7ymcp ngrok --hostname your-domain.ngrok-free.dev --token keep-this-stable-token',
        '',
        'If the domain is already in use, stop the other ngrok process or choose another reserved domain.'
      ].join('\n');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent ngrok output:\n${tail}` : ''}${hint}`);
    }
    const details = printConnectorBlock(`${publicBase}/mcp`, token, connectorOptions(baseOptions, {
      copyUrl: args.noCopyUrl ? false : true
    }));
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details);
    return;
  }

  const cloudflaredPath = await resolveCloudflared(effectiveArgs);
  if (!cloudflaredPath) {
    console.error('\ncloudflared was not found. The local MCP server is still running.');
    console.error('Install Cloudflare Tunnel, rerun without --no-install-cloudflared, or run with --tunnel none for local clients.');
    console.error('Downloads: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/');
    const details = printConnectorBlock(`${localBase}/mcp`, token, connectorOptions(baseOptions, {
      copyUrl: args.copyUrl ? true : false
    }));
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details);
    return;
  }

  if (tunnel === 'cloudflare') {
    statusLine('wait', 'Opening Cloudflare quick tunnel');
    tunnelChild = spawnLogged('cloudflared', cloudflaredPath, ['tunnel', '--url', localBase], { cwd: root, env: process.env, verbose: verboseLogs });
    const publicBase = await waitForCloudflareUrl(tunnelChild);
    const details = printConnectorBlock(`${publicBase}/mcp`, token, connectorOptions(baseOptions, {
      copyUrl: args.noCopyUrl ? false : true
    }));
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details);
    return;
  }

  const publicBase = publicBaseFromHostname(stableHostname);
  const tunnelName = optionValue(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'CODEXPRO_TUNNEL_NAME'], '');
  const cloudflareConfig = resolveConfigPath(root, optionValue(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'CODEXPRO_CLOUDFLARE_CONFIG'], ''));
  const cloudflareTokenFile = resolveConfigPath(root, optionValue(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE'], ''));
  const cloudflareToken = optionValue(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN'], '');

  const cloudflaredArgs = ['tunnel'];
  if (cloudflareConfig) {
    cloudflaredArgs.push('--config', cloudflareConfig, 'run');
    if (tunnelName) cloudflaredArgs.push(tunnelName);
  } else {
    cloudflaredArgs.push('run', '--url', localBase);
    if (cloudflareTokenFile) {
      cloudflaredArgs.push('--token-file', cloudflareTokenFile);
    } else if (cloudflareToken) {
      // Passed to cloudflared through the child environment below.
    } else {
      if (!tunnelName) {
        throw new Error('--tunnel-name, --cloudflare-token, --cloudflare-token-file, or --cloudflare-config is required with --tunnel cloudflare-named.');
      }
      cloudflaredArgs.push(tunnelName);
    }
  }

  statusLine('wait', `Starting Cloudflare named tunnel for ${publicBase}`);
  const cloudflaredEnv = cloudflareToken && !cloudflareTokenFile
    ? { ...process.env, TUNNEL_TOKEN: cloudflareToken }
    : process.env;
  tunnelChild = spawnLogged('cloudflared', cloudflaredPath, cloudflaredArgs, { cwd: root, env: cloudflaredEnv, verbose: verboseLogs });
  try {
    await waitForPublicHealth(publicBase, token, tunnelChild);
  } catch (error) {
    const tail = typeof tunnelChild.codexproLogTail === 'function' ? tunnelChild.codexproLogTail() : '';
    const hint = [
      '',
      'Named Cloudflare tunnels need one-time setup before this can succeed:',
      '',
      '  cloudflared tunnel login',
      '  cloudflared tunnel create <tunnel-name>',
      '  cloudflared tunnel route dns <tunnel-name> <hostname>',
      '',
      'Or create a remotely managed tunnel in the Cloudflare dashboard and pass:',
      '',
      '  --cloudflare-token-file ~/.codexpro/cloudflare-tunnel-token',
      '',
      'Quick tunnels do not support a permanent hostname. Use --tunnel cloudflare only for demos.'
    ].join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent cloudflared output:\n${tail}` : ''}${hint}`);
  }
  const details = printConnectorBlock(`${publicBase}/mcp`, token, connectorOptions(baseOptions, {
    copyUrl: args.noCopyUrl ? false : true
  }));
  saveRuntimeConnection(root, details, runtimeOptions);
  await runControlPanel(details);
}
