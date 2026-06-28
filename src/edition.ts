export const EDITION = Object.freeze({
  productName: "H7Y MCP",
  packageName: "h7ymcp",
  cliName: "h7ymcp",
  mcpCommandName: "h7ymcp-mcp",
  mcpHttpCommandName: "h7ymcp-http",
  envPrefix: "PERSONAL",
  legacyEnvPrefix: "CODEXPRO",
  configDirName: ".personal-edition",
  legacyConfigDirName: ".codexpro",
  defaultWidgetDomain: "https://github.com",
  repositoryUrl: "https://github.com/hodinhuy/h7ymcp",
  issuesUrl: "https://github.com/hodinhuy/h7ymcp/issues",
  homepageUrl: "https://github.com/hodinhuy/h7ymcp",
  docsUrl: "https://github.com/hodinhuy/h7ymcp#readme",
  connectorSettingsUrl: "https://chatgpt.com/#settings/Connectors"
});

export function envName(prefix: string, suffix: string): string {
  return `${prefix}_${suffix}`;
}

export function editionEnvNames(suffix: string, extraLegacyKeys: string[] = []): string[] {
  return [
    envName(EDITION.envPrefix, suffix),
    envName(EDITION.legacyEnvPrefix, suffix),
    ...extraLegacyKeys
  ];
}

export function editionEnvValue(suffix: string, extraLegacyKeys: string[] = []): string | undefined {
  for (const key of editionEnvNames(suffix, extraLegacyKeys)) {
    const value = process.env[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function authorizedUrlDisplay(endpoint: string | undefined, authEnabled: boolean): string {
  if (!endpoint) return "";
  return authEnabled ? `${endpoint} (Authorization: Bearer <redacted>)` : endpoint;
}
