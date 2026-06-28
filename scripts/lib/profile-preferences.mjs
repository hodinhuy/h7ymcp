import process from 'node:process';

export function normalizeSetupChoice(value, allowed, fallback) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  const match = allowed.find((item) => item === normalized || item.startsWith(normalized));
  return match ?? fallback;
}

export async function ask(rl, question, fallback = '', deps = {}) {
  const { paint = (value) => value } = deps;
  const suffix = fallback ? ` ${paint('dim', `[${fallback}]`)}` : '';
  const hint = fallback ? `${paint('dim', '> Enter to proceed with default')}\n` : '';
  const answer = await rl.question(`${paint('cyan', '?')} ${question}${suffix}\n${hint}> `);
  return answer.trim() || fallback;
}

export function tunnelChoiceFromProfile(profile, fallback = 'cloudflare') {
  if (profile?.tunnel === 'ngrok') return 'ngrok';
  if (profile?.tunnel === 'cloudflare-named') return 'stable';
  if (profile?.tunnel === 'none') return 'local';
  if (profile?.tunnel === 'cloudflare') return 'cloudflare';
  return fallback;
}

export function tunnelModeFromChoice(choice) {
  if (choice === 'quick' || choice === 'cloudflare') return 'cloudflare';
  if (choice === 'stable') return 'cloudflare-named';
  if (choice === 'local') return 'none';
  return choice;
}

export function hasExplicitTunnelInput(args) {
  return Boolean(
    args.tunnel ||
    args.noProfile ||
    process.env.CODEXPRO_TUNNEL
  );
}

export async function collectTunnelPreference(rl, defaults, profile, options = {}, deps) {
  const { ask: askFn, optionValue } = deps;
  const defaultTunnel = options.defaultTunnel ?? tunnelChoiceFromProfile(profile, 'cloudflare');
  const tunnelAnswer = await askFn(rl, 'Tunnel: cloudflare, ngrok, stable, or local?', defaultTunnel);
  const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['cloudflare', 'quick', 'ngrok', 'stable', 'local'], defaultTunnel);
  const tunnel = tunnelModeFromChoice(tunnelChoice);
  let hostname = '';
  let tunnelName = '';
  let ngrokConfig = '';
  let cloudflareConfig = '';
  let cloudflareTokenFile = '';

  if (tunnel === 'ngrok') {
    hostname = await askFn(
      rl,
      'Ngrok domain or URL, without /mcp',
      optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'NGROK_DOMAIN'], '')
    );
    if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
    ngrokConfig = optionValue(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
  } else if (tunnel === 'cloudflare-named') {
    hostname = await askFn(
      rl,
      'Stable Cloudflare hostname, without /mcp',
      optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME'], '')
    );
    if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example codexpro.yourdomain.com.');
    tunnelName = await askFn(rl, 'Cloudflare tunnel name', optionValue(defaults, profile, 'tunnelName', ['CODEXPRO_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'codexpro'));
    cloudflareConfig = optionValue(defaults, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
    cloudflareTokenFile = optionValue(defaults, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
  }

  return {
    tunnel,
    hostname,
    tunnelName,
    ngrokConfig,
    cloudflareConfig,
    cloudflareTokenFile
  };
}

export function applyTunnelPreferenceToArgs(args, preference) {
  args.tunnel = preference.tunnel;
  if (preference.hostname) args.hostname = preference.hostname;
  if (preference.tunnelName) args.tunnelName = preference.tunnelName;
  if (preference.ngrokConfig) args.ngrokConfig = preference.ngrokConfig;
  if (preference.cloudflareConfig) args.cloudflareConfig = preference.cloudflareConfig;
  if (preference.cloudflareTokenFile) args.cloudflareTokenFile = preference.cloudflareTokenFile;
}

export function profileFromPreference(root, args, profile, preference, deps) {
  const {
    optionValue,
    bashTranscriptOption,
    codexSessionsOption,
    bashSessionOptions,
    optionalWriteOption,
    normalizeAuthModeChoice,
    stableToken,
    toolCardsProfileEntry
  } = deps;

  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
  const bash = optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], '');
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = optionValue(args, profile, 'codexDir', ['CODEXPRO_CODEX_DIR'], '');
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = optionalWriteOption(args, profile, mode);
  const toolMode = optionValue(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], '');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['CODEXPRO_WIDGET_DOMAIN'], '');
  const auth = normalizeAuthModeChoice(optionValue(args, profile, 'auth', ['CODEXPRO_HTTP_AUTH_MODE'], preference.tunnel === 'none' ? 'none' : 'oauth'), preference.tunnel === 'none' ? 'none' : 'oauth');
  const existingToken = optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
  const token = auth === 'none' ? '' : stableToken(existingToken);

  return {
    port,
    mode,
    tunnel: preference.tunnel,
    auth,
    ...(preference.hostname ? { hostname: preference.hostname } : {}),
    ...(preference.tunnelName ? { tunnelName: preference.tunnelName } : {}),
    ...(preference.ngrokConfig ? { ngrokConfig: preference.ngrokConfig } : {}),
    ...(preference.cloudflareConfig ? { cloudflareConfig: preference.cloudflareConfig } : {}),
    ...(preference.cloudflareTokenFile ? { cloudflareTokenFile: preference.cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(bash ? { bash } : {}),
    ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
    ...(codexSessions !== 'off' ? { codexSessions } : {}),
    ...(codexDir ? { codexDir } : {}),
    ...(bashSession ? { bashSession } : {}),
    ...(requireBashSession ? { requireBashSession: true } : {}),
    ...(write ? { write } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(widgetDomain ? { widgetDomain } : {}),
    ...toolCardsProfileEntry(args, profile),
    ...(args.noInstallCloudflared ? { noInstallCloudflared: true } : {}),
    root
  };
}
