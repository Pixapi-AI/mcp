import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ErrorCode,
  McpError,
  CallToolRequestSchema,
  CallToolResultSchema,
  type CallToolRequest,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsRequest,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

import {
  loadCredential,
  validateCredential,
  type StoredCredential,
} from './credential-store.js';

import { createOAuthSession, DEFAULT_MCP_URL, type OAuthSessionOptions } from './oauth.js';
import { PublicError, publicErrorMessage } from './public-error.js';
import { VERSION } from './version.js';

export interface RemoteToolClient {
  listTools(
    params?: ListToolsRequest['params'],
    signal?: AbortSignal
  ): Promise<ListToolsResult>;
  callTool(
    params: CallToolRequest['params'],
    signal?: AbortSignal
  ): Promise<CallToolResult>;
}

/**
 * Create a tools-only transparent proxy.
 *
 * The low-level SDK Server is intentional: the proxy does not redefine tool
 * schemas; it forwards remote tools/list and tools/call to the local client.
 */
export function createToolProxyServer(remote: RemoteToolClient): Server {
  const server = new Server(
    { name: 'pixapi-mcp-proxy', version: VERSION },
    { capabilities: { tools: {} } }
  );

  async function safely<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { throw new McpError(ErrorCode.InternalError, publicErrorMessage(error)); }
  }
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) =>
    safely(() => remote.listTools(request.params, extra.signal))
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    safely(() => remote.callTool(request.params, extra.signal))
  );

  return server;
}

export interface RunningProxy {
  close(): Promise<void>;
}

export interface RunProxyOptions {
  credential?: StoredCredential;
  homeDir?: string;
  oauth?: OAuthSessionOptions;
  remoteClient?: Client;
  remoteTransport?: Transport;
  localTransport?: Transport;
}

export async function runProxy(
  options: RunProxyOptions = {}
): Promise<RunningProxy> {
  let credential = options.credential;
  let oauth: Awaited<ReturnType<typeof createOAuthSession>> | undefined;
  if (!credential && !options.remoteTransport) {
    if (process.env.PIXAPI_API_KEY) {
      credential = validateCredential({ version: 1, apiKey: process.env.PIXAPI_API_KEY, expiresAt: null, mcpUrl: DEFAULT_MCP_URL });
    } else {
      oauth = await createOAuthSession({ ...options.oauth, homeDir: options.homeDir ?? options.oauth?.homeDir });
      if (!oauth.hasTokens()) {
        try { credential = await loadCredential({ homeDir: options.homeDir }); }
        catch (error) {
          // Missing, expired, or unusable leftover keys must not block OAuth.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof PublicError)) throw error;
        }
      }
    }
  }
  const remote =
    options.remoteClient ??
    new Client({
      name: 'pixapi-mcp-local-client',
      version: VERSION,
    });
  const makeRemoteTransport = () => {
    if (options.remoteTransport) return options.remoteTransport;
    const url = new URL(credential?.mcpUrl ?? options.oauth?.mcpUrl ?? DEFAULT_MCP_URL);
    if (credential) {
      return new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${credential.apiKey}`,
          },
        },
      });
    }
    // The startup block above always sets credential or oauth here.
    if (!oauth) throw new PublicError('Pixapi is not configured. Run "pixapi-mcp login" or set PIXAPI_API_KEY.');
    return new StreamableHTTPClientTransport(url, { fetch: oauth.fetch });
  };
  let connection: Promise<void> | undefined;
  let closed = false;
  function connect(): Promise<void> {
    if (closed) return Promise.reject(new Error('Proxy closed'));
    if (!connection) connection = remote.connect(makeRemoteTransport(), { timeout: 180_000 }).catch(async (error) => {
      await remote.close().catch(() => {});
      connection = undefined;
      throw error;
    });
    return connection;
  }
  // Preserve existing API-key startup checks. OAuth starts on the first tool
  // request so browser consent never delays the local MCP initialize response.
  if (credential) await connect();

  // Validate remote results with CallToolResultSchema before forwarding them.
  const remoteTools: RemoteToolClient = {
    listTools: async (params, signal) => {
      await connect();
      signal?.throwIfAborted();
      return remote.listTools(params, { signal });
    },
    callTool: async (params, signal) => {
      await connect();
      // Shared OAuth/connect may finish after this request was cancelled.
      signal?.throwIfAborted();
      return CallToolResultSchema.parse(
        await remote.callTool(params, CallToolResultSchema, { signal })
      );
    },
  };
  const local = createToolProxyServer(remoteTools);
  // The host manages stdio; the bridge owns the remote HTTP connection.
  const localTransport = options.localTransport ?? new StdioServerTransport();
  await local.connect(localTransport);

  return {
    async close(): Promise<void> {
      closed = true;
      await oauth?.close();
      // Stop accepting local requests before closing the remote connection.
      await local.close();
      await remote.close();
    },
  };
}
