type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ErrorToolResult = ToolResult & { isError: true };

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Maps any thrown value to an MCP `isError: true` tool result instead of
 * letting it become an uncaught protocol-level error. Known CLI failures
 * (CliError, SessionNotFoundError) and anything else are all handled the
 * same way — message-only, no stack — matching how cli.ts's main() already
 * treats CliError, extended here to cover unexpected errors too so the
 * server never crashes on a bad tool call. */
export function errorResult(error: unknown): ErrorToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

export async function toToolResult(
  run: () => Promise<string>,
): Promise<ToolResult | ErrorToolResult> {
  try {
    return textResult(await run());
  } catch (error) {
    return errorResult(error);
  }
}
