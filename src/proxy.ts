import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
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
  type StoredCredential,
} from './credential-store.js';

export interface RemoteToolClient {
  listTools(params?: ListToolsRequest['params']): Promise<ListToolsResult>;
  callTool(params: CallToolRequest['params']): Promise<CallToolResult>;
}

/**
 * 创建 tools-only 透明代理。
 *
 * 这里使用 SDK 的低层 Server 是有意的：代理不重新定义工具 schema，
 * 而是把远程 tools/list 和 tools/call 原样转交给本地 MCP 客户端。
 */
export function createToolProxyServer(remote: RemoteToolClient): Server {
  const server = new Server(
    { name: 'pixapi-mcp-proxy', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    remote.listTools(request.params)
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    remote.callTool(request.params)
  );

  return server;
}

export interface RunningProxy {
  close(): Promise<void>;
}

export interface RunProxyOptions {
  credential?: StoredCredential;
  remoteClient?: Client;
  remoteTransport?: Transport;
  localTransport?: Transport;
}

export async function runProxy(
  options: RunProxyOptions = {}
): Promise<RunningProxy> {
  // API Key 仅存在于当前进程内存和远程 Authorization header 中，不发给 stdio 客户端。
  const credential = options.credential ?? (await loadCredential());
  const remote =
    options.remoteClient ??
    new Client({
      name: 'pixapi-mcp-local-client',
      version: '0.1.0',
    });
  const remoteTransport =
    options.remoteTransport ??
    new StreamableHTTPClientTransport(new URL(credential.mcpUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${credential.apiKey}`,
        },
      },
    });
  await remote.connect(remoteTransport);

  // 明确用标准 CallToolResultSchema 校验远程返回，避免把不兼容结果传到本地客户端。
  const remoteTools: RemoteToolClient = {
    listTools: (params) => remote.listTools(params),
    callTool: async (params) =>
      CallToolResultSchema.parse(
        await remote.callTool(params, CallToolResultSchema)
      ),
  };
  const local = createToolProxyServer(remoteTools);
  // Claude Code/Cursor 管理本地 stdio 子进程；网络连接由上面的 remote client 管理。
  const localTransport = options.localTransport ?? new StdioServerTransport();
  await local.connect(localTransport);

  return {
    async close(): Promise<void> {
      // 先停止接收本地请求，再关闭远程连接，避免退出时产生新的在途调用。
      await local.close();
      await remote.close();
    },
  };
}
