import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientInformationSchema, OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { openBrowser } from './browser.js';
import { PublicError } from './public-error.js';

export const DEFAULT_MCP_URL = 'https://api.pixapi.ai/mcp';
export interface OAuthSessionOptions {
  mcpUrl?: string;
  homeDir?: string;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}
interface SavedSession {
  version: 1;
  mcpUrl: string;
  redirectUrl: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
}

/** One server-bound private store; PKCE verifiers and callback state stay in memory. */
export async function createOAuthSession(options: OAuthSessionOptions = {}) {
  const serverUrl = new URL(options.mcpUrl ?? DEFAULT_MCP_URL);
  if (serverUrl.protocol !== 'https:' && !(serverUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname))) {
    throw new PublicError('Invalid OAuth server URL. Use an HTTPS MCP endpoint.');
  }
  const directory = join(options.homeDir ?? homedir(), '.pixapi');
  const path = join(directory, `oauth-${createHash('sha256').update(serverUrl.href).digest('hex')}.json`);
  const now = options.now ?? Date.now;
  let saved: SavedSession = { version: 1, mcpUrl: serverUrl.href, redirectUrl: '' };
  async function reload() {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as SavedSession;
      const redirect = new URL(value.redirectUrl);
      if (value.version !== 1 || value.mcpUrl !== serverUrl.href || redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/oauth/callback' || !redirect.port || redirect.search || redirect.hash || redirect.username || redirect.password || (value.expiresAt !== undefined && !Number.isFinite(value.expiresAt))) throw Error('Invalid session');
      saved = { ...value, client: value.client ? OAuthClientInformationSchema.parse(value.client) : undefined, tokens: value.tokens ? OAuthTokensSchema.parse(value.tokens) : undefined };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PublicError('Cannot read the saved Pixapi OAuth session. Check permissions or remove the OAuth session file in ~/.pixapi and sign in again.');
    }
  }
  await reload();
  async function persist() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(saved) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  let listener: Server | undefined;
  let callback: Promise<string> | undefined;
  let rejectCallback: ((reason: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state = '';
  let verifier = '';
  let issuer: string | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;
  const controller = new AbortController();
  const oauthFetch: FetchLike = (input, init) => fetch(input, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]),
  });
  async function stopListener() {
    clearTimeout(timer);
    const current = listener;
    listener = undefined;
    if (current) await new Promise<void>(resolve => { current.closeAllConnections(); current.close(() => resolve()); });
    callback = undefined;
    rejectCallback = undefined;
    state = '';
    verifier = '';
  }
  async function startListener() {
    if (closed) throw new PublicError('Pixapi authorization was cancelled. Restart the MCP client.');
    if (listener) return;
    state = randomBytes(32).toString('base64url');
    let accept!: (code: string) => void;
    callback = new Promise<string>((resolve, reject) => { accept = resolve; rejectCallback = reject; });
    // A failed browser launch may precede the caller awaiting the callback.
    void callback.catch(() => {});
    listener = createServer((req, res) => {
      let url: URL;
      try { url = new URL(req.url ?? '/', saved.redirectUrl); }
      catch { res.writeHead(400); res.end('Invalid authorization callback.'); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      if (req.method !== 'GET' || req.headers.host !== new URL(saved.redirectUrl).host || url.pathname !== '/oauth/callback' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state || (url.searchParams.has('iss') && url.searchParams.get('iss') !== issuer)) {
        res.writeHead(400); res.end('Invalid authorization callback.'); return;
      }
      if (url.searchParams.has('error')) {
        res.end('Authorization was not completed. You can close this tab.');
        rejectCallback?.(new PublicError('Pixapi authorization was denied. Run "pixapi-mcp login" to try again.'));
      } else if (url.searchParams.getAll('code').length === 1 && url.searchParams.get('code')) {
        res.end('Pixapi is connected. You can close this tab.');
        accept(url.searchParams.get('code')!);
      } else { res.writeHead(400); res.end('Missing authorization code.'); }
    });
    try {
      const port = saved.redirectUrl ? Number(new URL(saved.redirectUrl).port) : 0;
      await new Promise<void>((resolve, reject) => { listener!.once('error', reject); listener!.listen(port, '127.0.0.1', resolve); });
    } catch {
      throw new PublicError('Cannot open the local OAuth callback port. Close other Pixapi login attempts and retry.');
    }
    const address = listener.address();
    if (!address || typeof address === 'string') throw new PublicError('Cannot start OAuth callback. Retry "pixapi-mcp login".');
    saved.redirectUrl = `http://127.0.0.1:${address.port}/oauth/callback`;
    timer = setTimeout(() => rejectCallback?.(new PublicError('Pixapi authorization timed out. Run "pixapi-mcp login" and complete the browser sign-in.')), options.timeoutMs ?? 180_000);
  }
  const provider: OAuthClientProvider = {
    get redirectUrl() { return saved.redirectUrl; },
    get clientMetadata() { return { client_name: 'Pixapi MCP', application_type: 'native', redirect_uris: [saved.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
    async state() { await startListener(); return state; },
    clientInformation: () => saved.client,
    async saveClientInformation(client) { saved.client = client; await persist(); },
    tokens: () => saved.tokens,
    async saveTokens(tokens) {
      saved.tokens = tokens;
      saved.expiresAt = tokens.expires_in === undefined ? undefined : now() + tokens.expires_in * 1000;
      await persist();
    },
    async redirectToAuthorization(url) {
      try { await (options.openBrowser ?? openBrowser)(url.href); }
      catch { throw new PublicError('Could not open a browser for Pixapi authorization. Run "pixapi-mcp login" on a computer with a browser.'); }
    },
    saveCodeVerifier(value) { verifier = value; },
    codeVerifier: () => verifier,
    async saveDiscoveryState(discovery) { issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl.toString(); },
    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'client') saved.client = undefined;
      if (scope === 'all' || scope === 'tokens') { saved.tokens = undefined; saved.expiresAt = undefined; }
      if (scope === 'verifier') verifier = '';
      await persist();
    },
  };
  // Serialize browser consent and rotating refresh tokens across MCP processes.
  // The PID allows recovery after a crashed process without stealing a live lock.
  async function lock() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lockPath = `${path}.lock`;
    const deadline = now() + (options.timeoutMs ?? 180_000);
    while (!closed) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try { await handle.writeFile(String(process.pid)); }
        catch (error) { await rm(lockPath, { force: true }); throw error; }
        finally { await handle.close(); }
        return async () => { await rm(lockPath, { force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const owner = Number(await readFile(lockPath, 'utf8'));
          if (Number.isInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(lockPath, { force: true }); }
          } else if (now() - (await stat(lockPath)).mtimeMs > 180_000) {
            await rm(lockPath, { force: true });
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (now() >= deadline) throw new PublicError('Another Pixapi login is still running. Complete or close it, then retry.');
        await delay(100);
      }
    }
    throw new PublicError('Pixapi authorization was cancelled. Restart the MCP client.');
  }
  const valid = () => saved.tokens && (saved.expiresAt === undefined || saved.expiresAt > now() + 30_000);
  async function authorize(force = false): Promise<void> {
    if (closed) throw new PublicError('Pixapi OAuth session is closed. Restart the MCP client.');
    if (pending) return pending;
    if (!force && valid()) return;
    const previousToken = saved.tokens?.access_token;
    pending = (async () => {
      let unlock: (() => Promise<void>) | undefined;
      try {
        unlock = await lock();
        await reload();
        if (valid() && (!force || previousToken !== saved.tokens?.access_token)) return;
        // Registration needs a real redirect URI before the SDK builds metadata.
        if (!saved.redirectUrl) await startListener();
        const result = await auth(provider, { serverUrl, fetchFn: oauthFetch });
        if (closed) throw new PublicError('Pixapi authorization was cancelled. Restart the MCP client.');
        if (result === 'REDIRECT') {
          const authorizationCode = await callback!;
          if (await auth(provider, { serverUrl, authorizationCode, fetchFn: oauthFetch }) !== 'AUTHORIZED') throw Error('Authorization incomplete');
        }
      } catch (error) {
        if (error instanceof PublicError) throw error;
        throw new PublicError('Pixapi OAuth could not complete. Check your connection and retry "pixapi-mcp login".');
      } finally { await stopListener(); await unlock?.(); }
    })();
    try { await pending; } finally { pending = undefined; }
  }
  const authenticatedFetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    // Credentials belong only to this MCP resource, including redirects.
    if (url.origin !== serverUrl.origin || url.pathname !== serverUrl.pathname) throw new PublicError('Unexpected OAuth request destination. Restart the MCP client.');
    if (saved.tokens && !valid()) await authorize();
    const request = new Request(input, init);
    const send = () => {
      const copy = request.clone();
      if (saved.tokens) copy.headers.set('Authorization', `Bearer ${saved.tokens.access_token}`);
      return fetch(copy, { redirect: 'error' });
    };
    const response = await send();
    if (response.status !== 401) return response;
    await response.body?.cancel();
    await authorize(true);
    return send();
  };
  return {
    authorize,
    hasTokens: () => Boolean(saved.tokens),
    fetch: authenticatedFetch,
    async close() {
      closed = true;
      controller.abort();
      rejectCallback?.(new PublicError('Pixapi authorization was cancelled. Restart the MCP client to try again.'));
      await stopListener();
    },
  };
}
