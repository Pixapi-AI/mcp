import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

/** Only locally authored messages without credentials or raw input belong here. */
export class PublicError extends Error {}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof PublicError) return error.message;
  if (error instanceof UnauthorizedError ||
      (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))) {
    return 'Pixapi authentication failed. Check your API key and run "pixapi-mcp init" again.';
  }
  if (error instanceof StreamableHTTPError) {
    return 'Pixapi is temporarily unavailable. Check your connection and try again later.';
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT') {
    return 'A required local file is missing. Check the project directory and run "pixapi-mcp init".';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'Cannot access Pixapi credentials or project configuration. Check your file permissions.';
  }
  return 'Pixapi MCP could not complete the operation. Check your configuration and connection. Run "pixapi-mcp --help" for setup instructions.';
}
