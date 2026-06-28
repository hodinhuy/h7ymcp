import process from 'node:process';

function writeControlPrompt() {
  process.stdout.write('codexpro> ');
}

function createConnectorDetails(endpoint, token, authMode = '', localBase = '', oauthApprovalMode = '') {
  const adminUrl = localBase ? `${localBase}/` : '';
  const authHeader = token ? `Authorization: Bearer ${token}` : '';
  const normalizedAuthMode = authMode || (token ? 'bearer' : 'none');
  const normalizedOauthApprovalMode = normalizedAuthMode === 'oauth' ? (oauthApprovalMode || (token ? 'token' : 'manual')) : '';
  return {
    endpoint,
    token,
    authMode: normalizedAuthMode,
    oauthApprovalMode: normalizedOauthApprovalMode,
    serverUrl: endpoint,
    serverUrlDisplay: endpoint,
    adminUrl,
    adminUrlDisplay: adminUrl || '',
    localStatusUrl: adminUrl,
    authHeader,
    approvalToken: normalizedAuthMode === 'oauth' && normalizedOauthApprovalMode === 'token' ? token : '',
    chatgptSettingsUrl: 'https://chatgpt.com/#settings/Connectors'
  };
}

function printCreateAppFields(details, deps) {
  const { EDITION } = deps;

  console.log('Create App fields:');
  console.log('');
  console.log(`  Name: ${EDITION.productName}`);
  console.log('  Description: Safe personal workspace bridge for ChatGPT.');
  console.log('  Connection: Server URL');
  console.log(`  Server URL: ${details.serverUrl}`);
  console.log(`  Authentication: ${details.authMode === 'oauth' ? 'OAuth' : details.token ? 'Bearer token in Authorization header' : 'No Authentication / None'}`);
  console.log('');
  if (details.authMode === 'oauth') {
    console.log('ChatGPT should discover OAuth settings automatically from this Server URL.');
    console.log(`Approval mode: ${details.oauthApprovalMode === 'manual' ? 'Manual approve/deny' : 'Approval token required'}`);
    if (details.approvalToken) console.log(`Approval token: ${details.approvalToken}`);
    console.log(details.oauthApprovalMode === 'manual'
      ? 'Approve or deny directly in the browser prompt.'
      : 'Approve the browser prompt with the token to finish the connector setup.');
  } else if (details.authHeader) {
    console.log('If your ChatGPT UI supports custom headers, use:');
    console.log('');
    console.log(`  ${details.authHeader}`);
    console.log('');
    console.log('If your ChatGPT UI only accepts a bare Server URL, restart with --no-auth for trusted local-only use.');
  } else {
    console.log('Authorization: disabled');
  }
}

export function printConnectorBlock(endpoint, token, options = {}, deps) {
  const {
    panelDivider,
    panelTitle,
    panelLine,
    panelKeyValue,
    paint,
    copyToClipboard,
    openUrl,
    statusLine
  } = deps;

  const details = createConnectorDetails(endpoint, token, options.authMode ?? '', options.localBase ?? '', options.oauthApprovalMode ?? '');
  const publicHttps = details.serverUrl.startsWith('https://');
  const shouldCopy = options.copyUrl === true || (options.copyUrl !== false && publicHttps);
  const copied = shouldCopy ? copyToClipboard(details.serverUrl) : { ok: false, command: '' };
  const copiedToken = details.approvalToken ? copyToClipboard(details.approvalToken) : { ok: false, command: '' };
  const opened = options.openChatgpt ? openUrl(details.chatgptSettingsUrl) : false;

  const mode = options.mode ?? 'agent';
  const modeValue = mode === 'agent' ? 'agent' : mode === 'handoff' ? 'handoff' : 'pro';
  const authText = details.authMode === 'oauth' ? `oauth (${details.oauthApprovalMode})` : details.token ? 'bearer token required' : 'disabled';
  console.log('');
  panelDivider();
  panelTitle('H7Y MCP ready');
  panelLine('');
  const rows = [
    ...(options.root ? [['Workspace', options.root]] : []),
    ['Mode', modeValue],
    ['Write mode', options.write ?? 'workspace'],
    ['Bash mode', options.bash ?? 'safe'],
    ['Tool mode', options.toolMode ?? 'standard'],
    ['Tool cards', options.toolCards ? 'html on' : 'off'],
    ...(options.bashTranscript && options.bashTranscript !== 'compact' ? [['Bash transcript', options.bashTranscript]] : []),
    ...(options.codexSessions && options.codexSessions !== 'off' ? [['Codex sessions', options.codexSessions]] : []),
    ...(options.bashSession ? [['Bash session', `${options.bashSession}${options.requireBashSession ? ' required' : ''}`]] : []),
    ...(options.localBase ? [['Local URL', `${options.localBase}/mcp`]] : []),
    ['Server URL', details.serverUrl],
    ['Auth', authText],
    ...(details.approvalToken ? [['Approval token', details.approvalToken]] : []),
    ...(details.authMode !== 'oauth' && details.authHeader ? [['Header', details.authHeader]] : []),
    ...(details.adminUrl ? [['Admin page', details.adminUrl]] : [])
  ];
  for (const [label, value] of rows) {
    let valueStyle;
    if (label === 'Mode' && value === 'agent') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Write mode' && value === 'workspace') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Tool cards' && value === 'html on') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Tool cards' && value === 'off') valueStyle = ['bold', 'brightYellow'];
    else if (label === 'Approval token') valueStyle = ['bold', 'brightYellow'];
    else if (label === 'Auth' && value === 'disabled') valueStyle = ['bold', 'brightYellow'];
    else if (label === 'Auth' && value !== 'disabled') valueStyle = ['bold', 'brightGreen'];
    panelKeyValue(label, value, { valueStyle });
  }
  if (!publicHttps) {
    panelLine('');
    panelLine(`${paint(['brightYellow', 'bold'], 'Warning:')} ChatGPT Developer Mode usually cannot reach local HTTP directly.`);
  }
  if (copied.ok) {
    panelLine('');
    panelKeyValue('Clipboard', `Server URL copied with ${copied.command}`);
  } else if (shouldCopy) {
    panelLine('');
    panelKeyValue('Clipboard', 'copy failed; use the Server URL above', { valueStyle: ['bold', 'brightYellow'] });
    panelLine(details.serverUrl);
  } else if (options.copyUrl === false && publicHttps) {
    panelLine('');
    panelKeyValue('Clipboard', 'skipped; press c to copy or u to show', { valueStyle: ['bold', 'brightYellow'] });
  }
  if (details.approvalToken) {
    if (copiedToken.ok) panelKeyValue('Token copy', `Approval token copied with ${copiedToken.command}`);
    else panelKeyValue('Token copy', 'Copy the approval token above for the browser prompt', { valueStyle: ['bold', 'brightYellow'] });
  }
  if (options.openChatgpt) {
    statusLine(opened ? 'ok' : 'warn', opened ? 'Opened ChatGPT connector settings' : 'Could not open ChatGPT automatically');
  }
  panelLine('');
  panelTitle('Next steps', { bold: false });
  panelLine('');
  const steps = details.authMode === 'oauth'
    ? details.oauthApprovalMode === 'manual'
      ? [
          '1. Press Enter to open ChatGPT.',
          '2. Paste the Server URL above.',
          '3. Choose Authentication: OAuth, then approve or deny in the browser prompt.'
        ]
      : [
          '1. Press Enter to open ChatGPT.',
          '2. Paste the Server URL above.',
          '3. Choose Authentication: OAuth, then use the approval token above in the browser prompt.'
        ]
    : details.token
      ? [
          '1. Press Enter to open ChatGPT.',
          '2. Paste the Server URL above.',
          '3. Configure an Authorization Bearer header if your UI supports it.'
        ]
      : [
          '1. Press Enter to open ChatGPT.',
          '2. Paste the Server URL above.',
          '3. Choose Authentication: None.'
        ];
  for (const step of steps) panelLine(step);
  panelLine('');
  panelLine(details.approvalToken
    ? paint(['dim'], 'Keys: Enter open | c copy url | t copy token | o status | h help | q quit')
    : paint(['dim'], 'Keys: Enter open | c copy url | o status | h help | q quit'));
  panelDivider();
  return { ...details, copied, opened, mode, toolMode: options.toolMode ?? 'standard' };
}

export function printStableUrlHelp() {
  console.log('');
  console.log('Stable URL setup');
  console.log('');
  console.log('Quick tunnels change every restart. ChatGPT apps should use a stable URL.');
  console.log('');
  console.log('One-time Cloudflare setup with your domain:');
  console.log('  h7ymcp install-cloudflared');
  console.log('  ~/.codexpro/bin/cloudflared tunnel login');
  console.log('  ~/.codexpro/bin/cloudflared tunnel create codexpro');
  console.log('  ~/.codexpro/bin/cloudflared tunnel route dns h7ymcp h7y.example.com');
  console.log('');
  console.log('Daily start:');
  console.log('  h7ymcp stable --hostname h7y.example.com --tunnel-name h7ymcp --token keep-this-stable-token');
  console.log('');
  console.log('Ngrok alternative with a reserved domain:');
  console.log('  ngrok config add-authtoken <your-ngrok-token>');
  console.log('  h7ymcp ngrok --hostname your-domain.ngrok-free.dev --token keep-this-stable-token');
  console.log('');
}

export function runControlPanel(details, deps) {
  const {
    cleanupChildren,
    copyToClipboard,
    openUrl,
    printControlHelp,
    printModeHelp,
    EDITION
  } = deps;

  if (!process.stdin.isTTY) return new Promise(() => {});

  writeControlPrompt();

  process.stdin.setEncoding('utf8');
  if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise(() => {
    process.stdin.on('data', (key) => {
      if (key === '\u0003') {
        console.log(`\nStopping ${EDITION.productName}...`);
        cleanupChildren();
        process.exit(130);
      }
      const normalized = key.toLowerCase();
      if (key === '\r' || key === '\n') {
        const opened = openUrl(details.chatgptSettingsUrl);
        console.log(opened ? '\nOpened ChatGPT connector settings. The Server URL is already copied; paste it into Server URL.' : '\nCould not open ChatGPT automatically.');
        writeControlPrompt();
      } else if (normalized === 'c') {
        const copied = copyToClipboard(details.serverUrl);
        console.log(copied.ok ? `\nServer URL copied with ${copied.command}.` : '\nCould not copy automatically.');
        writeControlPrompt();
      } else if (normalized === 't') {
        if (!details.approvalToken) {
          console.log('\nNo approval token is available for this run.');
        } else {
          const copied = copyToClipboard(details.approvalToken);
          console.log(copied.ok ? `\nApproval token copied with ${copied.command}.` : `\nCould not copy automatically. Token:\n${details.approvalToken}`);
        }
        writeControlPrompt();
      } else if (normalized === 'u') {
        console.log(`\n${details.serverUrl}`);
        writeControlPrompt();
      } else if (normalized === 'o') {
        if (!details.localStatusUrl) {
          console.log('\nNo local status page URL is available for this run.');
        } else {
          const opened = openUrl(details.localStatusUrl);
          console.log(opened ? `\nOpened local ${EDITION.productName} setup/status page.` : `\nCould not open automatically. Open this URL:\n${details.localStatusUrl}`);
        }
        writeControlPrompt();
      } else if (normalized === 'p') {
        console.log('');
        printCreateAppFields(details, { EDITION });
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'm') {
        printModeHelp();
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'h' || normalized === '?') {
        printControlHelp();
        writeControlPrompt();
      } else if (normalized === 'q') {
        console.log(`\nStopping ${EDITION.productName}...`);
        cleanupChildren();
        process.exit(0);
      }
    });
  });
}
