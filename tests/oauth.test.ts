import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runProxy } from '../src/proxy.js';
import { createOAuthSession } from '../src/oauth.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-oauth-'));
  cleanup.push(() => rm(homeDir, { recursive: true, force: true }));
  let base = ''; let browsers = 0; let refreshes = 0; let registrations = 0;
  let rejectRefresh = false; let rejectAccess = false;
  let tokenGate: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const send = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) return send({ resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['pixapi:tools', 'offline_access'] });
    if (req.url === '/.well-known/oauth-authorization-server') return send({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
    if (req.url === '/register') {
      registrations++;
      if (JSON.parse(body).application_type !== 'native') return send({ error: 'invalid_client_metadata' }, 400);
      return send({ ...JSON.parse(body), client_id: 'test-client' }, 201);
    }
    if (req.url === '/token') {
      if (tokenGate) { tokenGate(); return; }
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++;
        if (rejectRefresh) return send({ error: 'invalid_grant', error_description: 'PRIVATE_DATABASE_SECRET' }, 400);
      } else {
        expect(params.get('code')).toBe('test-code');
        expect(params.get('code_verifier')?.length).toBeGreaterThan(40);
      }
      return send({ access_token: 'test-access-' + refreshes, refresh_token: 'test-refresh-' + refreshes, token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.url === '/mcp') {
      if (rejectAccess || !req.headers.authorization) return send({}, 401);
      if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
      if (body) {
        const rpc = JSON.parse(body);
        if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = rpc.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : { tools: [{ name: 'pixapi_test', inputSchema: { type: 'object' } }] };
        return send({ jsonrpc: '2.0', id: rpc.id, result });
      }
      return send({ ok: true, auth: req.headers.authorization });
    }
    send({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('port');
  base = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const openBrowser = async (url: string) => {
    browsers++;
    const auth = new URL(url);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'test-code');
    callback.searchParams.set('state', 'wrong');
    expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set('state', auth.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
  };
  const options = { homeDir, mcpUrl: base + '/mcp', openBrowser };
  return { options, pauseToken: () => new Promise<void>(resolve => { tokenGate = resolve; }), counts: () => ({ browsers, refreshes, registrations }), revokeRefresh: () => { rejectRefresh = true; }, rejectAccess: () => { rejectAccess = true; } };
}

it('authorizes with PKCE once, shares concurrent login, and privately persists reusable tokens', async () => {
  const f = await fixture();
  const session = await createOAuthSession(f.options);
  await Promise.all([session.authorize(), session.authorize()]);
  expect(f.counts()).toEqual({ browsers: 1, refreshes: 0, registrations: 1 });
  const directory = join(f.options.homeDir, '.pixapi');
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const path = join(directory, files[0]!);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const stored = await readFile(path, 'utf8');
  expect(stored).toContain('test-refresh-0');
  expect(stored).not.toMatch(/code_verifier|test-code|code_challenge/);
  const restored = await createOAuthSession(f.options);
  expect(await (await restored.fetch(f.options.mcpUrl, { method: 'POST' })).json()).toMatchObject({ auth: 'Bearer test-access-0' });
  expect(f.counts().browsers).toBe(1);
});

it('silently refreshes an expired token and reauthorizes only when refresh is revoked', async () => {
  const f = await fixture();
  await (await createOAuthSession(f.options)).authorize();
  const later = () => Date.now() + 3_700_000;
  await (await createOAuthSession({ ...f.options, now: later })).authorize();
  expect(f.counts()).toMatchObject({ browsers: 1, refreshes: 1 });
  f.revokeRefresh();
  await (await createOAuthSession({ ...f.options, now: () => later() + 3_700_000 })).authorize();
  expect(f.counts().browsers).toBe(2);
});

it('retries unauthorized HTTP requests only once and never sends tokens to another URL', async () => {
  const f = await fixture();
  const session = await createOAuthSession(f.options);
  await session.authorize();
  f.rejectAccess();
  expect((await session.fetch(f.options.mcpUrl)).status).toBe(401);
  expect(f.counts().refreshes).toBe(1);
  await expect(session.fetch('https://other.example/mcp')).rejects.toThrow('destination');
});

it('handles browser failure, denial and timeout without exposing callback or server details', async () => {
  const f = await fixture();
  const broken = await createOAuthSession({ ...f.options, openBrowser: async () => { throw Error('PRIVATE_DATABASE_SECRET'); } });
  await expect(broken.authorize()).rejects.toThrow('browser');
  const denied = await createOAuthSession({ ...f.options, openBrowser: async (url) => {
    const auth = new URL(url); const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', auth.searchParams.get('state')!);
    callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('error_description', 'PRIVATE_DATABASE_SECRET');
    await fetch(callback);
  } });
  await expect(denied.authorize()).rejects.toThrow('denied');
  const timeout = await createOAuthSession({ ...f.options, timeoutMs: 20, openBrowser: async () => {} });
  await expect(timeout.authorize()).rejects.toThrow('timed out');
});

it('shares authorization between separate sessions using the same private store', async () => {
  const f = await fixture();
  const a = await createOAuthSession(f.options);
  const b = await createOAuthSession(f.options);
  await Promise.all([a.authorize(), b.authorize()]);
  expect(f.counts()).toEqual({ browsers: 1, registrations: 1, refreshes: 0 });
  expect(await readdir(join(f.options.homeDir, '.pixapi'))).toHaveLength(1);
});

it.each([
  ['expired', JSON.stringify({
    version: 1, apiKey: 'sk_expired', expiresAt: '2020-01-01T00:00:00.000Z', mcpUrl: 'https://api.pixapi.ai/mcp',
  })],
  ['invalid', 'not-json'],
])('falls back to OAuth when a leftover API key file is %s', async (_label, contents) => {
  const f = await fixture();
  await mkdir(join(f.options.homeDir, '.pixapi'), { recursive: true });
  await writeFile(join(f.options.homeDir, '.pixapi/mcp-credentials.json'), contents);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const running = await runProxy({ homeDir: f.options.homeDir, oauth: f.options, localTransport: serverTransport });
  cleanup.push(() => running.close());
  const client = new Client({ name: 'legacy-user', version: '1' });
  cleanup.push(() => client.close());
  await client.connect(clientTransport);
  expect((await client.listTools()).tools[0]?.name).toBe('pixapi_test');
  expect(f.counts().browsers).toBe(1);
});

it('boots a fresh stdio bridge without init or an API key and authenticates on tool discovery', async () => {
  const f = await fixture();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const running = await runProxy({ homeDir: f.options.homeDir, oauth: f.options, localTransport: serverTransport });
  cleanup.push(() => running.close());
  const client = new Client({ name: 'registry-user', version: '1' });
  cleanup.push(() => client.close());
  await client.connect(clientTransport);
  expect(f.counts().browsers).toBe(0);
  expect((await client.listTools()).tools[0]?.name).toBe('pixapi_test');
  expect((await client.listTools()).tools[0]?.name).toBe('pixapi_test');
  expect(f.counts().browsers).toBe(1);
});

it('cancels pending browser consent and releases its callback and authorization lock', async () => {
  const f = await fixture();
  let opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const session = await createOAuthSession({ ...f.options, openBrowser: async () => { opened(); } });
  const login = session.authorize();
  const rejected = expect(login).rejects.toThrow('cancelled');
  await ready;
  await session.close();
  await rejected;
  expect((await readdir(join(f.options.homeDir, '.pixapi'))).some(name => name.endsWith('.lock'))).toBe(false);
});

it('cancels in-flight OAuth network requests when the bridge closes', async () => {
  const f = await fixture();
  const tokenRequested = f.pauseToken();
  const session = await createOAuthSession(f.options);
  const login = session.authorize().then(() => false, () => true);
  await tokenRequested;
  await session.close();
  expect(await Promise.race([login, delay(200).then(() => false)])).toBe(true);
});
