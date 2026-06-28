import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type PathGuard, type WorkspaceManager } from "./guard.js";
import { buildProContext } from "./proContext.js";
import { codexproInventory } from "./capabilitiesOps.js";
import { gitStatus } from "./gitOps.js";
import { editTextFile, readTextFile, writeTextFile } from "./fsOps.js";
import { runBash } from "./bashOps.js";
import { EDITION } from "./edition.js";
import { textResult, toolCardMeta, errorText } from "./serverShared.js";
import { assertWriteToolAllowed, registerCodexTool, registeredToolNames, toolNamesForMode } from "./serverTooling.js";
import { TOOL_CARD_URI } from "./toolCardWidget.js";

interface DiagnosticDeps {
  workspaces: WorkspaceManager;
  guard: PathGuard;
  READ_ONLY_ANNOTATIONS: Record<string, unknown>;
  HANDOFF_WRITE_ANNOTATIONS: Record<string, unknown>;
  limitInt: (value: unknown, fallback: number, min: number, max: number) => number;
  parseBool: (value: unknown, fallback?: boolean) => boolean;
  changedStatusLines: (status: string) => string[];
  looksLikeGitError: (output: string) => boolean;
  cleanOneLine: (value: unknown, fallback: string, maxLength?: number) => string;
}

export function registerDiagnosticsTools(config: CodexProConfig, server: McpServer, deps: DiagnosticDeps): void {
  const {
    workspaces,
    guard,
    READ_ONLY_ANNOTATIONS,
    HANDOFF_WRITE_ANNOTATIONS,
    limitInt,
    parseBool,
    changedStatusLines,
    looksLikeGitError,
    cleanOneLine
  } = deps;

  registerCodexTool(
    config,
    server,
    "server_config",
    {
      title: "Server Config",
      description: `Show ${EDITION.productName} server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.`,
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(TOOL_CARD_URI),
        "openai/toolInvocation/invoking": `Reading ${EDITION.productName} server config...`,
        "openai/toolInvocation/invoked": `${EDITION.productName} server config ready`
      }
    },
    async () => {
      const safeConfig = {
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        bashMode: config.bashMode,
        bashTranscript: config.bashTranscript,
        bashSessionId: config.bashSessionId ?? null,
        requireBashSession: config.requireBashSession,
        codexSessions: config.codexSessions,
        codexDir: config.codexDir,
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        toolCards: config.toolCards,
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        blockedGlobs: config.blockedGlobs,
        registeredTools: registeredToolNames(server),
        registeredToolCount: registeredToolNames(server).length
      };
      return textResult(`# ${EDITION.productName} Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_self_test",
    {
      title: `${EDITION.productName} Self Test`,
      description:
        `Run one controlled, local-only ${EDITION.productName} diagnostic. It checks modes, expected tools, workspace access, skills, git, safe bash policy, selected-only Pro context, and optional .ai-bridge write/edit without touching source files.`,
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        write_probe: z.boolean().optional().describe("Create/edit only .ai-bridge/codexpro-self-test.md. Default: true."),
        bash_probe: z.boolean().optional().describe("Check bash policy with safe local commands only. Default: true."),
        pro_context_probe: z.boolean().optional().describe("Build a selected-only Pro context bundle in memory without writing pro-context.md. Default: true."),
        include_global_skills: z.boolean().optional().describe("Include user/plugin skill discovery in the inventory check. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Maximum skills to inspect during the inventory check. Default: 40.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(TOOL_CARD_URI),
        "openai/toolInvocation/invoking": `Running ${EDITION.productName} self-test...`,
        "openai/toolInvocation/invoked": `${EDITION.productName} self-test complete`
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const started = Date.now();
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
      const filesTouched: string[] = [];
      const probePath = `${config.contextDir}/codexpro-self-test.md`;

      const check = (name: string, status: "pass" | "warn" | "fail", detail: string) => {
        checks.push({ name, status, detail: cleanOneLine(detail, detail, 260) });
      };

      check("workspace", "pass", workspace.root);
      check("tool mode", config.toolMode === "full" ? "pass" : "warn", `${config.toolMode}; expected tools: ${toolNamesForMode(config).length}`);
      check("write mode", config.writeMode === "off" ? "warn" : "pass", config.writeMode);
      check("bash mode", config.bashMode === "full" ? "warn" : "pass", config.bashMode);
      check(
        "http auth",
        config.requireHttpToken && !config.authToken ? "fail" : "pass",
        config.requireHttpToken ? "token required for public/non-loopback access" : "loopback token not required"
      );
      const expectedTools = toolNamesForMode(config).sort();
      const actualTools = registeredToolNames(server).sort();
      const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
      const extraTools = actualTools.filter((name) => !expectedTools.includes(name));
      check(
        "registered tool set",
        missingTools.length || extraTools.length ? "fail" : "pass",
        missingTools.length || extraTools.length
          ? `missing: ${missingTools.join(", ") || "none"}; extra: ${extraTools.join(", ") || "none"}`
          : `${actualTools.length} tools registered for ${config.toolMode} mode`
      );

      try {
        const inventory = await codexproInventory(config, workspace, {
          includeGlobalSkills: parseBool(args.include_global_skills, true),
          includeMcpServers: true,
          maxSkills: limitInt(args.max_skills, 40, 1, 120)
        });
        check("inventory", "pass", `${inventory.skills.length} skills inspected, ${inventory.mcpServers.length} MCP server names visible`);
      } catch (error) {
        check("inventory", "fail", errorText(error));
      }

      try {
        const status = gitStatus(config, workspace);
        const gitFailed = looksLikeGitError(status);
        const changed = gitFailed ? 0 : changedStatusLines(status).length;
        check("git status", gitFailed ? "warn" : "pass", gitFailed ? status : `${changed} changed entries`);
      } catch (error) {
        check("git status", "fail", errorText(error));
      }

      if (parseBool(args.write_probe, true)) {
        if (config.writeMode === "off") {
          check("write/edit probe", "warn", "skipped because CODEXPRO_WRITE_MODE=off");
        } else {
          try {
            assertWriteToolAllowed(config, probePath);
            const content = [
              "# H7Y MCP Self Test",
              "",
              `Updated: ${new Date().toISOString()}`,
              `Workspace: ${workspace.root}`,
              "marker: before",
              ""
            ].join("\n");
            await writeTextFile(config, guard, workspace, probePath, content, { createDirs: true, overwrite: true });
            await editTextFile(config, guard, workspace, probePath, "marker: before", "marker: after", { expectedReplacements: 1 });
            const readBack = await readTextFile(config, guard, workspace, probePath, { maxBytes: 20_000 });
            if (!readBack.text.includes("marker: after")) throw new CodexProError("self-test edit marker was not found after edit.");
            const scopedStatus = gitStatus(config, workspace, guard, probePath);
            const scopedFiles = changedStatusLines(scopedStatus);
            filesTouched.push(probePath);
            check(
              "write/edit probe",
              scopedFiles.length && scopedFiles.every((line) => line.includes(probePath)) ? "pass" : "warn",
              scopedFiles.length ? `path-scoped status: ${scopedFiles.join(", ")}` : "path-scoped status clean after write/edit"
            );
          } catch (error) {
            check("write/edit probe", "fail", errorText(error));
          }
        }
      } else {
        check("write/edit probe", "warn", "skipped by request");
      }

      if (parseBool(args.pro_context_probe, true)) {
        try {
          if (!filesTouched.includes(probePath)) {
            check("selected-only pro context", "warn", "skipped because write probe did not create the selected file");
          } else {
            const context = await buildProContext(config, guard, workspace, {
              title: "H7Y MCP Self Test Context",
              selectedPaths: [probePath],
              includeImportantFiles: false,
              includeChangedFiles: false,
              includeDiff: false,
              includeAiBridge: false,
              maxFiles: 4,
              maxTotalBytes: 80_000
            });
            const exactOnly = context.filesIncluded.length === 1 && context.filesIncluded[0] === probePath;
            check(
              "selected-only pro context",
              exactOnly ? "pass" : "fail",
              exactOnly ? `included only ${probePath}` : `included ${context.filesIncluded.join(", ") || "no files"}`
            );
          }
        } catch (error) {
          check("selected-only pro context", "fail", errorText(error));
        }
      } else {
        check("selected-only pro context", "warn", "skipped by request");
      }

      if (parseBool(args.bash_probe, true)) {
        try {
          if (config.bashMode === "off") {
            check("bash policy", "warn", "bash disabled");
          } else {
            const bashProbeOptions = { timeoutMs: 10_000, sessionId: config.bashSessionId };
            const pwd = await runBash(config, guard, workspace, "pwd", bashProbeOptions);
            if (config.bashMode === "safe") {
              try {
                await runBash(config, guard, workspace, "ls $HOME", bashProbeOptions);
                check("bash policy", "fail", "safe bash allowed environment expansion unexpectedly");
              } catch {
                check("bash policy", pwd.exitCode === 0 ? "pass" : "warn", "safe bash allowed pwd and blocked environment expansion");
              }
            } else {
              check("bash policy", pwd.exitCode === 0 ? "warn" : "fail", "full bash is enabled; use only for trusted local repos");
            }
          }
        } catch (error) {
          check("bash policy", "fail", errorText(error));
        }
      } else {
        check("bash policy", "warn", "skipped by request");
      }

      check(
        "terms boundary",
        "pass",
        "local workspace bridge only; does not provide models, proxy model access, bypass quotas, or execute remote/local agents from MCP"
      );

      const failed = checks.filter((item) => item.status === "fail").length;
      const warned = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;
      const status = failed ? "fail" : warned ? "warn" : "pass";
      const text = [
        "# H7Y MCP Self Test",
        "",
        `Status: ${status}`,
        `Workspace: ${workspace.root}`,
        `Mode: tools=${config.toolMode}, write=${config.writeMode}, bash=${config.bashMode}${config.bashSessionId ? `, bash_session=${config.bashSessionId}${config.requireBashSession ? " required" : ""}` : ""}`,
        `Expected tools: ${expectedTools.length}`,
        `Registered tools: ${actualTools.length}`,
        `Duration: ${Date.now() - started} ms`,
        "",
        "## Checks",
        "",
        ...checks.map((item) => `- ${item.status.toUpperCase()} ${item.name}: ${item.detail}`),
        "",
        "## Terms Boundary",
        "",
        `${EDITION.productName} exposes local repo tools to the ChatGPT session the user controls. It does not provide models, proxy model access, resell access, modify quotas, bypass limits, or run local implementation agents through remote MCP tools.`
      ].join("\n");

      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        passed,
        warned,
        failed,
        duration_ms: Date.now() - started,
        expected_tools: expectedTools,
        expected_tool_count: expectedTools.length,
        registered_tools: actualTools,
        registered_tool_count: actualTools.length,
        bash_mode: config.bashMode,
        bash_session_id: config.bashSessionId ?? null,
        require_bash_session: config.requireBashSession,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        files_touched: filesTouched,
        checks,
        terms_boundary: {
          local_workspace_bridge: true,
          provides_models: false,
          proxies_model_access: false,
          bypasses_quotas: false,
          remote_agent_execution: false
        }
      });
    }
  );
}
