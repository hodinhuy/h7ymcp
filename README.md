<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="H7Y MCP logo">
</p>

<h1 align="center">H7Y MCP</h1>

<p align="center">
  A safe-by-default personal MCP bridge for using ChatGPT like a local coding agent.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/h7ymcp"><img alt="npm" src="https://img.shields.io/npm/v/h7ymcp?style=flat-square"></a>
  <a href="https://github.com/hodinhuy/h7ymcp"><img alt="Repo" src="https://img.shields.io/badge/repo-h7y--mcp-67e8f9?style=flat-square"></a>
  <a href="https://github.com/hodinhuy/h7ymcp#readme"><img alt="Docs" src="https://img.shields.io/badge/docs-readme-67e8f9?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://github.com/hodinhuy/h7ymcp">GitHub</a>
  ·
  <a href="https://www.npmjs.com/package/h7ymcp">npm</a>
  ·
  <a href="DOMAIN_SETUP.md">Stable URL guide</a>
  ·
  <a href="FAQ.md">FAQ</a>
  ·
  <a href="SECURITY.md">Security</a>
</p>

## Overview

H7Y MCP connects your ChatGPT Developer Mode session to one local repository through MCP.

It gives ChatGPT bounded tools to inspect files, search code, edit workspace files, run safe verification commands, review diffs, and hand work off to a local agent through `.ai-bridge` files.

H7Y MCP is not a hosted coding service, model proxy, quota workaround, account sharing layer, or OS sandbox. It only exposes local repo tools to the ChatGPT session you already control.

## Features

- Local MCP bridge for one selected workspace
- Safe-by-default file access and blocked secret/build paths
- Workspace read, search, write, edit, and review tools
- Safe bash mode for focused build, test, lint, and typecheck commands
- Optional visual ChatGPT tool cards
- `.ai-bridge` handoff workflow for Codex, OpenCode, Pi, or a custom local agent
- Pro/context fallback for model surfaces that cannot call MCP tools directly
- Cloudflare, ngrok, and local-only startup options

## Requirements

- Node.js 20+
- ChatGPT account with Apps / Developer Mode access
- Developer Mode enabled in ChatGPT settings
- A tunnel option if ChatGPT needs to reach your local MCP server from the web

For the safest first run, start local-only or use a private tunnel URL with a bearer token.

## Quick Start

Install the CLI:

```bash
npm install -g h7ymcp
```

Run setup inside the repo you want ChatGPT to work on:

```bash
cd /path/to/your/repo
h7ymcp setup
```

After setup, daily use from the same repo is:

```bash
h7ymcp start
```

## ChatGPT Setup

In ChatGPT:

```text
Settings
-> Apps
-> Advanced settings
-> Developer mode: on
-> Create app
```

Use the values printed by H7Y MCP:

```text
Name: H7Y MCP
Connection: Server URL
Server URL: paste the copied /mcp URL
Authentication: No Authentication / None
```

Keep the H7Y MCP terminal running while ChatGPT uses the connector.

## Common Commands

```bash
h7ymcp setup      # guided first-run setup
h7ymcp start      # start from a saved workspace profile
h7ymcp doctor     # check local prerequisites
h7ymcp settings   # inspect or update saved workspace settings
```

Useful start modes:

```bash
h7ymcp start --no-bash
h7ymcp start --tool-mode minimal
h7ymcp start --tool-mode full
h7ymcp start --mode handoff
h7ymcp start --tunnel none
```

## Tunnel Options

H7Y MCP can run with:

```text
local       no public tunnel; only local MCP clients can reach it
cloudflare  quick Cloudflare tunnel; easiest demo path, URL changes each restart
ngrok       stable free dev domain when configured in ngrok
stable      Cloudflare named tunnel with your own domain
```

For daily ChatGPT use, prefer a stable ngrok dev domain or a Cloudflare named tunnel so the ChatGPT app URL does not need to change every restart.

For custom domains and stable URL setup, see [DOMAIN_SETUP.md](DOMAIN_SETUP.md).

## Tool Surface

The default tool mode keeps the ChatGPT action list focused on the normal coding loop:

```text
open_current_workspace
open_workspace
tree
search
read
write
edit
bash
show_changes
read_handoff
handoff_to_agent
export_pro_context
```

Use `--tool-mode minimal` for a smaller surface or `--tool-mode full` for diagnostics and compatibility tools.

## Safety Model

H7Y MCP uses conservative defaults:

- workspace-scoped reads and writes
- blocked `.env`, private key, dependency, build, cache, and `.git` internals
- safe bash mode by default
- token-protected HTTP/MCP URLs
- handoff mode when you want planning-only behavior

H7Y MCP is still not an OS sandbox. Review changes before trusting them, especially when exposing the MCP server through a public tunnel.

Read [SECURITY.md](SECURITY.md) before using H7Y MCP on sensitive repositories.

## Handoff Workflow

Use handoff mode when you want ChatGPT to write a plan but not edit source files directly:

```bash
h7ymcp start --mode handoff --no-bash
```

ChatGPT can then write a plan to:

```text
.ai-bridge/current-plan.md
```

A local agent such as Codex, OpenCode, Pi, or a custom command can execute that plan from your terminal. Generated status, logs, and diffs stay inside `.ai-bridge` for review.

## Pro Context Fallback

Some model surfaces may not be able to call Developer Mode apps or MCP tools directly. In that case, export a repo context bundle:

```bash
h7ymcp pro-bundle --root /path/to/your/repo --copy
```

Then paste the bundle into the model and apply its returned plan with:

```bash
h7ymcp pro-apply --root /path/to/your/repo --file plan.md
```

## Development

From source:

```bash
npm install
npm run build
npm run smoke
npm run doctor -- --tunnel none
```

Before publishing:

```bash
npm pack --dry-run
```

The package should not include local runtime reports, `.ai-bridge`, `.env` files, tunnel tokens, or generated tarballs.

## Migration Notes

This fork is the H7Y MCP Phase 1 personal edition.

Current release:

```text
version:           1.0.0
GitHub repository: https://github.com/hodinhuy/h7ymcp
CLI command:       h7ymcp
npm package:       h7ymcp
config home:       ~/.personal-edition
canonical env:     PERSONAL_*
```

Legacy `CODEXPRO_*` environment variables and `~/.h7ymcp` profiles may still be read during the compatibility period.

Phase 1 safety defaults:

- local-only startup by default when configured with `--tunnel none`
- `bash=safe`
- `write=handoff`
- bearer-token auth for HTTP/MCP

## Credits

H7Y MCP began as a fork of the original CodexPro project.

This fork is maintained by Huy and focuses on a ChatGPT-first personal edition with simpler setup, safer defaults, local repo workflows, Developer Mode support, and reviewable MCP tool output.

Thanks to the original CodexPro author(s) and contributors for the foundation this project builds on.

## License

MIT
