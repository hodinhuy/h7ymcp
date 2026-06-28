import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export async function runDoctorCommand(argv, deps) {
  const {
    usage,
    parseArgs,
    applyColorPreference,
    realDir,
    loadWorkspaceProfile,
    optionValue,
    writeOption,
    editionEnv,
    projectRoot,
    compareMajorVersion,
    localOrPathCommand,
    localCloudflaredPath,
    clipboardCommand,
    browserOpenCommand,
    assertPortAvailable,
    printBox,
    labelValue,
    statusLine,
    profileSummary
  } = deps;

  const args = parseArgs(argv);
  applyColorPreference(args);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  const effectiveArgs = { ...profile, ...args };
  const tunnel = optionValue(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
  const host = optionValue(args, profile, 'host', ['CODEXPRO_HOST'], '127.0.0.1');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
  const bash = optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], 'safe');
  const write = writeOption(args, profile, mode);
  const toolMode = optionValue(args, profile, 'toolMode', ['CODEXPRO_TOOL_MODE'], 'standard');
  const stableHostname =
    args.hostname
    ?? args.url
    ?? process.env.CODEXPRO_PUBLIC_HOSTNAME
    ?? process.env.CODEXPRO_HOSTNAME
    ?? process.env.NGROK_DOMAIN
    ?? profile.hostname
    ?? '';
  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  const serverPath = path.join(projectRoot, 'dist', 'server.js');
  const cloudflaredPath = localOrPathCommand(
    effectiveArgs.cloudflared ?? process.env.CLOUDFLARED_BIN ?? 'cloudflared',
    localCloudflaredPath()
  );
  const ngrokPath = localOrPathCommand(effectiveArgs.ngrok ?? process.env.NGROK_BIN ?? 'ngrok', '');
  const clipboard = clipboardCommand();
  const browser = browserOpenCommand();
  const checks = [];

  function record(status, label, detail) {
    checks.push(status);
    const marker = status === 'ok' ? 'OK' : status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`${marker.padEnd(4)} ${String(label).padEnd(18)} ${detail}`);
  }

  console.log('');
  printBox('H7Y MCP doctor', [
    labelValue('Workspace', root),
    labelValue('Mode', `${mode}  tools=${toolMode}  write=${write}  bash=${bash}`),
    labelValue('Tunnel', tunnel),
    ...(stableHostname ? [labelValue('Hostname', stableHostname)] : []),
    ...(profile.profilePath ? [labelValue('Profile', profile.profilePath)] : [])
  ]);

  record(compareMajorVersion(process.versions.node, 20) ? 'ok' : 'fail', 'Node', `v${process.versions.node} (requires >=20)`);
  record(fs.existsSync(httpPath) && fs.existsSync(serverPath) ? 'ok' : 'fail', 'Build artifacts', fs.existsSync(httpPath) ? 'dist ready' : 'missing dist/http.js; run npm install && npm run build');
  record(fs.existsSync(path.join(projectRoot, 'package.json')) ? 'ok' : 'fail', 'Package root', projectRoot);
  record(profile.profilePath ? 'ok' : 'warn', 'Saved profile', profile.profilePath ? profileSummary(profile) || profile.profilePath : 'none for this workspace');
  record(clipboard ? 'ok' : 'warn', 'Clipboard', clipboard || 'not found; URL will be printed for manual copy');
  record(browser ? 'ok' : 'warn', 'Browser open', browser || 'not found; open ChatGPT manually');

  try {
    await assertPortAvailable(host, port);
    record('ok', 'Local port', `${host}:${port} available`);
  } catch (error) {
    record('fail', 'Local port', error instanceof Error ? error.message.split('\n')[0] : String(error));
  }

  if (tunnel === 'none') {
    record('ok', 'Tunnel', 'local-only mode');
  } else if (tunnel === 'cloudflare') {
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; h7ymcp start can auto-install unless --no-install-cloudflared is used');
  } else if (tunnel === 'cloudflare-named') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for Cloudflare stable mode');
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; run h7ymcp install-cloudflared or pass --cloudflared');
    record(
      optionValue(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'CODEXPRO_TUNNEL_NAME'], '')
        || optionValue(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE'], '')
        || optionValue(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'CODEXPRO_CLOUDFLARE_CONFIG'], '')
        || optionValue(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN'], '')
        ? 'ok'
        : 'fail',
      'Cloudflare setup',
      'needs tunnel name, config, token file, or tunnel token'
    );
  } else if (tunnel === 'ngrok') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for ngrok mode');
    record(ngrokPath ? 'ok' : 'fail', 'ngrok', ngrokPath || 'not found on PATH; install ngrok and run ngrok config add-authtoken <token>');
  } else {
    record('fail', 'Tunnel', `unknown tunnel mode: ${tunnel}`);
  }

  const failures = checks.filter((status) => status === 'fail').length;
  const warnings = checks.filter((status) => status === 'warn').length;
  console.log('');
  if (failures) {
    statusLine('warn', `${failures} blocker${failures === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} found.`);
    process.exitCode = 1;
    return;
  }
  statusLine('ok', warnings ? `Ready with ${warnings} warning${warnings === 1 ? '' : 's'}.` : 'Ready.');
}
