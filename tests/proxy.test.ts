import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { createToolProxyServer, runProxy } from '../src/proxy.js';
import { readFileSync } from 'node:fs';

describe('tool proxy', () => {
  it('forwards tool discovery and calls without exposing the API key locally', async () => {
    const remote = {
      listTools: vi.fn(async (): Promise<ListToolsResult> => ({
        tools: [
          {
            name: 'pixapi_get_task',
            description: 'Get an asynchronous Pixapi task.',
            inputSchema: {
              type: 'object',
              properties: { task_id: { type: 'string' } },
              required: ['task_id'],
            },
          },
        ],
      })),
      callTool: vi.fn(
        async (params: CallToolRequest['params']): Promise<CallToolResult> => ({
          content: [{ type: 'text', text: `task:${String(params.arguments?.task_id)}` }],
        })
      ),
    };
    const server = createToolProxyServer(remote);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(client.getServerVersion()?.version).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);

    const tools = await client.listTools();
    const result = await client.callTool({
      name: 'pixapi_get_task',
      arguments: { task_id: 'task_123' },
    });

    expect(tools.tools[0]?.name).toBe('pixapi_get_task');
    expect(remote.callTool).toHaveBeenCalledWith(
      {
        name: 'pixapi_get_task',
        arguments: { task_id: 'task_123' },
      },
      expect.any(AbortSignal)
    );
    expect(result.content).toEqual([{ type: 'text', text: 'task:task_123' }]);

    await client.close();
    await server.close();
  });

  it('connects injected remote and local transports and closes both sides', async () => {
    const remoteServer = new Server(
      { name: 'remote-test', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    remoteServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'pixapi_ping',
          inputSchema: { type: 'object' },
        },
      ],
    }));
    remoteServer.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));

    const remoteClient = new Client({
      name: 'proxy-remote-client',
      version: '1.0.0',
    });
    const [remoteClientTransport, remoteServerTransport] =
      InMemoryTransport.createLinkedPair();
    const [localClientTransport, localServerTransport] =
      InMemoryTransport.createLinkedPair();
    await remoteServer.connect(remoteServerTransport);

    const running = await runProxy({
      credential: {
        version: 1,
        apiKey: 'sk_not_exposed',
        expiresAt: '2027-01-23T00:00:00.000Z',
        mcpUrl: 'https://api.pixapi.ai/mcp',
      },
      remoteClient,
      remoteTransport: remoteClientTransport,
      localTransport: localServerTransport,
    });
    const localClient = new Client({
      name: 'local-test-client',
      version: '1.0.0',
    });
    await localClient.connect(localClientTransport);

    expect((await localClient.listTools()).tools[0]?.name).toBe('pixapi_ping');
    expect(
      await localClient.callTool({ name: 'pixapi_ping', arguments: {} })
    ).toMatchObject({
      content: [{ type: 'text', text: 'pong' }],
    });

    await localClient.close();
    await running.close();
    await remoteServer.close();
  });

  it('does not execute a cancelled tool call after a delayed remote connect completes', async () => {
    let finishConnect!: () => void;
    const remote = new Client({ name: 'slow-remote', version: '1.0.0' });
    const connect = vi.spyOn(remote, 'connect').mockImplementation(
      () => new Promise(resolve => {
        finishConnect = () => resolve();
      })
    );
    const callTool = vi.spyOn(remote, 'callTool').mockResolvedValue({
      content: [{ type: 'text', text: 'charged' }],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const [remoteTransport] = InMemoryTransport.createLinkedPair();
    const running = await runProxy({
      remoteClient: remote,
      remoteTransport,
      localTransport: serverTransport,
    });
    const local = new Client({ name: 'local', version: '1.0.0' });
    await local.connect(clientTransport);

    const abort = new AbortController();
    const pending = local.callTool(
      { name: 'pixapi_generate_image', arguments: { prompt: 'a cat' } },
      undefined,
      { signal: abort.signal }
    );
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    abort.abort('cancelled');
    await expect(pending).rejects.toThrow(/cancel/i);
    finishConnect();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(callTool).not.toHaveBeenCalled();

    await local.close();
    await running.close();
  });
});

it('initializes locally before an OAuth remote connection completes and redacts remote failures', async () => {
  const remote = new Client({ name: 'slow-remote', version: '1' });
  const connect = vi.spyOn(remote, 'connect').mockImplementation(async () => { throw Error('PRIVATE_SQL_TOKEN'); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const [remoteTransport] = InMemoryTransport.createLinkedPair();
  const running = await runProxy({ remoteClient: remote, remoteTransport, localTransport: serverTransport });
  const local = new Client({ name: 'local', version: '1' });
  await local.connect(clientTransport);
  expect(connect).not.toHaveBeenCalled();
  await expect(local.listTools()).rejects.toThrow('Check your configuration');
  await expect(local.listTools()).rejects.not.toThrow('PRIVATE_SQL_TOKEN');
  expect(connect).toHaveBeenCalledTimes(2);
  await local.close(); await running.close();
});
