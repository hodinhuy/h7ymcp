import process from 'node:process';
import { createInterface } from 'node:readline/promises';

function printProfile(root, profile, deps) {
  const { printBox, labelValue, sanitizedProfile } = deps;
  if (!profile.profilePath) {
    printBox('H7Y MCP settings', [
      labelValue('Workspace', root),
      'No saved settings for this workspace.',
      'Run h7ymcp settings set or h7ymcp setup to save a tunnel preference.'
    ]);
    return;
  }
  const safe = sanitizedProfile(profile);
  printBox('H7Y MCP settings', [
    labelValue('Workspace', root),
    labelValue('Profile', profile.profilePath),
    labelValue('Tunnel', safe.tunnel ?? 'cloudflare'),
    ...(safe.auth ? [labelValue('Auth', safe.auth)] : []),
    ...(safe.auth === 'oauth' && safe.oauthApproval ? [labelValue('OAuth approval', safe.oauthApproval)] : []),
    ...(safe.hostname ? [labelValue('Hostname', safe.hostname)] : []),
    ...(safe.tunnelName ? [labelValue('Tunnel name', safe.tunnelName)] : []),
    ...(safe.ngrokConfig ? [labelValue('Ngrok config', safe.ngrokConfig)] : []),
    ...(safe.cloudflareConfig ? [labelValue('Cloudflare cfg', safe.cloudflareConfig)] : []),
    ...(safe.cloudflareTokenFile ? [labelValue('CF token file', safe.cloudflareTokenFile)] : []),
    ...(safe.port ? [labelValue('Port', safe.port)] : []),
    ...(safe.mode ? [labelValue('Mode', safe.mode)] : []),
    ...(safe.bash ? [labelValue('Bash', safe.bash)] : []),
    ...(safe.write ? [labelValue('Write', safe.write)] : []),
    ...(safe.toolMode ? [labelValue('Tool mode', safe.toolMode)] : []),
    ...(safe.toolCards !== undefined ? [labelValue('Tool cards', safe.toolCards ? 'on' : 'off')] : []),
    labelValue('Bash transcript', safe.bashTranscript ?? 'compact'),
    labelValue('Codex sessions', safe.codexSessions ?? 'off'),
    ...(safe.codexDir ? [labelValue('Codex dir', safe.codexDir)] : []),
    ...(safe.bashSession ? [labelValue('Bash session', `${safe.bashSession}${safe.requireBashSession ? ' required' : ''}`)] : []),
    ...(safe.widgetDomain ? [labelValue('Widget origin', safe.widgetDomain)] : []),
    ...(safe.noInstallCloudflared ? [labelValue('cloudflared', 'manual install only')] : []),
    ...(safe.token ? [labelValue('Token', safe.token)] : []),
    ...(safe.cloudflareToken ? [labelValue('Cloudflare token', safe.cloudflareToken)] : [])
  ]);
}

function printProfileList(profiles, deps) {
  const { printBox, listWorkspaceProfiles, profileOneLine } = deps;
  const resolvedProfiles = profiles ?? listWorkspaceProfiles();
  if (!resolvedProfiles.length) {
    printBox('H7Y MCP saved setups', [
      'No saved workspace settings found.',
      'Run h7ymcp setup or h7ymcp settings set to create one.'
    ]);
    return;
  }
  printBox('H7Y MCP saved setups', resolvedProfiles.slice(0, 50).map((profile, index) => profileOneLine(profile, index + 1)));
}

function saveSettingsFromArgs(root, args, profile, deps) {
  const {
    optionValue,
    normalizeAuthModeChoice,
    normalizeOauthApprovalChoice,
    bashTranscriptOption,
    codexSessionsOption,
    bashSessionOptions,
    writeOption,
    resolveConfigPath,
    stableToken,
    saveWorkspaceProfile,
    loadWorkspaceProfile,
    statusLine,
    toolCardsProfileEntry
  } = deps;

  if (args.cloudflareToken !== undefined) {
    throw new Error('h7ymcp settings set does not save raw --cloudflare-token. Save it to a local file and use --cloudflare-token-file <path>; start still accepts --cloudflare-token for a single launch.');
  }
  const tunnel = optionValue(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], profile.tunnel ?? 'cloudflare');
  if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok'].includes(tunnel)) {
    throw new Error('--tunnel must be none, cloudflare, cloudflare-named, or ngrok');
  }
  const hostname = args.hostname ?? args.url ?? profile.hostname ?? '';
  if ((tunnel === 'ngrok' || tunnel === 'cloudflare-named') && !hostname) {
    throw new Error('--hostname is required for ngrok and cloudflare-named settings.');
  }
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], profile.mode ?? 'agent');
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }
  const auth = normalizeAuthModeChoice(optionValue(args, profile, 'auth', ['CODEXPRO_HTTP_AUTH_MODE'], profile.auth ?? (tunnel === 'none' ? 'none' : 'oauth')), tunnel === 'none' ? 'none' : 'oauth');
  const savedTokenValue = optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], profile.token ?? '');
  const oauthApprovalFallback = savedTokenValue ? 'token' : tunnel === 'none' ? 'manual' : 'token';
  const oauthApproval = normalizeOauthApprovalChoice(optionValue(args, profile, 'oauthApproval', ['CODEXPRO_OAUTH_APPROVAL'], profile.oauthApproval ?? oauthApprovalFallback), oauthApprovalFallback);
  const toolMode = optionValue(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], profile.toolMode ?? '');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], profile.widgetDomain ?? '');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], profile.port ?? '8787'));
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = optionValue(args, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], profile.codexDir ?? '');
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = writeOption(args, profile, mode);
  const tunnelName = args.tunnelName ?? profile.tunnelName ?? '';
  const ngrokConfig = resolveConfigPath(root, args.ngrokConfig ?? profile.ngrokConfig ?? '');
  const cloudflareConfig = resolveConfigPath(root, args.cloudflareConfig ?? profile.cloudflareConfig ?? '');
  const cloudflareTokenFile = resolveConfigPath(root, args.cloudflareTokenFile ?? profile.cloudflareTokenFile ?? '');
  const rawToken = savedTokenValue;
  const token = auth === 'oauth' && oauthApproval === 'manual' && tunnel === 'none'
    ? ''
    : tunnel === 'none'
      ? rawToken
      : stableToken(rawToken);
  const savedPath = saveWorkspaceProfile(root, {
    port,
    mode,
    tunnel,
    auth,
    ...(auth === 'oauth' ? { oauthApproval } : {}),
    ...(hostname ? { hostname } : {}),
    ...(tunnelName ? { tunnelName } : {}),
    ...(ngrokConfig ? { ngrokConfig } : {}),
    ...(cloudflareConfig ? { cloudflareConfig } : {}),
    ...(cloudflareTokenFile ? { cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(args.bash ?? profile.bash ? { bash: args.bash ?? profile.bash } : {}),
    ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
    ...(codexSessions !== 'off' ? { codexSessions } : {}),
    ...(codexDir ? { codexDir } : {}),
    ...(bashSession ? { bashSession } : {}),
    ...(requireBashSession ? { requireBashSession: true } : {}),
    ...(mode !== 'agent' || args.write !== undefined || profile.write ? { write } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(widgetDomain ? { widgetDomain } : {}),
    ...toolCardsProfileEntry(args, profile),
    ...(args.noInstallCloudflared ?? profile.noInstallCloudflared ? { noInstallCloudflared: true } : {})
  });
  statusLine('ok', `Saved workspace settings: ${savedPath}`);
  printProfile(root, loadWorkspaceProfile(root), deps);
}

async function chooseReusableProfile(rl, currentRoot, deps, profiles) {
  const { listWorkspaceProfiles, printProfileList, ask } = deps;
  const reusable = (profiles ?? listWorkspaceProfiles()).filter((item) => item.root !== currentRoot);
  if (!reusable.length) return null;
  printProfileList(reusable, deps);
  const answer = await ask(rl, 'Use saved setup number?', reusable.length === 1 ? '1' : '');
  const selectedIndex = Number(answer.trim());
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > reusable.length) {
    throw new Error('Invalid saved setup number.');
  }
  return reusable[selectedIndex - 1];
}

export async function runSettingsCommand(argv, deps) {
  const {
    parseArgs,
    applyColorPreference,
    usage,
    realDir,
    loadWorkspaceProfile,
    statusLine,
    deleteWorkspaceProfile,
    saveWorkspaceProfile,
    reusableProfilePayload,
    normalizeSetupChoice,
    collectTunnelPreference,
    profileFromPreference,
    ask
  } = deps;

  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
  const args = parseArgs(action ? argv.slice(1) : argv);
  applyColorPreference(args);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);

  const localDeps = { ...deps, ask, printProfile, printProfileList, saveSettingsFromArgs, chooseReusableProfile };

  if (action === 'list' || action === 'ls') {
    printProfileList(undefined, localDeps);
    return;
  }

  if (action === 'show' || (!action && !process.stdin.isTTY)) {
    printProfile(root, profile, localDeps);
    return;
  }

  if (action === 'delete' || action === 'reset' || action === 'remove') {
    if (!profile.profilePath) {
      statusLine('warn', 'No saved settings exist for this workspace.');
      return;
    }
    if (!args.yes && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
          statusLine('warn', 'Settings delete cancelled.');
          return;
        }
      } finally {
        rl.close();
      }
    } else if (!args.yes) {
      throw new Error('Use h7ymcp settings delete --yes in non-interactive shells.');
    }
    deleteWorkspaceProfile(root);
    statusLine('ok', 'Deleted saved settings for this workspace.');
    return;
  }

  if (action === 'set') {
    saveSettingsFromArgs(root, args, profile, localDeps);
    return;
  }

  if (action === 'use' || action === 'copy') {
    const fromRoot = args.fromRoot ? realDir(args.fromRoot) : '';
    let source = fromRoot ? loadWorkspaceProfile(fromRoot) : null;
    if (fromRoot && !source.profilePath) {
      throw new Error(`No saved settings found for --from-root ${fromRoot}`);
    }
    if (!source) {
      if (!process.stdin.isTTY) throw new Error('Use --from-root in non-interactive shells.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        source = await chooseReusableProfile(rl, root, localDeps);
      } finally {
        rl.close();
      }
    }
    if (!source) {
      statusLine('warn', 'No reusable saved settings found.');
      return;
    }
    const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
    statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root), localDeps);
    return;
  }

  if (action && !['change', 'edit'].includes(action)) {
    throw new Error(`Unknown settings action: ${action}`);
  }

  if (!process.stdin.isTTY) {
    printProfile(root, profile, localDeps);
    return;
  }

  printProfile(root, profile, localDeps);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const selected = await ask(rl, 'Action: set, use, delete, show, list, or exit?', profile.profilePath ? 'show' : 'set');
    const normalized = normalizeSetupChoice(selected, ['set', 'use', 'delete', 'show', 'list', 'exit'], profile.profilePath ? 'show' : 'set');
    if (normalized === 'exit') return;
    if (normalized === 'list') {
      printProfileList(undefined, localDeps);
      return;
    }
    if (normalized === 'show') {
      printProfile(root, profile, localDeps);
      return;
    }
    if (normalized === 'use') {
      const source = await chooseReusableProfile(rl, root, localDeps);
      if (!source) {
        statusLine('warn', 'No reusable saved settings found.');
        return;
      }
      const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
      statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
      printProfile(root, loadWorkspaceProfile(root), localDeps);
      return;
    }
    if (normalized === 'delete') {
      if (!profile.profilePath) {
        statusLine('warn', 'No saved settings exist for this workspace.');
        return;
      }
      const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        statusLine('warn', 'Settings delete cancelled.');
        return;
      }
      deleteWorkspaceProfile(root);
      statusLine('ok', 'Deleted saved settings for this workspace.');
      return;
    }

    const preference = await collectTunnelPreference(rl, args, profile);
    const payload = profileFromPreference(root, args, profile, preference);
    const savedPath = saveWorkspaceProfile(root, payload);
    statusLine('ok', `Saved workspace settings: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root), localDeps);
  } finally {
    rl.close();
  }
}
