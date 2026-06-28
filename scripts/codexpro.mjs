#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createCliUi } from './lib/cli-ui.mjs';
import { runDoctorCommand } from './lib/doctor.mjs';
import { ask as sharedAsk, applyTunnelPreferenceToArgs as sharedApplyTunnelPreferenceToArgs, collectTunnelPreference as sharedCollectTunnelPreference, hasExplicitTunnelInput as sharedHasExplicitTunnelInput, normalizeSetupChoice as sharedNormalizeSetupChoice, profileFromPreference as sharedProfileFromPreference } from './lib/profile-preferences.mjs';
import { runCli } from './lib/router.mjs';
import { printConnectorBlock as runtimePrintConnectorBlock, printStableUrlHelp as runtimePrintStableUrlHelp, runControlPanel as runtimeRunControlPanel } from './lib/runtime-ui.mjs';
import { runStartCommand } from './lib/start.mjs';
import { runSettingsCommand } from './lib/settings.mjs';
import { maybeConfigureFirstRunCommand, runSetupWizardCommand } from './lib/setup.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNTRACKED_FILE_HASH_BYTES = 64 * 1024;
const UNTRACKED_SYMLINK_TARGET_BYTES = 512;
const EDITION = Object.freeze({
  productName: 'H7Y MCP',
  cliName: 'h7ymcp',
  envPrefix: 'PERSONAL',
  legacyEnvPrefix: 'CODEXPRO',
  configDirName: '.personal-edition',
  legacyConfigDirName: '.codexpro',
  defaultWidgetDomain: 'https://github.com'
});
const {
  applyColorPreference: uiApplyColorPreference,
  displayPath: uiDisplayPath,
  formatCommandBlock: uiFormatCommandBlock,
  labelValue: uiLabelValue,
  paint: uiPaint,
  panelDivider: uiPanelDivider,
  panelKeyValue: uiPanelKeyValue,
  panelLine: uiPanelLine,
  panelParagraph: uiPanelParagraph,
  panelTitle: uiPanelTitle,
  printBox: uiPrintBox,
  printControlHelp: uiPrintControlHelp,
  printKeyValueTable: uiPrintKeyValueTable,
  printModeHelp: uiPrintModeHelp,
  printSectionTitle: uiPrintSectionTitle,
  rawColorArg: uiRawColorArg,
  statusLine: uiStatusLine,
  termWidth: uiTermWidth,
  visibleLength: uiVisibleLength,
  warningText: uiWarningText,
  errorText: uiErrorText,
  padVisibleEnd: uiPadVisibleEnd,
  wrapLine: uiWrapLine,
  successMarker: uiSuccessMarker
} = createCliUi({ cliName: EDITION.cliName, productName: EDITION.productName });

function envName(prefix, suffix) {
  return `${prefix}_${suffix}`;
}

function editionEnv(name, extraLegacyKeys = []) {
  for (const key of [envName(EDITION.envPrefix, name), envName(EDITION.legacyEnvPrefix, name), ...extraLegacyKeys]) {
    if (process.env[key] !== undefined) return process.env[key];
  }
  return undefined;
}

function usage() {
  console.log(`${EDITION.productName} easy launcher

Usage:
  npm install -g h7ymcp
  h7ymcp setup
  h7ymcp start
  h7ymcp start --root /path/to/repo
  h7ymcp settings
  h7ymcp doctor
  h7ymcp execute-handoff --agent opencode --model provider/model
  h7ymcp watch-handoff --agent opencode --model provider/model
  h7ymcp loop-handoff --agent opencode --model provider/model --review-command "node ./reviewer.js --status {{status_file}} --diff {{diff_file}} --plan-file {{plan_file}}"
  h7ymcp --root /path/to/repo
  h7ymcp ngrok --hostname your-domain.ngrok-free.dev
  h7ymcp stable --hostname personal.example.com --tunnel-name personal
  h7ymcp pro-bundle --root /path/to/repo --copy
  h7ymcp pro-apply --root /path/to/repo --file plan.md
  h7ymcp install-cloudflared
  npm run connect -- --root /path/to/repo
  node scripts/codexpro.mjs --root /path/to/repo --tunnel none

Options:
  --root <dir>              Workspace root. Default: current directory.
  --from-root <dir>         Copy saved settings from another workspace with settings use.
  --allow-root <dir>        Additional allowed root. Can be repeated.
  --allow-home              Allow opening any workspace under your home directory.
  --mode <agent|handoff|pro>
                             Default: agent.
                             agent = ChatGPT can read, write/edit files, search, and run safe bash.
                             handoff = ChatGPT writes .ai-bridge plans for a local implementation agent.
                             pro = export context for models that cannot call MCP tools.
  --agent                   Shortcut for --mode agent.
  --handoff                 Shortcut for --mode handoff.
  --pro-planning            Shortcut for --mode pro.
  --host <host>             Local bind host. Default: 127.0.0.1.
  --port <port>             Local port. Default: 8787.
  --bash <off|safe|full>    Bash mode. Default: safe.
  --no-bash                 Shortcut for --bash off.
  --bash-transcript <compact|full>
                             Chat transcript for bash results. Default: compact.
                             full prints raw stdout/stderr in chat.
  --full-bash-transcript    Shortcut for --bash-transcript full.
  --bash-session <id>       Local bash session label exposed to ChatGPT.
  --require-bash-session    Require bash calls to include matching session_id.
  --codex-sessions <off|metadata|read>
                             Opt in to read local ~/.codex session history.
                             metadata lists ids/titles/cwd; read allows bounded transcript reads.
  --codex-dir <dir>          Codex config/session directory. Default: ~/.codex.
  --write <off|handoff|workspace>
                             Write mode. Default: workspace in agent mode, handoff otherwise.
                             handoff = no generic write/edit tools; handoff tools write bounded .ai-bridge files.
  --tool-mode <minimal|standard|full>
                             Tool surface exposed to ChatGPT. Default: standard.
                             minimal = open/read/write/edit/bash/show_changes only.
                             full = expose every compatibility and advanced tool.
  --widget-domain <origin>   Dedicated HTTPS origin for ChatGPT widget iframes.
                             Required for app submission. Default: https://github.com.
  --tool-cards <on|off>      Opt in to ChatGPT widget metadata on tool descriptors. Default: off.
  --tunnel <none|cloudflare|cloudflare-named|ngrok>
                             Expose local MCP. Default: none.
                             cloudflare = quick tunnel with a new URL each restart.
                             cloudflare-named = stable hostname using a named tunnel.
                             ngrok = stable ngrok dev-domain endpoint using --hostname/--url.
  --stable                  Shortcut for --tunnel cloudflare-named.
  --hostname <host>          Stable public hostname for cloudflare-named or ngrok.
  --url <url>                Alias for --hostname in ngrok/stable URL modes.
  --tunnel-name <name>       Existing Cloudflare named tunnel to run.
  --cloudflare-token <token> Cloudflare Tunnel token for this launch only; not saved by settings set.
  --cloudflare-token-file <path>
                             File containing a Cloudflare Tunnel token.
  --cloudflare-config <path> cloudflared YAML config for a named tunnel.
  --token <token>           Bearer token for HTTP MCP. Auto-generated for tunnels.
  --cloudflared <path>      cloudflared executable. Default: PATH, then ~/.personal-edition/bin.
  --ngrok <path>            ngrok executable. Default: PATH.
  --ngrok-config <path>     Optional ngrok config file path.
  --no-profile              Do not load a saved ~/.personal-edition workspace profile.
  --save-config             Save setup choices for this workspace when using setup.
  --no-save-config          Do not save setup choices when using setup.
  --yes                     Confirm settings delete/reset without prompting.
  --install-cloudflared     Install/reinstall cloudflared into ~/.personal-edition/bin.
  --no-install-cloudflared  Do not auto-install cloudflared when missing.
  --copy-url                Copy the ChatGPT Server URL to clipboard. Default for public HTTPS URLs.
  --no-copy-url             Do not copy the Server URL.
  --open-chatgpt            Open ChatGPT connector settings after the URL is ready.
  --color <always|auto|never>
                            Terminal colors. Default: auto.
                            NO_COLOR disables color unless --color always is set.
  --auth <none|bearer|oauth>
                            HTTP auth mode. Default: bearer for token-protected runs, none otherwise.
                            oauth enables OAuth discovery plus authorization-code + PKCE for ChatGPT connectors.
  --oauth-approval <token|manual>
                            With --auth oauth: require a launcher token in the approval page, or allow plain Approve/Deny.
  --no-auth                 Shortcut for --auth none. Only allowed with --tunnel none.
  --log-requests            Print redacted HTTP request and tool-call logs from the local MCP server.
  --print-env               Print the environment used to launch the server.
  --help                    Show this message.

Execute handoff options:
  h7ymcp execute-handoff --agent opencode --model provider/model
  h7ymcp execute-handoff --agent pi --model provider/model
  h7ymcp execute-handoff --agent custom --command "my-agent --task-file {{plan_file}}"
  --agent <opencode|pi|codex|custom>
                             Local implementation agent adapter.
  --model <provider/model>  Optional model name passed to the adapter.
  --command <template>      Custom command template. Supports {{model}}, {{plan_file}}, {{plan_text}}, {{root}}.
  --dry-run                 Print the command that would run without executing it.
  --timeout-ms <ms>         Execution timeout. Default: 600000.
  --max-output-bytes <n>    Max stdout/stderr excerpt bytes per stream. Default: 120000.
  --context-dir <dir>       Handoff directory. Default: .ai-bridge.
  --yes                     Run without interactive confirmation.

Watch handoff options:
  h7ymcp watch-handoff --agent opencode --model provider/model
  h7ymcp watch-handoff --agent pi --model provider/model
  h7ymcp watch-handoff --agent custom --command "my-agent --task-file {{plan_file}}"
  --once                    Exit after checking/running one new plan.
  --poll-interval-ms <ms>   Poll interval. Default: 2000.
  --debounce-ms <ms>        Wait for plan file stability. Default: 500.
  --state-file <path>       Watch state file. Default: .ai-bridge/watch-handoff-state.json.
  --yes                     Start automatic local execution without startup confirmation.

Loop handoff options:
  h7ymcp loop-handoff --agent opencode --model provider/model --review-command "reviewer --status {{status_file}} --diff {{diff_file}} --plan-file {{plan_file}}"
  --review-command <template>
                             Local reviewer/orchestrator command. It should print CODEXPRO_REVIEW=PASS or CODEXPRO_REVIEW=FAIL.
                             On FAIL it must update .ai-bridge/current-plan.md before the next iteration.
  --max-iters <n>           Maximum execute/review iterations. Default: 3.
  --run-tests <template>    Optional local verification command before review.
  --allow-implicit-review-verdict
                             Infer PASS/FAIL from reviewer exit code and plan changes when no CODEXPRO_REVIEW line is printed.
  --allow-review-pass-on-failure
                             Let explicit reviewer PASS override a failed executor or failed test command.
  --require-clean-git-start Refuse to start unless git status is clean.
  --stop-if-no-files-changed
                             Stop if an executor iteration produces no git diff.
  --stop-if-same-diff       Stop if an executor iteration repeats the previous diff.
  --require-human-confirmation
                             Ask before running a reviewer-generated follow-up plan.
  --dry-run                 Print executor/reviewer/test commands without executing them.
  --yes                     Start the local loop without startup confirmation.

Default agent mode:
  h7ymcp start --root /path/to/repo

Guided setup:
  h7ymcp setup

Workspace settings:
  h7ymcp settings
  h7ymcp settings show
  h7ymcp settings list
  h7ymcp settings set --tunnel ngrok --hostname your-domain.ngrok-free.dev
  h7ymcp settings use
  h7ymcp settings delete --yes

Preflight diagnostics:
  h7ymcp doctor

Ngrok stable URL mode:
  h7ymcp ngrok --root /path/to/repo --hostname your-domain.ngrok-free.dev

Planning-only handoff mode:
  h7ymcp start --root /path/to/repo --mode handoff

Execute a local handoff after ChatGPT writes .ai-bridge/current-plan.md:
  h7ymcp execute-handoff --agent opencode --model provider/model
  h7ymcp execute-handoff --agent pi --model provider/model
  h7ymcp execute-handoff --agent custom --command "node ./agent.js --task-file {{plan_file}}" --yes

Watch for new handoff plans and execute them locally:
  h7ymcp watch-handoff --agent opencode --model provider/model --yes
  h7ymcp watch-handoff --agent custom --command "node ./agent.js --task-file {{plan_file}}" --yes

Run a bounded local execute/review loop:
  h7ymcp loop-handoff --agent opencode --model provider/model --review-command "node ./reviewer.js --status {{status_file}} --diff {{diff_file}} --plan-file {{plan_file}}" --max-iters 3 --yes

Stable URL mode after one-time Cloudflare tunnel setup:
  h7ymcp stable --root /path/to/repo --hostname h7y.example.com --tunnel-name h7ymcp
`);
}

function paint(style, text) {
  return uiPaint(style, text);
}

function visibleLength(text) {
  return uiVisibleLength(text);
}

function padVisibleEnd(text, width) {
  return uiPadVisibleEnd(text, width);
}

function validateColorMode(value, label) {
  if (value === undefined || value === null || value === '') return '';
  const normalized = String(value).trim().toLowerCase();
  if (['always', 'auto', 'never'].includes(normalized)) return normalized;
  throw new Error(`${label} must be always, auto, or never`);
}

function rawColorArg(argv = []) {
  return uiRawColorArg(argv);
}

function applyColorPreference(args = {}) {
  return uiApplyColorPreference(args);
}

function printSectionTitle(title, options = {}) {
  return uiPrintSectionTitle(title, options);
}

function panelWidth() {
  return uiTermWidth(90);
}

function panelLine(text = '', options = {}) {
  return uiPanelLine(text, options);
}

function panelDivider(character = '-') {
  return uiPanelDivider(character);
}

function panelKeyValue(label, value, options = {}) {
  return uiPanelKeyValue(label, value, options);
}

function panelParagraph(text, options = {}) {
  return uiPanelParagraph(text, options);
}

function panelTitle(title, options = {}) {
  return uiPanelTitle(title, options);
}

function formatLabel(label, width = 16, style = []) {
  return uiPaint(style, uiPadVisibleEnd(label, width));
}

function labelValue(label, value, options = {}) {
  return uiLabelValue(label, value, options);
}

function successMarker(text = '✓') {
  return uiSuccessMarker(text);
}

function warningText(text) {
  return uiWarningText(text);
}

function errorText(text) {
  return uiErrorText(text);
}

function displayPath(filePath) {
  return uiDisplayPath(filePath);
}

function configValueStyle(label, value) {
  if (label === 'Mode' && value === 'agent') return ['bold', 'green'];
  if (label === 'Write mode' && value === 'workspace') return ['bold', 'green'];
  if (label === 'Tunnel' && value === 'none') return ['bold', 'yellow'];
  return undefined;
}

function printKeyValueTable(rows, options = {}) {
  return uiPrintKeyValueTable(rows, {
    ...options,
    valueStyle: options.valueStyle ?? ((label, value) => configValueStyle(label, value))
  });
}

function formatCommandBlock(args) {
  return uiFormatCommandBlock(args);
}

function printCommandBlock(args) {
  const lines = formatCommandBlock(args);
  lines.forEach((line, index) => {
    const prefix = paint('dim', index === 0 ? '$ ' : '  ');
    console.log(`${prefix}${line}`);
  });
}

function termWidth(max = 78) {
  return uiTermWidth(max);
}

function printBox(title, lines) {
  return uiPrintBox(title, lines);
}

function wrapLine(text, width) {
  return uiWrapLine(text, width);
}

function statusLine(status, detail = '') {
  return uiStatusLine(status, detail);
}

function profileSummary(profile) {
  if (!profile?.tunnel) return '';
  if (profile.tunnel === 'ngrok' && profile.hostname) return `Saved ngrok URL: ${profile.hostname}`;
  if (profile.tunnel === 'cloudflare-named' && profile.hostname) return `Saved Cloudflare URL: ${profile.hostname}`;
  if (profile.tunnel === 'cloudflare') return 'Saved Cloudflare quick-tunnel setup';
  if (profile.tunnel === 'none') return 'Saved local-only setup';
  return '';
}

function profileOneLine(profile, index = 0) {
  const prefix = index ? `${index}. ` : '';
  const tunnel = profile.tunnel ?? 'cloudflare';
  const host = profile.hostname ? ` -> ${profile.hostname}` : '';
  const port = profile.port ? ` :${profile.port}` : '';
  const auth = profile.auth ? `  auth=${profile.auth}${profile.auth === 'oauth' && profile.oauthApproval ? `/${profile.oauthApproval}` : ''}` : '';
  return `${prefix}${profile.root}  ${tunnel}${host}${port}${auth}`;
}

function printSavedProfileHint(profile) {
  const summary = profileSummary(profile);
  if (!summary) return;
  printBox('Saved setup found', [
    summary,
    'From this folder, future launches only need: h7ymcp start',
    'Use h7ymcp setup when you want to change the port, mode, tool mode, tunnel, hostname, or token.'
  ]);
}

function parseArgs(argv) {
  const out = { allowRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    if (key === 'help') out.help = true;
    else if (key === 'allow-home') out.allowHome = true;
    else if (key === 'no-auth') out.noAuth = true;
    else if (key === 'no-bash') out.bash = 'off';
    else if (key === 'compact-bash-transcript') out.bashTranscript = 'compact';
    else if (key === 'full-bash-transcript') out.bashTranscript = 'full';
    else if (key === 'codex-sessions-read') out.codexSessions = 'read';
    else if (key === 'require-bash-session') out.requireBashSession = true;
    else if (key === 'copy-url') out.copyUrl = true;
    else if (key === 'no-copy-url') out.noCopyUrl = true;
    else if (key === 'dry-run') out.dryRun = true;
    else if (key === 'once') out.once = true;
    else if (key === 'confirm') out.confirm = true;
    else if (key === 'no-confirm') out.noConfirm = true;
    else if (key === 'require-clean-git-start') out.requireCleanGitStart = true;
    else if (key === 'stop-if-no-files-changed') out.stopIfNoFilesChanged = true;
    else if (key === 'stop-if-same-diff') out.stopIfSameDiff = true;
    else if (key === 'require-human-confirmation') out.requireHumanConfirmation = true;
    else if (key === 'allow-implicit-review-verdict') out.allowImplicitReviewVerdict = true;
    else if (key === 'allow-review-pass-on-failure') out.allowReviewPassOnFailure = true;
    else if (key === 'open-chatgpt') out.openChatgpt = true;
    else if (key === 'no-profile') out.noProfile = true;
    else if (key === 'save-config') out.saveConfig = true;
    else if (key === 'no-save-config') out.noSaveConfig = true;
    else if (key === 'yes' || key === 'force') out.yes = true;
    else if (key === 'stable') out.tunnel = 'cloudflare-named';
    else if (key === 'install-cloudflared') out.installCloudflared = true;
    else if (key === 'no-install-cloudflared') out.noInstallCloudflared = true;
    else if (key === 'agent') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.agent = next;
        i += 1;
      } else {
        out.mode = 'agent';
      }
    }
    else if (key === 'handoff') out.mode = 'handoff';
    else if (key === 'pro-planning' || key === 'pro') out.mode = 'pro';
    else if (key === 'log-requests') out.logRequests = true;
    else if (key === 'print-env') out.printEnv = true;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
      i += 1;
      if (key === 'allow-root') out.allowRoots.push(next);
      else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
    }
  }
  validateColorMode(out.color, '--color');
  return out;
}

function expandHome(input) {
  if (!input || input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function realDir(input) {
  const resolved = path.resolve(expandHome(input));
  if (!fs.existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function resolveCodexDir(root, input) {
  if (!input) return '';
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

function resolveConfigPath(root, input) {
  if (!input) return '';
  const expanded = expandHome(String(input));
  return path.isAbsolute(expanded) || path.win32.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

function effectiveWriteMode(mode, requested) {
  const value = requested || (mode === 'agent' ? 'workspace' : 'handoff');
  if (!['off', 'handoff', 'workspace'].includes(value)) {
    throw new Error('--write must be off, handoff, or workspace');
  }
  if (mode === 'agent') return value;
  return value === 'off' ? 'off' : 'handoff';
}

function writeOption(args, profile, mode) {
  return effectiveWriteMode(mode, optionValue(args, profile, 'write', [envName(EDITION.envPrefix, 'WRITE_MODE'), 'CODEXPRO_WRITE_MODE'], ''));
}

function optionalWriteOption(args, profile, mode) {
  const requested =
    args.write !== undefined
      ? args.write
      : process.env[envName(EDITION.envPrefix, 'WRITE_MODE')] !== undefined && process.env[envName(EDITION.envPrefix, 'WRITE_MODE')] !== ''
        ? process.env[envName(EDITION.envPrefix, 'WRITE_MODE')]
        : process.env.CODEXPRO_WRITE_MODE !== undefined && process.env.CODEXPRO_WRITE_MODE !== ''
          ? process.env.CODEXPRO_WRITE_MODE
          : mode === 'agent'
            ? 'workspace'
            : profile?.write ?? '';
  return requested ? effectiveWriteMode(mode, requested) : '';
}

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    shell: process.platform !== 'win32',
    stdio: 'ignore'
  });
  return result.status === 0;
}

function isPathLike(command) {
  return command.includes('/') || command.includes('\\') || command.startsWith('.');
}

function resolveExecutablePath(command) {
  const expanded = expandHome(command);
  return path.resolve(expanded);
}

function executableFileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function commandAvailable(command) {
  if (isPathLike(command)) return executableFileExists(resolveExecutablePath(command));
  return commandExists(command);
}

function commandAvailableFromRoot(command, root) {
  if (!isPathLike(command)) return commandExists(command);
  const expanded = expandHome(command);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
  return executableFileExists(resolved);
}

function codexProHome() {
  const customHome = editionEnv('HOME');
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), EDITION.configDirName);
}

function legacyCodexProHome() {
  const customHome = process.env.CODEXPRO_HOME;
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), EDITION.legacyConfigDirName);
}

function profileDir() {
  return path.join(codexProHome(), 'profiles');
}

function profileIdForRoot(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function profilePathForRoot(root) {
  return path.join(profileDir(), `${profileIdForRoot(root)}.json`);
}

function runtimeDir() {
  return path.join(codexProHome(), 'runtime');
}

function runtimeStatusPathForRoot(root) {
  return path.join(runtimeDir(), `${profileIdForRoot(root)}.json`);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

function loadWorkspaceProfile(root) {
  const profilePath = profilePathForRoot(root);
  const legacyPath = path.join(legacyCodexProHome(), 'profiles', `${profileIdForRoot(root)}.json`);
  const chosenPath = fs.existsSync(profilePath) ? profilePath : fs.existsSync(legacyPath) ? legacyPath : '';
  if (!chosenPath) return {};
  const profile = readJsonFile(chosenPath);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return {};
  if (profile.root && profile.root !== root) return {};
  return { ...profile, profilePath: chosenPath };
}

function listWorkspaceProfiles() {
  const dir = profileDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const profilePath = path.join(dir, name);
      const profile = readJsonFile(profilePath);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !profile.root) return null;
      return { ...profile, profilePath };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function deleteWorkspaceProfile(root) {
  const filePath = profilePathForRoot(root);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

function saveWorkspaceProfile(root, profile) {
  const dir = profileDir();
  const filePath = profilePathForRoot(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    root,
    updatedAt: new Date().toISOString(),
    ...profile
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return filePath;
}

function saveRuntimeConnection(root, details, options = {}) {
  const filePath = runtimeStatusPathForRoot(root);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const payload = {
      version: 1,
      root,
      updatedAt: new Date().toISOString(),
      endpoint: details.endpoint,
      localBase: options.localBase ?? '',
      localStatusUrl: details.localStatusUrl ? details.localStatusUrl.replace(/codexpro_token=[^&]+/, 'codexpro_token=<redacted>') : '',
      tunnel: options.tunnel ?? '',
      mode: options.mode ?? '',
      bash: options.bash ?? '',
      bashTranscript: options.bashTranscript ?? '',
      codexSessions: options.codexSessions ?? '',
      bashSession: options.bashSession ?? '',
      requireBashSession: Boolean(options.requireBashSession),
      write: options.write ?? '',
      toolMode: options.toolMode ?? '',
      toolCards: Boolean(options.toolCards)
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
    return filePath;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    statusLine('warn', `Could not save runtime status: ${detail}`);
    return '';
  }
}

function sanitizedProfile(profile) {
  if (!profile || !Object.keys(profile).length) return {};
  const { token, cloudflareToken, ...rest } = profile;
  return {
    ...rest,
    ...(token ? { token: '<saved>' } : {}),
    ...(cloudflareToken ? { cloudflareToken: '<saved>' } : {})
  };
}

function reusableProfilePayload(profile, overrides = {}) {
  const {
    version,
    root,
    updatedAt,
    profilePath,
    ...rest
  } = profile || {};
  return {
    ...rest,
    ...overrides
  };
}

function optionValue(args, profile, field, envNames = [], fallback = undefined) {
  if (args[field] !== undefined) return args[field];
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return process.env[envName];
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return profile[field];
  return fallback;
}

function boolFromValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function optionBool(args, profile, field, envNames = [], fallback = false) {
  if (args[field] !== undefined) return boolFromValue(args[field], fallback);
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return boolFromValue(process.env[envName], fallback);
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return boolFromValue(profile[field], fallback);
  return fallback;
}

function normalizeAuthModeChoice(value, fallback = 'bearer') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['none', 'bearer', 'oauth'].includes(normalized)) return normalized;
  return fallback;
}

function normalizeOauthApprovalChoice(value, fallback = 'token') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['token', 'manual'].includes(normalized)) return normalized;
  return fallback;
}

function hasToolCardsInput(args, profile = {}) {
  return args.toolCards !== undefined
    || profile.toolCards !== undefined
    || (process.env[envName(EDITION.envPrefix, 'TOOL_CARDS')] !== undefined && process.env[envName(EDITION.envPrefix, 'TOOL_CARDS')] !== '')
    || (process.env.CODEXPRO_TOOL_CARDS !== undefined && process.env.CODEXPRO_TOOL_CARDS !== '');
}

function toolCardsProfileEntry(args, profile = {}) {
  const hasInput = hasToolCardsInput(args, profile);
  return hasInput ? { toolCards: optionBool(args, profile, 'toolCards', [envName(EDITION.envPrefix, 'TOOL_CARDS'), 'CODEXPRO_TOOL_CARDS'], false) } : {};
}

function toolCardsCliArgs(args, profile = {}) {
  if (!hasToolCardsInput(args, profile)) return [];
  return ['--tool-cards', optionBool(args, profile, 'toolCards', [envName(EDITION.envPrefix, 'TOOL_CARDS'), 'CODEXPRO_TOOL_CARDS'], false) ? 'on' : 'off'];
}

function printStartSummary(config) {
  console.log('');
  panelDivider();
  panelTitle(`${EDITION.productName} start`);
  panelLine('');
  const rows = [
    ['Workspace', config.root],
    ['Mode', config.mode],
    ['Write mode', config.write],
    ['Bash mode', config.bash],
    ['Tool mode', config.toolMode],
    ['Tool cards', config.toolCards ? 'html on' : 'off'],
    ['Bash transcript', config.bashTranscript],
    ['Codex sessions', config.codexSessions],
    ...(config.bashSession ? [['Bash session', `${config.bashSession}${config.requireBashSession ? ' required' : ''}`]] : []),
    ['Local URL', config.localUrl],
    ['Tunnel', config.tunnel]
  ];
  for (const [label, value] of rows) {
    let valueStyle;
    if (label === 'Mode' && value === 'agent') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Write mode' && value === 'workspace') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Tool cards' && value === 'html on') valueStyle = ['bold', 'brightGreen'];
    else if (label === 'Tool cards' && value === 'off') valueStyle = ['bold', 'brightYellow'];
    else if (label === 'Tunnel' && value === 'none') valueStyle = ['bold', 'brightYellow'];
    panelKeyValue(label, value, { valueStyle });
  }
  panelDivider();
}

function validateBashSession(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error('--bash-session must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.');
  }
  return trimmed;
}

function bashSessionOptions(args, profile = {}) {
  const bashSession = validateBashSession(optionValue(args, profile, 'bashSession', ['CODEXPRO_BASH_SESSION_ID'], ''));
  const requireBashSession = optionBool(args, profile, 'requireBashSession', ['CODEXPRO_REQUIRE_BASH_SESSION'], false);
  if (requireBashSession && !bashSession) {
    throw new Error('--require-bash-session requires --bash-session <id>.');
  }
  return { bashSession, requireBashSession };
}

function bashTranscriptOption(args, profile = {}) {
  const value = optionValue(args, profile, 'bashTranscript', ['CODEXPRO_BASH_TRANSCRIPT'], 'compact');
  if (value === 'compact' || value === 'full') return value;
  throw new Error('--bash-transcript must be compact or full.');
}

function codexSessionsOption(args, profile = {}) {
  const value = optionValue(args, profile, 'codexSessions', ['CODEXPRO_CODEX_SESSIONS'], 'off');
  if (value === 'off' || value === 'metadata' || value === 'read') return value;
  throw new Error('--codex-sessions must be off, metadata, or read.');
}

function stableToken(existing = '') {
  return existing || randomBytes(24).toString('hex');
}

function cloudflaredBinName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function localCloudflaredPath() {
  return path.join(codexProHome(), 'bin', cloudflaredBinName());
}

function cloudflaredReleaseAsset() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    if (arch === 'arm64') return { file: 'cloudflared-darwin-arm64.tgz', archive: true };
    if (arch === 'x64') return { file: 'cloudflared-darwin-amd64.tgz', archive: true };
  }

  if (platform === 'linux') {
    if (arch === 'arm64') return { file: 'cloudflared-linux-arm64', archive: false };
    if (arch === 'arm') return { file: 'cloudflared-linux-arm', archive: false };
    if (arch === 'x64') return { file: 'cloudflared-linux-amd64', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-linux-386', archive: false };
  }

  if (platform === 'win32') {
    if (arch === 'x64') return { file: 'cloudflared-windows-amd64.exe', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-windows-386.exe', archive: false };
  }

  throw new Error(`Automatic cloudflared install is not supported on ${platform}/${arch}. Install cloudflared manually or pass --cloudflared <path>.`);
}

function findFileByName(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileByName(fullPath, fileName);
      if (found) return found;
    }
  }
  return '';
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'codexpro-launcher' }
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer, { mode: 0o755 });
}

function verifyCloudflared(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`Downloaded cloudflared, but ${binaryPath} --version failed.`);
  }
}

async function installCloudflaredLocal() {
  const asset = cloudflaredReleaseAsset();
  const installPath = localCloudflaredPath();
  const binDir = path.dirname(installPath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-cloudflared-'));
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;

  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  console.error(`[codexpro] Installing cloudflared locally: ${installPath}`);
  console.error(`[codexpro] Downloading official Cloudflare release: ${asset.file}`);

  try {
    if (asset.archive) {
      const archivePath = path.join(tmpRoot, asset.file);
      const extractDir = path.join(tmpRoot, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });
      await downloadFile(url, archivePath);
      const tar = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
      if (tar.status !== 0) {
        throw new Error(`Failed to extract ${asset.file}: ${tar.stderr || tar.stdout || `exit ${tar.status}`}`);
      }
      const extracted = findFileByName(extractDir, 'cloudflared');
      if (!extracted) throw new Error(`Could not find cloudflared inside ${asset.file}`);
      fs.copyFileSync(extracted, installPath);
    } else {
      const tmpBinary = path.join(tmpRoot, cloudflaredBinName());
      await downloadFile(url, tmpBinary);
      fs.copyFileSync(tmpBinary, installPath);
    }

    if (process.platform !== 'win32') fs.chmodSync(installPath, 0o755);
    verifyCloudflared(installPath);
    console.error('[codexpro] cloudflared installed successfully.');
    return installPath;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function resolveCloudflared(args) {
  const explicit = args.cloudflared ?? process.env.CLOUDFLARED_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyCloudflared(resolved);
      return resolved;
    }
    throw new Error(`cloudflared was not found at ${explicit}. Remove --cloudflared, install it, or pass a valid path.`);
  }

  if (!args.installCloudflared && commandExists('cloudflared')) {
    try {
      verifyCloudflared('cloudflared');
      return 'cloudflared';
    } catch (error) {
      console.error(`[codexpro] cloudflared in PATH failed --version; trying local install. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const localPath = localCloudflaredPath();
  if (!args.installCloudflared && executableFileExists(localPath)) {
    try {
      verifyCloudflared(localPath);
      return localPath;
    } catch (error) {
      if (args.noInstallCloudflared) return localPath;
      console.error(`[codexpro] Existing ${localPath} failed --version; reinstalling. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (args.noInstallCloudflared) return '';
  return installCloudflaredLocal();
}

function verifyNgrok(binaryPath) {
  const result = spawnSync(binaryPath, ['version'], {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`ngrok was found, but ${binaryPath} version failed. Run ngrok version to inspect it.`);
  }
}

function resolveNgrok(args) {
  const explicit = args.ngrok ?? process.env.NGROK_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyNgrok(resolved);
      return resolved;
    }
    throw new Error(`ngrok was not found at ${explicit}. Install ngrok, add it to PATH, or pass --ngrok <path>.`);
  }

  if (commandExists('ngrok')) {
    verifyNgrok('ngrok');
    return 'ngrok';
  }

  throw new Error('ngrok was not found on PATH. Install it with Homebrew, winget, apt, or from https://ngrok.com/download, then run ngrok config add-authtoken <token>.');
}

function ngrokConfigPath(root, args) {
  const configPath = args.ngrokConfig ?? process.env.NGROK_CONFIG ?? process.env.CODEXPRO_NGROK_CONFIG ?? '';
  return resolveConfigPath(root, configPath);
}

function runHelperScript(scriptName, args) {
  const scriptPath = path.join(projectRoot, 'scripts', scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, token, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) return await res.json();
      lastError = `${res.status} ${await res.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}

function portInUseHelp(host, port) {
  return [
    `Local port ${port} is already in use on ${host}.`,
    '',
    'If you want two repositories running at the same time, each one needs its own local port.',
    '',
    'Example:',
    '  repo A: h7ymcp setup  -> port 8787 -> hostname A',
    '  repo B: h7ymcp setup  -> port 8788 -> hostname B',
    '',
    'For quick tunnels you can also start the second repo with:',
    '  h7ymcp start --port 8788',
    '',
    'Stable ngrok or Cloudflare hostnames also cannot be shared by two running repositories at once.'
  ].join('\n');
}

async function assertPortAvailable(host, port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(portInUseHelp(host, port)));
        return;
      }
      reject(error);
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(numericPort, host);
  });
}

const spawnedChildren = new Set();

function spawnLogged(name, command, args, options = {}) {
  const { verbose = false, ...spawnOptions } = options;
  const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
  const logLines = [];
  const record = (stream, chunk) => {
    const text = String(chunk);
    logLines.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`));
    while (logLines.length > 120) logLines.shift();
    if (verbose) stream.write(`[${name}] ${text}`);
  };
  child.codexproLogTail = () => logLines.join('\n');
  spawnedChildren.add(child);
  child.stdout.on('data', (chunk) => record(process.stdout, chunk));
  child.stderr.on('data', (chunk) => record(process.stderr, chunk));
  child.on('exit', (code, signal) => {
    spawnedChildren.delete(child);
    if (verbose) console.error(`[${name}] exited code=${code} signal=${signal}`);
  });
  return child;
}

function waitForCloudflareUrl(child, timeoutMs = 45000) {
  const re = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for cloudflared public URL.')), timeoutMs);
    timer.unref();
    const onData = (chunk) => {
      const text = String(chunk);
      buffer += text;
      const match = buffer.match(re);
      if (match?.[0]) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before a URL was found, code=${code}`));
    });
  });
}

function killProcess(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, 1500).unref();
}

function cleanupChildren() {
  for (const child of spawnedChildren) killProcess(child);
}

function publicBaseFromHostname(hostname) {
  const raw = hostname.includes('://') ? hostname : `https://${hostname}`;
  const url = new URL(raw);
  if (url.pathname === '/mcp' || url.pathname.endsWith('/mcp')) {
    url.pathname = url.pathname.slice(0, -4) || '/';
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function readTokenFile(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  return fs.readFileSync(resolved, 'utf8').trim();
}

function normalizeMode(args) {
  const mode = args.mode ?? process.env.CODEXPRO_MODE ?? 'agent';
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }
  return mode;
}

function copyToClipboard(text) {
  const attempts = [];
  if (process.platform === 'darwin') attempts.push(['pbcopy', []]);
  else if (process.platform === 'win32') attempts.push(['cmd', ['/c', 'clip']]);
  else {
    attempts.push(['wl-copy', []]);
    attempts.push(['xclip', ['-selection', 'clipboard']]);
    attempts.push(['xsel', ['--clipboard', '--input']]);
  }

  for (const [command, args] of attempts) {
    const exists = command === 'cmd' || commandExists(command);
    if (!exists) continue;
    const result = spawnSync(command, args, {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false
    });
    if (result.status === 0) return { ok: true, command };
  }
  return { ok: false, command: '' };
}

function openUrl(url) {
  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const [bin, args] = command;
  if (bin !== 'cmd' && !commandExists(bin)) return false;
  const result = spawnSync(bin, args, { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function waitForProcessExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForPublicHealth(publicBase, token, tunnelChild, tunnelLabel = 'tunnel') {
  const health = waitForHealth(`${publicBase}/healthz`, token, 60000);
  const exit = waitForProcessExit(tunnelChild).then(({ code, signal }) => {
    throw new Error(`${tunnelLabel} exited before ${publicBase}/healthz was reachable, code=${code} signal=${signal}`);
  });
  return Promise.race([health, exit]);
}

function isSubpath(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function contextDirFromArgs(args) {
  return args.contextDir ?? process.env.CODEXPRO_CONTEXT_DIR ?? '.ai-bridge';
}

function resolveWorkspaceFile(root, relativePath) {
  const absPath = path.resolve(root, relativePath);
  if (!isSubpath(absPath, root)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return absPath;
}

function readTextFileBounded(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
  const sample = fs.readFileSync(filePath, { encoding: null });
  if (sample.includes(0)) throw new Error(`Refusing to read binary file: ${filePath}`);
  return sample.toString('utf8');
}

function numberOption(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function handoffMaxReadBytes() {
  return numberOption(process.env.CODEXPRO_MAX_READ_BYTES, 180_000, 4_000, 2_000_000);
}

function shellCommandPreview(parts) {
  return parts.map((part) => {
    const text = String(part);
    if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, "'\\''")}'`;
  }).join(' ');
}

function redactForLog(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*=\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|`[^`\r\n]{12,}`|[A-Za-z0-9_./+=-]{20,})/gi, (match) => {
      const index = match.indexOf('=');
      return index < 0 ? '[REDACTED_SECRET]' : `${match.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
    });
}

function trimBytes(value, maxBytes) {
  const redacted = redactForLog(value);
  const buffer = Buffer.from(redacted, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: redacted, truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[output truncated to ${maxBytes} bytes]`,
    truncated: true
  };
}

function splitCommandTemplate(input) {
  const tokens = [];
  let current = '';
  let quote = '';
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      if (next && (next === quote || next === '\\' || (!quote && /\s|["']/.test(next)))) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error('Custom command has an unterminated quote.');
  if (current) tokens.push(current);
  return tokens;
}

function applyCommandTemplate(value, replacements) {
  return String(value).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => replacements[key] ?? '');
}

function buildExecutorCommand(args, root, planPath, planText) {
  const agent = String(args.agent ?? 'opencode').trim().toLowerCase();
  const model = String(args.model ?? process.env.CODEXPRO_AGENT_MODEL ?? '').trim();
  const replacements = {
    model,
    plan_file: planPath,
    plan_text: planText,
    root
  };

  if (args.command) {
    const template = String(args.command);
    if (!/\{\{\s*(plan_file|plan_text)\s*\}\}/.test(template)) {
      throw new Error('Custom --command must include {{plan_file}} or {{plan_text}} so the agent receives the handoff.');
    }
    const parts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, replacements));
    const displayParts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, { ...replacements, plan_text: '<plan_text>' }));
    if (!parts.length) throw new Error('Custom --command is empty.');
    return { agent, model, command: parts[0], args: parts.slice(1), displayArgs: displayParts.slice(1), custom: true };
  }

  if (agent === 'opencode') {
    return {
      agent,
      model,
      command: 'opencode',
      args: ['run', ...(model ? ['--model', model] : []), planText],
      displayArgs: ['run', ...(model ? ['--model', model] : []), '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'pi') {
    return {
      agent,
      model,
      command: 'pi',
      args: [...(model ? ['--model', model] : []), '-p', planText],
      displayArgs: [...(model ? ['--model', model] : []), '-p', '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'codex') {
    return {
      agent,
      model,
      command: 'codex',
      args: ['exec', ...(model ? ['--model', model] : []), planText],
      displayArgs: ['exec', ...(model ? ['--model', model] : []), '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'custom') {
    throw new Error('Custom agent execution requires --command.');
  }
  throw new Error(`Unsupported --agent ${agent}. Use opencode, pi, codex, or custom with --command.`);
}

function executorCommandPreview(commandInfo) {
  return shellCommandPreview([commandInfo.command, ...(commandInfo.displayArgs ?? commandInfo.args)]);
}

function runProcessCaptured(command, args, options) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1500).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes * 2) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, 'utf8') > maxOutputBytes * 2) child.kill('SIGTERM');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        signal: null,
        durationMs: Date.now() - started,
        timedOut,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        spawnError: true
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const out = trimBytes(stdout, maxOutputBytes);
      const err = trimBytes(`${stderr}${timedOut ? `\n[codexpro] Command timed out after ${timeoutMs} ms.` : ''}`, maxOutputBytes);
      resolve({
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        spawnError: false
      });
    });
  });
}

function readGitDiff(root, maxBytes) {
  const result = spawnSync('git', ['diff', '--no-ext-diff', '--'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: Math.max(maxBytes * 2, 1_000_000),
    shell: false
  });
  if (result.status !== 0) {
    const reason = result.stderr || result.stdout || `git diff exited ${result.status}`;
    return `# git diff unavailable\n\n${redactForLog(reason).trim()}\n`;
  }
  const diff = result.stdout || '';
  if (!diff.trim()) return '';
  return trimBytes(diff, maxBytes).text;
}

function codeBlock(label, value) {
  return `## ${label}\n\n\`\`\`text\n${String(value || '').replace(/```/g, '`\\`\\`') || '(empty)'}\n\`\`\`\n`;
}

function writeExecutionOutputs(root, contextDir, commandInfo, result, diffText) {
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const statusPath = path.join(bridgeDir, 'agent-status.md');
  const diffPath = path.join(bridgeDir, 'implementation-diff.patch');
  const logPath = path.join(bridgeDir, 'execution-log.jsonl');
  const commandText = executorCommandPreview(commandInfo);
  const status = [
    '# Agent Execution Status',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Agent: ${commandInfo.agent}`,
    commandInfo.model ? `Model: ${commandInfo.model}` : '',
    `Command: ${commandText}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.signal ? `Signal: ${result.signal}` : '',
    `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `Duration: ${result.durationMs} ms`,
    `Diff path: ${path.posix.join(contextDir, 'implementation-diff.patch')}`,
    `Execution log: ${path.posix.join(contextDir, 'execution-log.jsonl')}`,
    '',
    codeBlock('Stdout excerpt', result.stdout),
    codeBlock('Stderr excerpt', result.stderr)
  ].filter(Boolean).join('\n');
  fs.writeFileSync(statusPath, status, { mode: 0o600 });
  fs.writeFileSync(diffPath, diffText || '', { mode: 0o600 });
  const logEvent = {
    ts: new Date().toISOString(),
    event: 'execute_handoff',
    agent: commandInfo.agent,
    model: commandInfo.model || undefined,
    command: commandText,
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
    stdout_excerpt: result.stdout,
    stderr_excerpt: result.stderr,
    diff_path: path.posix.join(contextDir, 'implementation-diff.patch'),
    status_path: path.posix.join(contextDir, 'agent-status.md')
  };
  fs.appendFileSync(logPath, `${JSON.stringify(logEvent)}\n`, { mode: 0o600 });
  return { statusPath, diffPath, logPath };
}

async function confirmLocalExecution(args, root, commandInfo) {
  if (args.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Use --yes to execute a local handoff in non-interactive shells, or use --dry-run to preview.');
  }
  printBox('Confirm local execution', [
    labelValue('Workspace', root),
    labelValue('Agent', commandInfo.agent),
    ...(commandInfo.model ? [labelValue('Model', commandInfo.model)] : []),
    labelValue('Command', executorCommandPreview(commandInfo)),
    'This runs a local process in the workspace. H7Y MCP will collect status, logs, and git diff into .ai-bridge.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Run this local agent now?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function loadHandoffExecution(args) {
  const root = realDir(args.root ?? editionEnv('ROOT') ?? process.cwd());
  const contextDir = contextDirFromArgs(args);
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  const planPath = path.join(bridgeDir, 'current-plan.md');
  const maxReadBytes = handoffMaxReadBytes();
  const maxOutputBytes = numberOption(args.maxOutputBytes ?? process.env.CODEXPRO_MAX_OUTPUT_BYTES, 120_000, 4_000, 2_000_000);
  const timeoutMs = numberOption(args.timeoutMs ?? args.timeout, 600_000, 1_000, 24 * 60 * 60_000);
  if (!fs.existsSync(planPath)) {
    throw new Error(`No handoff plan found at ${path.relative(root, planPath)}. Ask ChatGPT to call handoff_to_agent first.`);
  }
  const planText = readTextFileBounded(planPath, maxReadBytes);
  const commandInfo = buildExecutorCommand(args, root, planPath, planText);
  const commandText = executorCommandPreview(commandInfo);
  return {
    root,
    contextDir,
    bridgeDir,
    planPath,
    planText,
    commandInfo,
    commandText,
    maxOutputBytes,
    timeoutMs
  };
}

function printHandoffDryRun(request, title = 'H7Y MCP execute-handoff dry run') {
  printBox(title, [
    labelValue('Workspace', request.root),
    labelValue('Plan', path.relative(request.root, request.planPath)),
    labelValue('Agent', request.commandInfo.agent),
    ...(request.commandInfo.model ? [labelValue('Model', request.commandInfo.model)] : []),
    labelValue('Command', request.commandText),
    'No command was executed and no .ai-bridge result files were changed.'
  ]);
}

async function executeHandoffRequest(request, args, options = {}) {
  const confirmed = options.skipConfirmation ? true : await confirmLocalExecution(args, request.root, request.commandInfo);
  if (!confirmed) {
    statusLine('warn', 'Execution cancelled.');
    return { cancelled: true, result: null, outputs: null };
  }

  if (!commandAvailableFromRoot(request.commandInfo.command, request.root)) {
    throw new Error(`${request.commandInfo.command} was not found. Install it, add it to PATH, pass an absolute path, or use --command.`);
  }

  statusLine('wait', `Running ${request.commandInfo.agent}: ${request.commandText}`);
  const result = await runProcessCaptured(request.commandInfo.command, request.commandInfo.args, {
    cwd: request.root,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes
  });
  const diffText = readGitDiff(request.root, request.maxOutputBytes);
  const outputs = writeExecutionOutputs(request.root, request.contextDir, request.commandInfo, result, diffText);
  statusLine(result.exitCode === 0 ? 'ok' : 'warn', `Agent exited with code ${result.exitCode ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''}`);
  console.log(`Status: ${path.relative(request.root, outputs.statusPath)}`);
  console.log(`Diff:   ${path.relative(request.root, outputs.diffPath)}`);
  console.log(`Log:    ${path.relative(request.root, outputs.logPath)}`);
  return { cancelled: false, result, outputs };
}

async function runExecuteHandoff(argv) {
  const args = parseArgs(argv);
  applyColorPreference(args);
  if (args.help) {
    usage();
    return;
  }
  const request = loadHandoffExecution(args);

  if (args.dryRun) {
    printHandoffDryRun(request);
    return;
  }

  const execution = await executeHandoffRequest(request, args);
  if (execution.result?.exitCode && execution.result.exitCode !== 0) process.exitCode = execution.result.exitCode;
}

function planHash(planText) {
  return createHash('sha256').update(planText).digest('hex');
}

function isScaffoldedHandoffPlan(planText) {
  return String(planText).trim() === '# Current Plan\n\nNo plan written yet.';
}

function readWatchState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeWatchState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function appendBridgeLog(root, contextDir, event) {
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(bridgeDir, 'execution-log.jsonl');
  fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function waitForStablePlan(planPath, debounceMs) {
  try {
    const before = fs.statSync(planPath);
    await sleep(debounceMs);
    const after = fs.statSync(planPath);
    return before.isFile() && after.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs;
  } catch {
    return false;
  }
}

async function confirmWatchHandoff(args, root) {
  if (args.yes || args.noConfirm) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Use --yes to start watch-handoff in non-interactive shells.');
  }
  printBox('Confirm handoff watcher', [
    labelValue('Workspace', root),
    labelValue('Agent', args.agent ?? 'opencode'),
    ...(args.model ? [labelValue('Model', args.model)] : []),
    'This starts a local-only watcher. Each new .ai-bridge/current-plan.md hash runs through the configured local agent.',
    'ChatGPT only writes the handoff plan; this terminal-owned process performs execution.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Start automatic local handoff execution?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function runWatchHandoff(argv) {
  const args = parseArgs(argv);
  applyColorPreference(args);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const contextDir = contextDirFromArgs(args);
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  const planPath = path.join(bridgeDir, 'current-plan.md');
  const statePath = resolveWorkspaceFile(root, args.stateFile ?? path.posix.join(contextDir, 'watch-handoff-state.json'));
  const pollIntervalMs = numberOption(args.pollIntervalMs ?? args.pollInterval, 2000, 250, 60_000);
  const debounceMs = numberOption(args.debounceMs, 500, 0, 30_000);
  let state = readWatchState(statePath);
  let lastDryRunHash = state.lastPlanHash ?? '';
  let lastSkippedHash = '';
  let stopped = false;

  if (!args.dryRun) {
    const approved = await confirmWatchHandoff(args, root);
    if (!approved) {
      statusLine('warn', 'Watcher cancelled.');
      return;
    }
  }

  printBox('H7Y MCP watch-handoff', [
    labelValue('Workspace', root),
    labelValue('Plan', path.relative(root, planPath)),
    labelValue('State', path.relative(root, statePath)),
    labelValue('Agent', args.agent ?? 'opencode'),
    ...(args.model ? [labelValue('Model', args.model)] : []),
    labelValue('Poll', `${pollIntervalMs} ms`),
    labelValue('Debounce', `${debounceMs} ms`),
    args.once ? 'Mode: check once and exit.' : 'Mode: watching until Ctrl+C.'
  ]);

  const stop = () => {
    stopped = true;
    statusLine('warn', 'Stopping handoff watcher...');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    if (!fs.existsSync(planPath)) {
      if (args.once) throw new Error(`No handoff plan found at ${path.relative(root, planPath)}.`);
      await sleep(pollIntervalMs);
      continue;
    }

    const stable = await waitForStablePlan(planPath, debounceMs);
    if (!stable) {
      if (args.once) throw new Error(`Handoff plan did not become stable at ${path.relative(root, planPath)}.`);
      await sleep(pollIntervalMs);
      continue;
    }

    const request = loadHandoffExecution({ ...args, root, contextDir });
    const currentHash = planHash(request.planText);
    if (isScaffoldedHandoffPlan(request.planText)) {
      if (lastSkippedHash !== currentHash) statusLine('wait', 'Ignoring scaffolded empty handoff plan.');
      lastSkippedHash = currentHash;
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }
    if (state.lastPlanHash === currentHash || lastDryRunHash === currentHash) {
      statusLine(args.once ? 'ok' : 'wait', `No new handoff plan: ${currentHash.slice(0, 12)}`);
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }

    if (args.dryRun) {
      printHandoffDryRun(request, 'H7Y MCP watch-handoff dry run');
      lastDryRunHash = currentHash;
      if (args.once) return;
      await sleep(pollIntervalMs);
      continue;
    }

    appendBridgeLog(root, contextDir, {
      event: 'watch_handoff_started',
      plan_hash: currentHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      plan_path: path.posix.join(contextDir, 'current-plan.md')
    });

    const execution = await executeHandoffRequest(request, { ...args, yes: true }, { skipConfirmation: true });
    const exitCode = execution.result?.exitCode ?? null;
    state = {
      lastPlanHash: currentHash,
      lastRanAt: new Date().toISOString(),
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      exitCode,
      planPath: path.posix.join(contextDir, 'current-plan.md')
    };
    writeWatchState(statePath, state);
    appendBridgeLog(root, contextDir, {
      event: 'watch_handoff_finished',
      plan_hash: currentHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      exit_code: exitCode,
      status_path: path.posix.join(contextDir, 'agent-status.md'),
      diff_path: path.posix.join(contextDir, 'implementation-diff.patch')
    });

    if (args.once) {
      if (exitCode && exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    await sleep(pollIntervalMs);
  }
}

function loopArtifactPaths(root, contextDir) {
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  return {
    bridgeDir,
    planPath: path.join(bridgeDir, 'current-plan.md'),
    statusPath: path.join(bridgeDir, 'agent-status.md'),
    diffPath: path.join(bridgeDir, 'implementation-diff.patch'),
    logPath: path.join(bridgeDir, 'execution-log.jsonl'),
    testsPath: path.join(bridgeDir, 'loop-tests.txt'),
    reviewPath: path.join(bridgeDir, 'loop-review.md'),
    statePath: path.join(bridgeDir, 'loop-handoff-state.json')
  };
}

function buildTemplateCommand(template, replacements, displayReplacements, label) {
  const parts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, replacements));
  const displayParts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, displayReplacements ?? replacements));
  if (!parts.length) throw new Error(`${label} command is empty.`);
  return {
    command: parts[0],
    args: parts.slice(1),
    displayArgs: displayParts.slice(1),
    displayCommand: shellCommandPreview([displayParts[0], ...displayParts.slice(1)])
  };
}

function loopTemplateReplacements(root, contextDir, iteration, paths) {
  return {
    root,
    context_dir: resolveWorkspaceFile(root, contextDir),
    iteration: String(iteration),
    plan_file: paths.planPath,
    status_file: paths.statusPath,
    diff_file: paths.diffPath,
    log_file: paths.logPath,
    tests_file: paths.testsPath,
    review_file: paths.reviewPath,
    state_file: paths.statePath
  };
}

function buildReviewerCommand(args, root, contextDir, iteration, paths) {
  const template = String(args.reviewCommand ?? '').trim();
  if (!template) throw new Error('loop-handoff requires --review-command <template>.');
  const replacements = loopTemplateReplacements(root, contextDir, iteration, paths);
  return buildTemplateCommand(template, replacements, replacements, 'Review');
}

function buildTestCommand(args, root, contextDir, iteration, paths) {
  const template = String(args.runTests ?? '').trim();
  if (!template) return null;
  const replacements = loopTemplateReplacements(root, contextDir, iteration, paths);
  return buildTemplateCommand(template, replacements, replacements, 'Test');
}

function commandDisplay(commandInfo) {
  return shellCommandPreview([commandInfo.command, ...(commandInfo.displayArgs ?? commandInfo.args)]);
}

function gitStatusPorcelain(root, maxBytes = 1_000_000) {
  return runGitText(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'], maxBytes);
}

function normalizedContextDir(contextDir) {
  return String(contextDir || '.ai-bridge').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

function normalizeStatusPath(value) {
  return String(value || '').replace(/^"|"$/g, '').replace(/\\"/g, '"');
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function statusLinePaths(line) {
  const value = String(line || '').slice(3).trim();
  const renameIndex = value.indexOf(' -> ');
  if (renameIndex < 0) return [normalizeStatusPath(value)];
  return [
    normalizeStatusPath(value.slice(0, renameIndex)),
    normalizeStatusPath(value.slice(renameIndex + 4))
  ];
}

function gitWorkspacePrefix(root) {
  return toPosixPath(runGitText(root, ['rev-parse', '--show-prefix'], 100_000).trim()).replace(/\/+$/, '');
}

function workspacePathFromGitPath(filePath, workspacePrefix) {
  const normalized = toPosixPath(filePath).replace(/^\.?\//, '');
  const prefix = toPosixPath(workspacePrefix).replace(/\/+$/, '');
  if (!prefix) return normalized;
  // Git may report paths relative to the current working directory when the
  // workspace is nested inside a larger repository. In that case the path is
  // already workspace-relative and should not be stripped again.
  if (!normalized.startsWith(`${prefix}/`) && normalized !== prefix) return normalized;
  if (normalized === prefix) return '';
  if (normalized.startsWith(`${prefix}/`)) return normalized.slice(prefix.length + 1);
  return null;
}

function statusLineWorkspacePaths(line, workspacePrefix) {
  return statusLinePaths(line)
    .map((filePath) => workspacePathFromGitPath(filePath, workspacePrefix))
    .filter((filePath) => filePath !== null && filePath !== '');
}

function workspaceStatusLine(line, workspacePaths) {
  return `${String(line || '').slice(0, 3)}${workspacePaths.join(' -> ')}`;
}

function isContextStatusLine(line, contextDir, workspacePrefix = '') {
  const context = normalizedContextDir(contextDir);
  const paths = statusLineWorkspacePaths(line, workspacePrefix);
  return paths.length > 0 && paths.every((filePath) => filePath === context || filePath.startsWith(`${context}/`));
}

function assertCleanGitStart(root, contextDir) {
  const status = gitStatusPorcelain(root);
  const workspacePrefix = gitWorkspacePrefix(root);
  const nonContextStatus = status.split(/\r?\n/).map((line) => {
    if (!line.trim()) return '';
    const paths = statusLineWorkspacePaths(line, workspacePrefix);
    if (!paths.length || paths.every(contextPathPredicate(contextDir))) return '';
    return workspaceStatusLine(line, paths);
  }).filter(Boolean).join('\n');
  if (nonContextStatus.trim()) {
    throw new Error(`--require-clean-git-start refused to start because the workspace has non-handoff changes:\n${nonContextStatus}`);
  }
}

function runGitText(root, args, maxBytes) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: Math.max(maxBytes * 2, 1_000_000),
    shell: false
  });
  if (result.status !== 0) {
    const reason = result.stderr || result.stdout || `git ${args.join(' ')} exited ${result.status}`;
    throw new Error(redactForLog(reason).trim());
  }
  return result.stdout || '';
}

function singleLineSummary(value) {
  return String(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function fileSha256(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function boundedFileFingerprint(filePath, stat) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let remaining = Math.min(stat.size, UNTRACKED_FILE_HASH_BYTES);
  try {
    while (remaining > 0) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  const hashLabel = stat.size > UNTRACKED_FILE_HASH_BYTES ? `sha256_first_${UNTRACKED_FILE_HASH_BYTES}` : 'sha256';
  const truncated = stat.size > UNTRACKED_FILE_HASH_BYTES ? ', fingerprint_truncated=true' : '';
  return `${stat.size} bytes, ${hashLabel}=${hash.digest('hex')}${truncated}`;
}

function untrackedEntrySummary(root, relPath) {
  const absPath = path.resolve(root, relPath);
  try {
    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      const target = singleLineSummary(trimBytes(fs.readlinkSync(absPath), UNTRACKED_SYMLINK_TARGET_BYTES).text);
      return `- ${relPath} (symlink, target=${target})`;
    }
    if (!stat.isFile()) return `- ${relPath} (${stat.isDirectory() ? 'directory' : 'non-file'})`;
    return `- ${relPath} (${boundedFileFingerprint(absPath, stat)})`;
  } catch (error) {
    return `- ${relPath} (unavailable: ${singleLineSummary(redactForLog(error instanceof Error ? error.message : String(error)))})`;
  }
}

function untrackedFilesSummary(root, contextDir, maxBytes) {
  const context = normalizedContextDir(contextDir);
  const output = runGitText(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], 1_000_000);
  const entries = output.split('\0').filter(Boolean).filter((relPath) => relPath !== context && !relPath.startsWith(`${context}/`));
  if (!entries.length) return '';
  const lines = [];
  let usedBytes = 0;
  let omitted = 0;
  const budget = Math.max(1_024, maxBytes);
  for (const relPath of entries.sort()) {
    const line = untrackedEntrySummary(root, relPath);
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (usedBytes + lineBytes > budget) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    usedBytes += lineBytes;
  }
  if (omitted) lines.push(`- ... ${omitted} untracked entries omitted after ${budget} bytes`);
  return `${lines.join('\n')}\n`;
}

function contextPathPredicate(contextDir) {
  const context = normalizedContextDir(contextDir);
  return (filePath) => filePath === context || filePath.startsWith(`${context}/`);
}

function pathStateForFingerprint(root, relPath, options = {}) {
  const absPath = path.resolve(root, relPath);
  try {
    const stat = fs.lstatSync(absPath);
    const type = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isFile()
        ? 'file'
        : stat.isDirectory()
          ? 'directory'
          : 'non-file';
    const parts = [
      `type=${type}`,
      `mode=${stat.mode}`,
      `size=${stat.size}`
    ];
    if (stat.isSymbolicLink()) parts.push(`target=${singleLineSummary(fs.readlinkSync(absPath))}`);
    if (stat.isFile()) {
      parts.push(options.fullFileHash ? `sha256=${fileSha256(absPath)}` : boundedFileFingerprint(absPath, stat));
    }
    return parts.join(';');
  } catch (error) {
    return `unavailable:${singleLineSummary(redactForLog(error instanceof Error ? error.message : String(error)))}`;
  }
}

function changeFingerprintExcludingContext(root, contextDir) {
  const context = normalizedContextDir(contextDir);
  const isContextPath = contextPathPredicate(contextDir);
  const workspacePrefix = gitWorkspacePrefix(root);
  const status = gitStatusPorcelain(root, 25_000_000);
  const stagedRaw = runGitText(root, ['diff', '--cached', '--raw', '-z', '--no-ext-diff', '--', '.', `:(exclude)${context}`], 25_000_000);
  const hash = createHash('sha256');
  hash.update(`staged-raw\0${stagedRaw}\0`);
  for (const line of status.split(/\r?\n/).filter(Boolean).sort()) {
    const paths = statusLineWorkspacePaths(line, workspacePrefix);
    if (!paths.length) continue;
    if (paths.length && paths.every(isContextPath)) continue;
    hash.update(`status\0${workspaceStatusLine(line, paths)}\0`);
    const fullFileHash = !line.startsWith('?? ');
    for (const filePath of paths) {
      hash.update(`path\0${filePath}\0${pathStateForFingerprint(root, filePath, { fullFileHash })}\0`);
    }
  }
  return hash.digest('hex');
}

function readGitDiffExcludingContext(root, contextDir, maxBytes) {
  const context = normalizedContextDir(contextDir);
  try {
    const staged = runGitText(root, ['diff', '--cached', '--no-ext-diff', '--', '.', `:(exclude)${context}`], maxBytes);
    const unstaged = runGitText(root, ['diff', '--no-ext-diff', '--', '.', `:(exclude)${context}`], maxBytes);
    const untracked = untrackedFilesSummary(root, contextDir, maxBytes);
    const sections = [];
    if (staged.trim()) sections.push(`# Staged diff\n\n${staged}`);
    if (unstaged.trim()) sections.push(`# Unstaged diff\n\n${unstaged}`);
    if (untracked.trim()) sections.push(`# Untracked files\n\n${untracked}`);
    if (!sections.length) return '';
    return trimBytes(sections.join('\n\n'), maxBytes).text;
  } catch (error) {
    return `# git changes unavailable\n\n${error instanceof Error ? error.message : String(error)}\n`;
  }
}

function writeLoopTestOutput(paths, result, commandText) {
  fs.mkdirSync(paths.bridgeDir, { recursive: true, mode: 0o700 });
  const content = [
    '# Loop Test Output',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Command: ${commandText}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.signal ? `Signal: ${result.signal}` : '',
    `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `Duration: ${result.durationMs} ms`,
    '',
    codeBlock('Stdout excerpt', result.stdout),
    codeBlock('Stderr excerpt', result.stderr)
  ].filter(Boolean).join('\n');
  fs.writeFileSync(paths.testsPath, content, { mode: 0o600 });
}

function explicitReviewVerdict(text) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const assignment = line.match(/^CODEXPRO_REVIEW\s*=\s*(PASS|FAIL)\b/i);
    if (assignment) return assignment[1].toUpperCase();
  }
  return '';
}

function writeLoopReviewOutput(paths, result, commandText, verdict, nextPlanChanged) {
  fs.mkdirSync(paths.bridgeDir, { recursive: true, mode: 0o700 });
  const content = [
    '# Loop Review',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Command: ${commandText}`,
    `Verdict: ${verdict || 'unknown'}`,
    `Next plan changed: ${nextPlanChanged ? 'yes' : 'no'}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.signal ? `Signal: ${result.signal}` : '',
    `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `Duration: ${result.durationMs} ms`,
    '',
    codeBlock('Stdout excerpt', result.stdout),
    codeBlock('Stderr excerpt', result.stderr)
  ].filter(Boolean).join('\n');
  fs.writeFileSync(paths.reviewPath, content, { mode: 0o600 });
}

async function runLoopCommand(commandInfo, root, timeoutMs, maxOutputBytes, label) {
  if (!commandAvailableFromRoot(commandInfo.command, root)) {
    throw new Error(`${label} command was not found: ${commandInfo.command}`);
  }
  statusLine('wait', `Running ${label.toLowerCase()}: ${commandDisplay(commandInfo)}`);
  return runProcessCaptured(commandInfo.command, commandInfo.args, {
    cwd: root,
    timeoutMs,
    maxOutputBytes
  });
}

function assertLoopCommandAvailable(commandInfo, root, label) {
  if (!commandAvailableFromRoot(commandInfo.command, root)) {
    throw new Error(`${label} command was not found before starting loop-handoff: ${commandInfo.command}`);
  }
}

function preflightLoopCommands(request, reviewCommand, testCommand) {
  assertLoopCommandAvailable(request.commandInfo, request.root, 'Executor');
  assertLoopCommandAvailable(reviewCommand, request.root, 'Review');
  if (testCommand) assertLoopCommandAvailable(testCommand, request.root, 'Test');
}

async function confirmLoopHandoff(args, root) {
  if (args.yes || args.noConfirm || args.dryRun) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Use --yes to start loop-handoff in non-interactive shells, or use --dry-run to preview.');
  }
  printBox('Confirm handoff loop', [
    labelValue('Workspace', root),
    labelValue('Agent', args.agent ?? 'opencode'),
    ...(args.model ? [labelValue('Model', args.model)] : []),
    labelValue('Max iters', args.maxIters ?? '3'),
    labelValue('Reviewer', args.reviewCommand ?? ''),
    'This runs local executor and reviewer commands in a bounded loop. It does not automate ChatGPT or any browser session.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Start local execute/review loop?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function confirmLoopContinuation(args, root, iteration, planPath) {
  if (!args.requireHumanConfirmation) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('--require-human-confirmation needs an interactive terminal before running follow-up plans.');
  }
  printBox('Confirm follow-up plan', [
    labelValue('Workspace', root),
    labelValue('Iteration', String(iteration)),
    labelValue('Plan', path.relative(root, planPath)),
    'The reviewer wrote or kept a follow-up plan. Review it before continuing.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Run the next local executor iteration?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function printLoopDryRun(request, reviewCommand, testCommand, maxIters) {
  printBox('H7Y MCP loop-handoff dry run', [
    labelValue('Workspace', request.root),
    labelValue('Plan', path.relative(request.root, request.planPath)),
    labelValue('Agent', request.commandInfo.agent),
    ...(request.commandInfo.model ? [labelValue('Model', request.commandInfo.model)] : []),
    labelValue('Max iters', String(maxIters)),
    labelValue('Executor', request.commandText),
    ...(testCommand ? [labelValue('Tests', commandDisplay(testCommand))] : []),
    labelValue('Reviewer', commandDisplay(reviewCommand)),
    'No command was executed and no .ai-bridge result files were changed.'
  ]);
}

function writeLoopState(paths, state) {
  fs.mkdirSync(paths.bridgeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function runLoopHandoff(argv) {
  const args = parseArgs(argv);
  applyColorPreference(args);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const contextDir = contextDirFromArgs(args);
  const paths = loopArtifactPaths(root, contextDir);
  const maxIters = numberOption(args.maxIters ?? args.maxIterations, 3, 1, 25);
  const maxReadBytes = handoffMaxReadBytes();
  const maxOutputBytes = numberOption(args.maxOutputBytes ?? process.env.CODEXPRO_MAX_OUTPUT_BYTES, 120_000, 4_000, 2_000_000);
  const reviewTimeoutMs = numberOption(args.reviewTimeoutMs, 600_000, 1_000, 24 * 60 * 60_000);
  const testTimeoutMs = numberOption(args.testTimeoutMs, 600_000, 1_000, 24 * 60 * 60_000);

  if (args.requireCleanGitStart) assertCleanGitStart(root, contextDir);

  let request = loadHandoffExecution({ ...args, root, contextDir });
  const reviewCommand = buildReviewerCommand(args, root, contextDir, 1, paths);
  const testCommand = buildTestCommand(args, root, contextDir, 1, paths);

  if (args.dryRun) {
    printLoopDryRun(request, reviewCommand, testCommand, maxIters);
    return;
  }

  preflightLoopCommands(request, reviewCommand, testCommand);

  const approved = await confirmLoopHandoff(args, root);
  if (!approved) {
    statusLine('warn', 'Loop cancelled.');
    return;
  }

  printBox('H7Y MCP loop-handoff', [
    labelValue('Workspace', root),
    labelValue('Plan', path.relative(root, paths.planPath)),
    labelValue('Agent', request.commandInfo.agent),
    ...(request.commandInfo.model ? [labelValue('Model', request.commandInfo.model)] : []),
    labelValue('Max iters', String(maxIters)),
    labelValue('Reviewer', commandDisplay(reviewCommand)),
    ...(testCommand ? [labelValue('Tests', commandDisplay(testCommand))] : []),
    'Mode: local execute/review loop. No ChatGPT or browser session is automated.'
  ]);

  let previousChangeFingerprint = '';
  let finalVerdict = 'FAIL';
  let stopReason = 'max_iters';

  for (let iteration = 1; iteration <= maxIters; iteration += 1) {
    if (iteration > 1) {
      const continueLoop = await confirmLoopContinuation(args, root, iteration, paths.planPath);
      if (!continueLoop) {
        stopReason = 'human_cancelled';
        break;
      }
    }

    request = loadHandoffExecution({ ...args, root, contextDir });
    const currentPlanHash = planHash(request.planText);
    if (isScaffoldedHandoffPlan(request.planText)) {
      stopReason = 'scaffolded_plan';
      statusLine('warn', 'Stopping because current-plan.md is still the empty scaffold.');
      break;
    }

    appendBridgeLog(root, contextDir, {
      event: 'loop_handoff_iteration_started',
      iteration,
      plan_hash: currentPlanHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined
    });

    const beforeExecutionFingerprint = changeFingerprintExcludingContext(root, contextDir);
    const execution = await executeHandoffRequest(request, { ...args, yes: true }, { skipConfirmation: true });
    const diffText = readGitDiffExcludingContext(root, contextDir, maxOutputBytes);
    fs.writeFileSync(paths.diffPath, diffText || '', { mode: 0o600 });
    const currentChangeFingerprint = changeFingerprintExcludingContext(root, contextDir);
    const changedThisIteration = currentChangeFingerprint !== beforeExecutionFingerprint;

    if (args.stopIfNoFilesChanged && !changedThisIteration) {
      finalVerdict = 'FAIL';
      stopReason = 'no_files_changed';
      statusLine('warn', 'Stopping because the executor produced no new git changes.');
      break;
    }
    if (args.stopIfSameDiff && previousChangeFingerprint && currentChangeFingerprint === previousChangeFingerprint) {
      finalVerdict = 'FAIL';
      stopReason = 'same_diff';
      statusLine('warn', 'Stopping because the executor repeated the previous diff.');
      break;
    }
    previousChangeFingerprint = currentChangeFingerprint;

    const iterationTestCommand = buildTestCommand(args, root, contextDir, iteration, paths);
    let testResult = null;
    if (iterationTestCommand) {
      testResult = await runLoopCommand(iterationTestCommand, root, testTimeoutMs, maxOutputBytes, 'Test');
      writeLoopTestOutput(paths, testResult, commandDisplay(iterationTestCommand));
      statusLine(testResult.exitCode === 0 ? 'ok' : 'warn', `Tests exited with code ${testResult.exitCode ?? 'null'}${testResult.signal ? ` signal=${testResult.signal}` : ''}`);
    }

    const iterationReviewCommand = buildReviewerCommand(args, root, contextDir, iteration, paths);
    const beforeReviewPlanExists = fs.existsSync(paths.planPath);
    const beforeReviewPlan = beforeReviewPlanExists ? readTextFileBounded(paths.planPath, maxReadBytes) : '';
    const reviewResult = await runLoopCommand(iterationReviewCommand, root, reviewTimeoutMs, maxOutputBytes, 'Review');
    const afterReviewPlanExists = fs.existsSync(paths.planPath);
    const afterReviewPlan = afterReviewPlanExists ? readTextFileBounded(paths.planPath, maxReadBytes) : '';
    const planDeletedByReview = beforeReviewPlanExists && !afterReviewPlanExists;
    const nextPlanChanged = planDeletedByReview || (afterReviewPlanExists && planHash(afterReviewPlan) !== planHash(beforeReviewPlan));
    const hasUsableFollowupPlan = afterReviewPlanExists && afterReviewPlan.trim() && !isScaffoldedHandoffPlan(afterReviewPlan);
    let verdict = explicitReviewVerdict(`${reviewResult.stdout}\n${reviewResult.stderr}`);
    if (!verdict && args.allowImplicitReviewVerdict && nextPlanChanged && reviewResult.exitCode === 0) verdict = 'FAIL';
    if (!verdict && args.allowImplicitReviewVerdict && afterReviewPlanExists && reviewResult.exitCode === 0 && execution.result?.exitCode === 0 && (!testResult || testResult.exitCode === 0)) verdict = 'PASS';
    writeLoopReviewOutput(paths, reviewResult, commandDisplay(iterationReviewCommand), verdict, nextPlanChanged);
    let acceptedVerdict = verdict;
    let rejectedPassReason = '';
    if (verdict === 'PASS' && reviewResult.exitCode !== 0) {
      acceptedVerdict = 'FAIL';
      rejectedPassReason = 'reviewer_failed';
    } else if (verdict === 'PASS' && !args.allowReviewPassOnFailure && execution.result?.exitCode !== 0) {
      acceptedVerdict = 'FAIL';
      rejectedPassReason = 'executor_failed';
    } else if (verdict === 'PASS' && !args.allowReviewPassOnFailure && testResult && testResult.exitCode !== 0) {
      acceptedVerdict = 'FAIL';
      rejectedPassReason = 'tests_failed';
    }

    appendBridgeLog(root, contextDir, {
      event: 'loop_handoff_iteration_finished',
      iteration,
      plan_hash: currentPlanHash,
      agent: request.commandInfo.agent,
      model: request.commandInfo.model || undefined,
      executor_exit_code: execution.result?.exitCode ?? null,
      test_exit_code: testResult?.exitCode ?? null,
      reviewer_exit_code: reviewResult.exitCode,
      reviewer_verdict: verdict,
      verdict: acceptedVerdict,
      rejected_pass_reason: rejectedPassReason || undefined,
      next_plan_changed: nextPlanChanged,
      followup_plan_exists: afterReviewPlanExists,
      has_usable_followup_plan: Boolean(hasUsableFollowupPlan),
      changed_this_iteration: changedThisIteration,
      status_path: path.posix.join(contextDir, 'agent-status.md'),
      diff_path: path.posix.join(contextDir, 'implementation-diff.patch'),
      tests_path: iterationTestCommand ? path.posix.join(contextDir, 'loop-tests.txt') : undefined,
      review_path: path.posix.join(contextDir, 'loop-review.md')
    });
    writeLoopState(paths, {
      updatedAt: new Date().toISOString(),
      iteration,
      maxIters,
      reviewerVerdict: verdict,
      verdict: acceptedVerdict,
      rejectedPassReason: rejectedPassReason || undefined,
      planHash: currentPlanHash,
      nextPlanChanged,
      followupPlanExists: afterReviewPlanExists,
      hasUsableFollowupPlan: Boolean(hasUsableFollowupPlan),
      changedThisIteration,
      executorExitCode: execution.result?.exitCode ?? null,
      reviewerExitCode: reviewResult.exitCode
    });

    if (acceptedVerdict === 'PASS') {
      finalVerdict = 'PASS';
      stopReason = 'pass';
      statusLine('ok', `Reviewer passed on iteration ${iteration}.`);
      break;
    }

    if (rejectedPassReason) {
      if (rejectedPassReason === 'reviewer_failed') {
        finalVerdict = 'FAIL';
        stopReason = 'reviewer_error';
        statusLine('warn', `Reviewer returned PASS, but reviewer process exited with code ${reviewResult.exitCode ?? 'null'}.`);
        break;
      }
      if (rejectedPassReason === 'executor_failed') {
        finalVerdict = 'FAIL';
        stopReason = 'executor_failed';
        statusLine('warn', `Reviewer returned PASS, but executor exited with code ${execution.result?.exitCode ?? 'null'}.`);
        break;
      }
      finalVerdict = 'FAIL';
      stopReason = 'tests_failed';
      statusLine('warn', `Reviewer returned PASS, but tests exited with code ${testResult?.exitCode ?? 'null'}.`);
      break;
    }

    if (acceptedVerdict !== 'FAIL') {
      finalVerdict = 'FAIL';
      stopReason = reviewResult.exitCode === 0 ? 'unknown_verdict' : 'reviewer_error';
      statusLine('warn', `Stopping because reviewer did not return a usable verdict. Exit code: ${reviewResult.exitCode ?? 'null'}`);
      break;
    }

    if (reviewResult.exitCode !== 0) {
      finalVerdict = 'FAIL';
      stopReason = 'reviewer_error';
      statusLine('warn', `Stopping because reviewer exited with code ${reviewResult.exitCode ?? 'null'}.`);
      break;
    }

    if (!nextPlanChanged || !hasUsableFollowupPlan) {
      finalVerdict = 'FAIL';
      stopReason = 'no_followup_plan';
      statusLine('warn', 'Reviewer returned FAIL but did not update current-plan.md.');
      break;
    }

    statusLine('wait', `Reviewer requested another iteration (${iteration}/${maxIters}).`);
  }

  appendBridgeLog(root, contextDir, {
    event: 'loop_handoff_finished',
    verdict: finalVerdict,
    stop_reason: stopReason
  });
  statusLine(finalVerdict === 'PASS' ? 'ok' : 'warn', `Loop finished: ${finalVerdict} (${stopReason}).`);
  console.log(`Status: ${path.relative(root, paths.statusPath)}`);
  console.log(`Diff:   ${path.relative(root, paths.diffPath)}`);
  console.log(`Review: ${path.relative(root, paths.reviewPath)}`);
  console.log(`Log:    ${path.relative(root, paths.logPath)}`);
  if (finalVerdict !== 'PASS') process.exitCode = 1;
}

function printConnectorBlock(endpoint, token, options = {}) {
  return runtimePrintConnectorBlock(endpoint, token, options, {
    copyToClipboard,
    openUrl,
    paint,
    panelDivider,
    panelKeyValue,
    panelLine,
    panelTitle,
    statusLine
  });
}

function printControlHelp() {
  uiPrintControlHelp();
}

function printModeHelp() {
  uiPrintModeHelp();
}

function printStableUrlHelp() {
  runtimePrintStableUrlHelp();
}

function compareMajorVersion(version, minimumMajor) {
  const major = Number(String(version).split('.')[0]);
  return Number.isFinite(major) && major >= minimumMajor;
}

function browserOpenCommand() {
  if (process.platform === 'darwin') return commandExists('open') ? 'open' : '';
  if (process.platform === 'win32') return 'cmd start';
  return commandExists('xdg-open') ? 'xdg-open' : '';
}

function clipboardCommand() {
  if (process.platform === 'darwin') return commandExists('pbcopy') ? 'pbcopy' : '';
  if (process.platform === 'win32') return 'clip';
  for (const command of ['wl-copy', 'xclip', 'xsel']) {
    if (commandExists(command)) return command;
  }
  return '';
}

function localOrPathCommand(command, localPath) {
  if (command && commandAvailable(command)) return command;
  if (localPath && executableFileExists(localPath)) return localPath;
  return '';
}

function doctorLine(status, label, detail = '') {
  const marker = status === 'ok' ? successMarker('OK') : status === 'warn' ? warningText('WARN') : errorText('FAIL');
  console.log(`${marker} ${padVisibleEnd(label, 18)} ${detail}`);
}

async function runDoctor(argv) {
  return runDoctorCommand(argv, {
    usage,
    parseArgs,
    applyColorPreference: uiApplyColorPreference,
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
    printBox: uiPrintBox,
    labelValue: uiLabelValue,
    statusLine: uiStatusLine,
    profileSummary
  });
}

function normalizeSetupChoice(value, allowed, fallback) {
  return sharedNormalizeSetupChoice(value, allowed, fallback);
}

async function ask(rl, question, fallback = '') {
  return sharedAsk(rl, question, fallback, { paint });
}

async function collectTunnelPreference(rl, defaults, profile, options = {}) {
  return sharedCollectTunnelPreference(rl, defaults, profile, options, { ask, optionValue });
}

function profileFromPreference(root, args, profile, preference) {
  return sharedProfileFromPreference(root, args, profile, preference, {
    bashSessionOptions,
    bashTranscriptOption,
    codexSessionsOption,
    normalizeAuthModeChoice,
    optionValue,
    optionalWriteOption,
    stableToken,
    toolCardsProfileEntry
  });
}

async function runSetupWizard(argv) {
  return runSetupWizardCommand(argv, {
    EDITION,
    applyColorPreference,
    ask,
    bashSessionOptions,
    bashTranscriptOption,
    codexSessionsOption,
    displayPath,
    effectiveWriteMode,
    envName,
    expandHome,
    formatCommandBlock,
    loadWorkspaceProfile,
    normalizeAuthModeChoice,
    normalizeOauthApprovalChoice,
    normalizeSetupChoice,
    optionBool,
    optionValue,
    optionalWriteOption,
    paint,
    panelDivider,
    panelKeyValue,
    panelLine,
    panelTitle,
    parseArgs,
    printBox,
    printSavedProfileHint,
    realDir,
    saveWorkspaceProfile,
    stableToken,
    statusLine
  });
}

async function maybeConfigureFirstRun(root, args, profile) {
  return maybeConfigureFirstRunCommand(root, args, profile, {
    applyTunnelPreferenceToArgs: sharedApplyTunnelPreferenceToArgs,
    ask,
    collectTunnelPreference,
    hasExplicitTunnelInput: sharedHasExplicitTunnelInput,
    listWorkspaceProfiles,
    loadWorkspaceProfile,
    optionValue,
    printBox,
    profileFromPreference,
    profileOneLine,
    reusableProfilePayload,
    saveWorkspaceProfile,
    statusLine
  });
}

async function runSettings(argv) {
  return runSettingsCommand(argv, {
    applyColorPreference,
    ask,
    bashSessionOptions,
    bashTranscriptOption,
    codexSessionsOption,
    collectTunnelPreference,
    deleteWorkspaceProfile,
    labelValue,
    listWorkspaceProfiles,
    loadWorkspaceProfile,
    normalizeAuthModeChoice,
    normalizeOauthApprovalChoice,
    normalizeSetupChoice,
    optionValue,
    parseArgs,
    printBox,
    profileFromPreference,
    profileOneLine,
    realDir,
    resolveConfigPath,
    reusableProfilePayload,
    sanitizedProfile,
    saveWorkspaceProfile,
    stableToken,
    statusLine,
    toolCardsProfileEntry,
    usage,
    writeOption
  });
}

function runControlPanel(details) {
  return runtimeRunControlPanel(details, {
    EDITION,
    cleanupChildren,
    copyToClipboard,
    openUrl,
    printControlHelp,
    printModeHelp
  });
}

async function runStart(argv) {
  return runStartCommand(argv, {
    EDITION,
    projectRoot,
    applyColorPreference,
    assertPortAvailable,
    bashSessionOptions,
    bashTranscriptOption,
    codexSessionsOption,
    cleanupChildren,
    editionEnv,
    envName,
    loadWorkspaceProfile,
    maybeConfigureFirstRun,
    ngrokConfigPath,
    normalizeOauthApprovalChoice,
    optionBool,
    optionValue,
    parseArgs,
    printConnectorBlock,
    printStableUrlHelp,
    printStartSummary,
    profileSummary,
    publicBaseFromHostname,
    realDir,
    resolveCloudflared,
    resolveCodexDir,
    resolveConfigPath,
    resolveNgrok,
    runControlPanel,
    saveRuntimeConnection,
    spawnLogged,
    stableToken,
    statusLine,
    usage,
    waitForCloudflareUrl,
    waitForHealth,
    waitForPublicHealth,
    writeOption
  });
}

async function main() {
  return runCli(process.argv.slice(2), {
    applyColorPreference,
    installCloudflaredLocal,
    parseArgs,
    printStableUrlHelp,
    rawColorArg,
    runDoctor,
    runExecuteHandoff,
    runHelperScript,
    runLoopHandoff,
    runSettings,
    runSetupWizard,
    runStart,
    runWatchHandoff,
    usage
  });
}

main().catch((error) => {
  cleanupChildren();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${errorText('Error:')} ${message}`);
  if (process.env.CODEXPRO_DEBUG === '1' && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
