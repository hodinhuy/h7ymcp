import { redactSensitiveText, redactStructured } from "./redact.js";

export function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

export function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: redactSensitiveText(text) }],
    structuredContent: redactStructured(structuredContent),
    _meta: meta
  };
}

export function errorResult(error: unknown): any {
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error) }],
    structuredContent: { error: errorText(error) }
  };
}

export function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured = result.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : {};
  result.structuredContent = {
    codexpro_tool: name,
    codexpro_title: options.title ?? name,
    ...base
  };
  return result;
}

export function toolCardMeta(toolCardUri: string): Record<string, unknown> {
  return {
    ui: { resourceUri: toolCardUri },
    "openai/outputTemplate": toolCardUri
  };
}

export const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;
