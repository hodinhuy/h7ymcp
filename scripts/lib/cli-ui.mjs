import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export function createCliUi({ cliName = 'h7ymcp', productName = 'H7Y MCP', colorEnvName = 'PERSONAL_COLOR' } = {}) {
  let colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
  const ansi = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    brightYellow: '\x1b[93m',
    brightGreen: '\x1b[92m',
    underline: '\x1b[4m'
  };

  function paint(style, text) {
    if (!colorEnabled) return text;
    const styles = Array.isArray(style) ? style : [style];
    const codes = styles.map((item) => ansi[item] ?? '').join('');
    return `${codes}${text}${ansi.reset}`;
  }

  function stripAnsi(text) {
    return String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  }

  function visibleLength(text) {
    return stripAnsi(text).length;
  }

  function padVisibleEnd(text, width) {
    return `${text}${' '.repeat(Math.max(0, width - visibleLength(text)))}`;
  }

  function validateColorMode(value, label) {
    if (value === undefined || value === null || value === '') return '';
    const normalized = String(value).trim().toLowerCase();
    if (['always', 'auto', 'never'].includes(normalized)) return normalized;
    throw new Error(`${label} must be always, auto, or never`);
  }

  function rawColorArg(argv = []) {
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--color') return argv[i + 1] ?? '';
    }
    return '';
  }

  function applyColorPreference(args = {}) {
    const cliColor = validateColorMode(args.color, '--color');
    const envColor = validateColorMode(process.env[colorEnvName], colorEnvName);
    if (!cliColor && process.env.NO_COLOR) {
      colorEnabled = false;
      return colorEnabled;
    }
    const mode = cliColor || envColor || 'auto';
    colorEnabled = mode === 'always' ? true : mode === 'never' ? false : Boolean(process.stdout.isTTY);
    return colorEnabled;
  }

  function printSectionTitle(title, options = {}) {
    void options;
    console.log(paint(['bold'], title));
  }

  function termWidth(max = 78) {
    return Math.max(56, Math.min(max, process.stdout.columns || max));
  }

  function panelWidth() {
    return termWidth(90);
  }

  function panelPad(text, width = panelWidth()) {
    const plain = String(text ?? '');
    return `${plain}${' '.repeat(Math.max(0, width - visibleLength(plain)))}`;
  }

  function panelLine(text = '', options = {}) {
    const width = options.width ?? panelWidth();
    const content = panelPad(text, width);
    const line = options.contentStyle ? paint(options.contentStyle, content) : content;
    console.log(line);
  }

  function panelDivider(character = '-') {
    panelLine(paint('dim', character.repeat(panelWidth())));
  }

  function panelKeyValue(label, value, options = {}) {
    const labelWidth = options.labelWidth ?? 16;
    const labelStyle = options.labelStyle ?? [];
    const labelText = labelStyle.length ? paint(labelStyle, padVisibleEnd(label, labelWidth)) : padVisibleEnd(label, labelWidth);
    const valueStyle = options.valueStyle ?? undefined;
    const valueText = valueStyle ? paint(valueStyle, String(value)) : String(value);
    panelLine(`${labelText} ${valueText}`);
  }

  function wrapLine(text, width) {
    if (visibleLength(text) <= width) return [text];
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      if (visibleLength(word) > width) {
        if (current) {
          lines.push(current);
          current = '';
        }
        const chunks = [];
        for (let index = 0; index < word.length; index += width) {
          chunks.push(word.slice(index, index + width));
        }
        lines.push(...chunks);
      } else if (!current) current = word;
      else if (visibleLength(`${current} ${word}`) <= width) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  function panelParagraph(text, options = {}) {
    for (const line of wrapLine(String(text), panelWidth())) {
      panelLine(line, { contentStyle: options.contentStyle });
    }
  }

  function panelTitle(title, options = {}) {
    void options;
    panelLine(title, { contentStyle: ['bold'] });
  }

  function formatLabel(label, width = 16, style = []) {
    return paint(style, padVisibleEnd(label, width));
  }

  function labelValue(label, value, options = {}) {
    const width = options.width ?? 16;
    const labelText = options.plainLabel ? padVisibleEnd(label, width) : formatLabel(label, width, options.labelStyle ?? []);
    const valueText = options.valueStyle ? paint(options.valueStyle, value) : value;
    return `${labelText} ${valueText}`;
  }

  function successMarker(text = '✓') {
    return paint(['bold', 'green'], text);
  }

  function warningText(text) {
    return paint(['bold', 'yellow'], text);
  }

  function errorText(text) {
    return paint(['bold', 'red'], text);
  }

  function displayPath(filePath) {
    const home = os.homedir();
    if (!filePath) return '';
    if (filePath === home) return '~';
    if (filePath.startsWith(`${home}${path.sep}`)) return `~${path.sep}${filePath.slice(home.length + 1)}`;
    return filePath;
  }

  function configValueStyle(label, value) {
    if (label === 'Mode' && value === 'agent') return ['bold', 'green'];
    if (label === 'Write mode' && value === 'workspace') return ['bold', 'green'];
    if (label === 'Tunnel' && value === 'none') return ['bold', 'yellow'];
    return undefined;
  }

  function printKeyValueTable(rows, options = {}) {
    const width = options.width ?? Math.max(...rows.map(([label]) => label.length), 12) + 2;
    for (const [label, value] of rows) {
      const style = options.valueStyle?.(label, value) ?? configValueStyle(label, value);
      console.log(labelValue(label, String(value), { width, valueStyle: style }));
    }
  }

  function quoteCommandPart(part) {
    if (/^[A-Za-z0-9_./:@=-]+$/.test(part)) return part;
    return JSON.stringify(part);
  }

  function formatCommandBlock(args) {
    const lines = [`${cliName} ${args[0]}`];
    for (let i = 1; i < args.length; i += 1) {
      const current = args[i];
      const next = args[i + 1];
      if (current.startsWith('--') && next && !next.startsWith('--')) {
        lines.push(`  ${current} ${quoteCommandPart(next)}`);
        i += 1;
      } else {
        lines.push(`  ${quoteCommandPart(current)}`);
      }
    }
    return lines.map((line, index) => `${line}${index < lines.length - 1 ? ' \\' : ''}`);
  }

  function printCommandBlock(args) {
    const lines = formatCommandBlock(args);
    lines.forEach((line, index) => {
      const prefix = paint('dim', index === 0 ? '$ ' : '  ');
      console.log(`${prefix}${line}`);
    });
  }

  function divider(label = '') {
    const width = termWidth();
    if (!label) return paint('dim', '-'.repeat(width));
    const text = ` ${label} `;
    return paint('dim', `${text}${'-'.repeat(Math.max(0, width - visibleLength(text)))}`);
  }

  function printBox(title, lines) {
    const width = termWidth();
    const inner = width - 4;
    console.log(divider(paint(['bold'], title)));
    for (const line of lines) {
      const chunks = wrapLine(line, inner);
      for (const chunk of chunks) console.log(`| ${padVisibleEnd(chunk, inner)} |`);
    }
    console.log(divider());
  }

  function statusLine(status, detail = '') {
    const marker =
      status === 'ok'
        ? successMarker()
        : status === 'warn'
          ? warningText('WARN')
          : status === 'fail'
            ? errorText('ERR')
            : paint('cyan', '..');
    console.log(`${marker} ${detail}`);
  }

  function printControlHelp() {
    console.log('');
    console.log('Controls');
    console.log('  Enter  open ChatGPT connector settings in your browser');
    console.log('  c      copy Server URL again');
    console.log('  t      copy approval token when OAuth token approval is enabled');
    console.log('  u      print Server URL only');
    console.log('  o      open local setup/status page');
    console.log('  p      print Create App fields');
    console.log('  m      print mode help');
    console.log('  h      show controls');
    console.log(`  q      stop ${productName}`);
    console.log('');
  }

  function printModeHelp() {
    console.log('');
    console.log('Modes');
    console.log(`  ${cliName} start                 agent mode: read/write/edit/search/bash`);
    console.log(`  ${cliName} start --no-bash       agent mode without ChatGPT-triggered shell commands`);
    console.log(`  ${cliName} start --bash-session main --require-bash-session`);
    console.log(`  ${cliName} start --mode handoff  planning-only .ai-bridge handoff`);
    console.log(`  ${cliName} start --mode pro      export context for models without MCP tools`);
    console.log(`  ${cliName} start --tool-mode minimal   expose only the tight coding loop`);
    console.log(`  ${cliName} start --tool-mode full      expose every advanced compatibility tool`);
    console.log('');
  }

  return {
    applyColorPreference,
    displayPath,
    divider,
    errorText,
    formatCommandBlock,
    formatLabel,
    labelValue,
    padVisibleEnd,
    paint,
    panelDivider,
    panelKeyValue,
    panelLine,
    panelParagraph,
    panelTitle,
    panelWidth,
    printBox,
    printCommandBlock,
    printControlHelp,
    printKeyValueTable,
    printModeHelp,
    printSectionTitle,
    rawColorArg,
    statusLine,
    successMarker,
    termWidth,
    visibleLength,
    warningText,
    wrapLine
  };
}
