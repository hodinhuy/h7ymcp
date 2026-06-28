import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

function printSetupSummary(config, deps) {
  const {
    EDITION,
    panelDivider,
    panelTitle,
    panelLine,
    paint,
    displayPath,
    panelKeyValue,
    formatCommandBlock
  } = deps;

  console.log('');
  panelDivider();
  panelTitle(EDITION.productName);
  panelLine('');
  if (config.savedPath) {
    panelLine(`${paint(['brightGreen', 'bold'], '✓')} ${paint(['bold'], 'Profile saved')}`);
    panelLine(`  ${displayPath(config.savedPath)}`);
  } else {
    panelLine(`${paint(['brightYellow', 'bold'], '!')} ${paint(['brightYellow', 'bold'], 'Profile not saved')}`);
  }
  panelLine('');
  panelTitle('Configuration', { bold: false });
  panelLine('');
  const configRows = [
    ['Workspace', config.root],
    ['Mode', config.mode],
    ['Write mode', config.write],
    ['Bash mode', config.bash],
    ['Tool mode', config.toolMode],
    ['Tool cards', config.toolCards ? 'html on' : 'off'],
    ['Tunnel', config.tunnel]
  ];
  for (const [label, value] of configRows) {
    let valueStyle;
    if (label === 'Mode' && value === 'agent') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Write mode' && value === 'workspace') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Tool cards' && value === 'html on') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Tool cards' && value === 'off') valueStyle = ['bold', 'brightYellow'];
    else if (label === 'Tunnel' && value === 'none') valueStyle = ['bold', 'brightYellow'];
    panelKeyValue(label, value, { valueStyle });
  }
  panelLine('');
  panelTitle('Start command', { bold: false });
  panelLine('');
  for (const line of formatCommandBlock(config.commandArgs)) {
    panelLine(`${paint(['dim'], '$ ')}${line}`);
  }
  panelLine('');
  panelTitle('Local URL', { bold: false });
  panelLine('');
  panelLine(config.localUrl);
  panelLine('');
  panelTitle('Next steps', { bold: false });
  panelLine('');
  const steps = config.shouldStart
    ? [
        '1. Keep this terminal running.',
        '2. Add the Server URL in ChatGPT Developer Mode.',
        `3. Use ${EDITION.productName} from ChatGPT.`
      ]
    : [
        '1. Run the start command above.',
        '2. Add the Server URL in ChatGPT Developer Mode.',
        `3. Use ${EDITION.productName} from ChatGPT.`
      ];
  for (const step of steps) panelLine(step);
  panelDivider();
}

function commandPreview(args) {
  return ['codexpro', ...args].map((part) => {
    if (/^[A-Za-z0-9_./:@=-]+$/.test(part)) return part;
    return JSON.stringify(part);
  }).join(' ');
}

export async function maybeConfigureFirstRunCommand(root, args, profile, deps) {
  const {
    ask,
    hasExplicitTunnelInput,
    listWorkspaceProfiles,
    printBox,
    profileOneLine,
    reusableProfilePayload,
    optionValue,
    saveWorkspaceProfile,
    statusLine,
    loadWorkspaceProfile,
    collectTunnelPreference,
    applyTunnelPreferenceToArgs,
    profileFromPreference
  } = deps;

  if (profile.profilePath || !process.stdin.isTTY || !process.stdout.isTTY || process.env.CI || hasExplicitTunnelInput(args)) {
    return profile;
  }

  const reusableProfiles = listWorkspaceProfiles().filter((item) => item.root !== root);
  if (reusableProfiles.length) {
    const shown = reusableProfiles.slice(0, 9);
    printBox('Saved setups', [
      'No saved settings exist for this workspace, but H7Y MCP found saved setups from other workspaces.',
      ...shown.map((item, index) => profileOneLine(item, index + 1)),
      'Use a number to reuse one here, or type new to choose a fresh tunnel.'
    ]);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await ask(rl, 'Use saved setup number, or new?', shown.length === 1 ? '1' : 'new');
      const normalized = answer.trim().toLowerCase();
      const selectedIndex = Number(normalized);
      if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= shown.length) {
        const selected = shown[selectedIndex - 1];
        const payload = reusableProfilePayload(selected, {
          port: String(optionValue(args, selected, 'port', ['CODEXPRO_PORT'], selected.port ?? '8787')),
          mode: optionValue(args, selected, 'mode', ['CODEXPRO_MODE'], selected.mode ?? 'agent')
        });
        const savedPath = saveWorkspaceProfile(root, payload);
        statusLine('ok', `Saved workspace settings from ${selected.root}: ${savedPath}`);
        return loadWorkspaceProfile(root);
      }
    } finally {
      rl.close();
    }
  }

  printBox('First run setup', [
    'No saved tunnel preference exists for this workspace.',
    'Choose once now. H7Y MCP will reuse this choice on future h7ymcp start runs until you change or delete it with h7ymcp settings.'
  ]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const preference = await collectTunnelPreference(rl, args, profile, { defaultTunnel: 'cloudflare' });
    applyTunnelPreferenceToArgs(args, preference);
    const saveAnswer = await ask(rl, 'Save this as the default for this workspace?', 'yes');
    if (!['n', 'no'].includes(saveAnswer.trim().toLowerCase())) {
      const savedPath = saveWorkspaceProfile(root, profileFromPreference(root, args, profile, preference));
      statusLine('ok', `Saved workspace settings: ${savedPath}`);
      return loadWorkspaceProfile(root);
    }
    return profileFromPreference(root, args, profile, preference);
  } finally {
    rl.close();
  }
}

export async function runSetupWizardCommand(argv, deps) {
  const {
    EDITION,
    parseArgs,
    applyColorPreference,
    expandHome,
    realDir,
    loadWorkspaceProfile,
    statusLine,
    printSavedProfileHint,
    optionValue,
    normalizeSetupChoice,
    printBox,
    normalizeAuthModeChoice,
    normalizeOauthApprovalChoice,
    bashTranscriptOption,
    codexSessionsOption,
    optionalWriteOption,
    bashSessionOptions,
    envName,
    optionBool,
    stableToken,
    ask,
    effectiveWriteMode,
    saveWorkspaceProfile,
    paint,
    displayPath,
    panelDivider,
    panelTitle,
    panelLine,
    panelKeyValue,
    formatCommandBlock
  } = deps;

  if (!process.stdin.isTTY) {
    throw new Error('h7ymcp setup needs an interactive terminal. Use h7ymcp start --root /path/to/repo for non-interactive scripts.');
  }
  const defaults = parseArgs(argv);
  applyColorPreference(defaults);
  const defaultRoot = path.resolve(expandHome(defaults.root ?? process.env.CODEXPRO_ROOT ?? process.cwd()));

  printBox('H7Y MCP setup', [
    'This wizard prepares a ChatGPT connector for the folder you choose.',
    'Press Enter to accept defaults. Stable tunnel choices are saved per workspace under ~/.codexpro.'
  ]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const rootInput = await ask(rl, 'Where is your project located?', defaultRoot);
    const root = realDir(rootInput);
    const profile = defaults.noProfile ? {} : loadWorkspaceProfile(root);
    if (profile.profilePath) {
      statusLine('ok', `Loaded saved profile: ${profile.profilePath}`);
      printSavedProfileHint(profile);
    }

    const savedTunnel = optionValue(defaults, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
    const defaultTunnel = savedTunnel === 'cloudflare-named'
      ? 'stable'
      : savedTunnel === 'ngrok'
        ? 'ngrok'
        : savedTunnel === 'none'
          ? 'local'
          : 'quick';
    const defaultPort = String(optionValue(defaults, profile, 'port', ['CODEXPRO_PORT'], '8787'));
    const defaultMode = normalizeSetupChoice(optionValue(defaults, profile, 'mode', ['CODEXPRO_MODE'], 'agent'), ['agent', 'handoff', 'pro'], 'agent');

    const port = await ask(rl, 'Which local port should H7Y MCP use?', defaultPort);
    if (!/^\d+$/.test(port)) throw new Error('Port must be a number.');
    const modeAnswer = await ask(rl, 'Mode: agent, handoff, or pro?', defaultMode);
    const mode = normalizeSetupChoice(modeAnswer, ['agent', 'handoff', 'pro'], defaultMode);

    printBox('Public URL', [
      'ChatGPT needs an HTTPS URL it can reach.',
      'quick  = H7Y MCP creates a Cloudflare quick tunnel for demos and local work.',
      'stable = use your own domain with a Cloudflare named tunnel so the ChatGPT app URL does not change.',
      'ngrok  = use your ngrok free dev domain, for example https://name.ngrok-free.dev.',
      'local  = no tunnel, only useful for local MCP clients that can reach 127.0.0.1.'
    ]);

    const tunnelAnswer = await ask(rl, 'Public access: quick, stable, ngrok, or local?', defaultTunnel);
    const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['quick', 'stable', 'ngrok', 'local'], defaultTunnel);
    const authFallback = tunnelChoice === 'local' ? 'none' : 'oauth';
    const savedAuth = normalizeAuthModeChoice(optionValue(defaults, profile, 'auth', ['CODEXPRO_HTTP_AUTH_MODE'], authFallback), authFallback);
    const existingProfileToken = optionValue(defaults, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
    const oauthApprovalFallback = existingProfileToken ? 'token' : tunnelChoice === 'local' ? 'manual' : 'token';
    printBox('Authentication', [
      'oauth  = best fit for ChatGPT connectors. ChatGPT discovers OAuth metadata from your MCP URL.',
      'bearer = use a raw Authorization header when your MCP client supports custom headers.',
      'none   = local-only or trusted setups without auth.'
    ]);
    const authAnswer = await ask(rl, 'Authentication: oauth, bearer, or none?', savedAuth);
    const authMode = normalizeAuthModeChoice(authAnswer, savedAuth);
    const args = ['start', '--root', root, '--port', port, '--mode', mode];
    args.push('--auth', authMode);
    let oauthApprovalMode = normalizeOauthApprovalChoice(
      optionValue(defaults, profile, 'oauthApproval', ['CODEXPRO_OAUTH_APPROVAL'], profile.oauthApproval ?? oauthApprovalFallback),
      oauthApprovalFallback
    );
    if (authMode === 'oauth') {
      printBox('OAuth approval', [
        'token  = browser approval requires a token from this launcher; safest for public tunnel URLs.',
        'manual = browser shows plain Approve / Deny without asking for a token.'
      ]);
      const approvalAnswer = await ask(rl, 'OAuth approval: token or manual?', oauthApprovalMode);
      oauthApprovalMode = normalizeOauthApprovalChoice(approvalAnswer, oauthApprovalMode);
      args.push('--oauth-approval', oauthApprovalMode);
    }
    const bash = optionValue(defaults, profile, 'bash', ['CODEXPRO_BASH_MODE'], '');
    const bashTranscript = bashTranscriptOption(defaults, profile);
    const codexSessions = codexSessionsOption(defaults, profile);
    const codexDir = optionValue(defaults, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], '');
    const write = optionalWriteOption(defaults, profile, mode);
    const toolMode = optionValue(defaults, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], '');
    const widgetDomain = optionValue(defaults, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], '');
    printBox('Tool cards', [
      'HTML tool cards let ChatGPT render richer result cards for supported tools.',
      'Turn this on when you want widget-style cards instead of text-only tool output.'
    ]);
    const defaultToolCards = optionBool(
      defaults,
      profile,
      'toolCards',
      [envName(EDITION.envPrefix, 'TOOL_CARDS'), 'CODEXPRO_TOOL_CARDS'],
      false
    );
    const toolCardsAnswer = await ask(rl, 'HTML tool cards: on or off?', defaultToolCards ? 'on' : 'off');
    const toolCards = ['on', 'yes', 'y', 'true', '1'].includes(toolCardsAnswer.trim().toLowerCase());
    const toolCardsEntry = { toolCards };
    if (bash) args.push('--bash', bash);
    if (bashTranscript !== 'compact') args.push('--bash-transcript', bashTranscript);
    if (codexSessions !== 'off') args.push('--codex-sessions', codexSessions);
    if (codexDir) args.push('--codex-dir', codexDir);
    const { bashSession, requireBashSession } = bashSessionOptions(defaults, profile);
    if (bashSession) args.push('--bash-session', bashSession);
    if (requireBashSession) args.push('--require-bash-session');
    if (write) args.push('--write', write);
    if (toolMode) args.push('--tool-mode', toolMode);
    if (widgetDomain) args.push('--widget-domain', widgetDomain);
    args.push('--tool-cards', toolCards ? 'on' : 'off');
    if (defaults.color) args.push('--color', defaults.color);
    if (defaults.noInstallCloudflared) args.push('--no-install-cloudflared');
    if (defaults.openChatgpt) args.push('--open-chatgpt');
    if (defaults.noCopyUrl) args.push('--no-copy-url');

    let profileTunnel = 'cloudflare';
    let profileHostname = '';
    let profileTunnelName = '';
    let profileNgrokConfig = '';
    let profileCloudflareConfig = '';
    let profileCloudflareTokenFile = '';
    let profileToken = existingProfileToken;

    if (tunnelChoice === 'local') {
      profileTunnel = 'none';
      args.push('--tunnel', 'none');
    } else if (tunnelChoice === 'stable') {
      profileTunnel = 'cloudflare-named';
      const hostname = await ask(
        rl,
        'Stable Cloudflare hostname, without /mcp',
        optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME'], '')
      );
      if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example codexpro.yourdomain.com.');
      profileHostname = hostname;
      const tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValue(defaults, profile, 'tunnelName', ['CODEXPRO_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'codexpro'));
      profileTunnelName = tunnelName;
      args.push('--tunnel', 'cloudflare-named', '--hostname', hostname, '--tunnel-name', tunnelName);
      profileCloudflareConfig = optionValue(defaults, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
      profileCloudflareTokenFile = optionValue(defaults, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
      if (profileCloudflareConfig) args.push('--cloudflare-config', profileCloudflareConfig);
      if (profileCloudflareTokenFile) args.push('--cloudflare-token-file', profileCloudflareTokenFile);
    } else if (tunnelChoice === 'ngrok') {
      profileTunnel = 'ngrok';
      const hostname = await ask(
        rl,
        'Ngrok domain or URL, without /mcp',
        optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'NGROK_DOMAIN'], '')
      );
      if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
      profileHostname = hostname;
      args.push('--tunnel', 'ngrok', '--hostname', hostname);
      const ngrokConfig = optionValue(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
      if (ngrokConfig) {
        profileNgrokConfig = ngrokConfig;
        args.push('--ngrok-config', ngrokConfig);
      }
    } else {
      profileTunnel = 'cloudflare';
      args.push('--tunnel', 'cloudflare');
    }

    if (authMode !== 'none' && !(authMode === 'oauth' && oauthApprovalMode === 'manual' && tunnelChoice === 'local')) {
      const tokenPrompt = authMode === 'oauth'
        ? tunnelChoice === 'local' && oauthApprovalMode === 'manual'
          ? 'Optional bearer token for trusted local manual approval'
          : oauthApprovalMode === 'manual'
            ? 'Bearer token for this public OAuth workspace'
            : 'Approval token for OAuth setup'
        : 'Bearer auth token for this workspace';
      profileToken = await ask(rl, tokenPrompt, stableToken(profileToken));
      if (profileToken) args.push('--token', profileToken);
    }

    const saveDefault = defaults.noSaveConfig ? 'no' : 'yes';
    const saveAnswer = await ask(rl, 'Save this setup for future runs from this workspace?', saveDefault);
    const shouldSave = !['n', 'no'].includes(saveAnswer.trim().toLowerCase());
    const resolvedBash = bash || 'safe';
    const resolvedWrite = write || effectiveWriteMode(mode, '');
    const resolvedToolMode = toolMode || 'standard';
    const resolvedHost = optionValue(defaults, profile, 'host', [envName(EDITION.envPrefix, 'HOST'), 'CODEXPRO_HOST'], '127.0.0.1');
    const resolvedTunnel = profileTunnel === 'cloudflare-named' ? 'stable' : profileTunnel === 'cloudflare' ? 'quick' : profileTunnel;
    let savedPath = '';
    if (shouldSave) {
      savedPath = saveWorkspaceProfile(root, {
        port,
        mode,
        tunnel: profileTunnel,
        auth: authMode,
        ...(authMode === 'oauth' ? { oauthApproval: oauthApprovalMode } : {}),
        ...(profileHostname ? { hostname: profileHostname } : {}),
        ...(profileTunnelName ? { tunnelName: profileTunnelName } : {}),
        ...(profileNgrokConfig ? { ngrokConfig: profileNgrokConfig } : {}),
        ...(profileCloudflareConfig ? { cloudflareConfig: profileCloudflareConfig } : {}),
        ...(profileCloudflareTokenFile ? { cloudflareTokenFile: profileCloudflareTokenFile } : {}),
        ...(profileToken ? { token: profileToken } : {}),
        ...(bash ? { bash } : {}),
        ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
        ...(codexSessions !== 'off' ? { codexSessions } : {}),
        ...(codexDir ? { codexDir } : {}),
        ...(bashSession ? { bashSession } : {}),
        ...(requireBashSession ? { requireBashSession: true } : {}),
        ...(write ? { write } : {}),
        ...(toolMode ? { toolMode } : {}),
        ...(widgetDomain ? { widgetDomain } : {}),
        ...toolCardsEntry,
        ...(defaults.noInstallCloudflared ? { noInstallCloudflared: true } : {})
      });
    }

    const startAnswer = await ask(rl, 'Start H7Y MCP now?', 'yes');
    const shouldStart = !['n', 'no'].includes(startAnswer.trim().toLowerCase());
    printSetupSummary({
      savedPath,
      root,
      mode,
      write: resolvedWrite,
      bash: resolvedBash,
      toolMode: resolvedToolMode,
      toolCards,
      tunnel: resolvedTunnel,
      localUrl: `http://${resolvedHost}:${port}/mcp`,
      commandArgs: args,
      shouldStart
    }, {
      EDITION,
      paint,
      displayPath,
      panelDivider,
      panelTitle,
      panelLine,
      panelKeyValue,
      formatCommandBlock
    });
    console.log('');
    if (!shouldStart) {
      statusLine('ok', 'Setup complete. Run the command above when you are ready.');
      return null;
    }
    return args;
  } finally {
    rl.close();
  }
}

export { commandPreview };
