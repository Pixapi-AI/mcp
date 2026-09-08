import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PublicError } from './public-error.js';

/**
 * Minimal credential set read by the local bridge.
 * Profile, order, and balance data stay on the server account.
 */
export interface StoredCredential {
  version: 1;
  apiKey: string;
  expiresAt: string | null;
  mcpUrl: string;
}

interface CredentialStoreOptions {
  homeDir?: string;
}

function credentialPaths(options: CredentialStoreOptions = {}) {
  // Keep credentials in the user-private directory, not the project tree.
  const directory = join(options.homeDir ?? homedir(), '.pixapi');
  const path = join(directory, 'mcp-credentials.json');
  return { directory, path, temporaryPath: `${path}.tmp` };
}

export function validateCredential(value: unknown): StoredCredential {
  if (!value || typeof value !== 'object') {
    throw new PublicError('Invalid Pixapi credential file. Run "pixapi-mcp init" again.');
  }

  const credential = value as Partial<StoredCredential>;
  if (
    credential.version !== 1 ||
    typeof credential.apiKey !== 'string' ||
    !credential.apiKey.startsWith('sk_')
  ) {
    throw new PublicError('Invalid Pixapi API key. Copy the complete key from your Pixapi account.');
  }
  if (
    credential.expiresAt !== null &&
    (typeof credential.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(credential.expiresAt)))
  ) {
    throw new PublicError('Invalid Pixapi API key expiration time. Run "pixapi-mcp init" again.');
  }
  if (typeof credential.mcpUrl !== 'string') {
    throw new PublicError('Invalid Pixapi MCP URL. Run "pixapi-mcp init" again.');
  }
  let mcpUrl: URL;
  try {
    mcpUrl = new URL(credential.mcpUrl);
  } catch {
    throw new PublicError('Invalid Pixapi MCP URL. Run "pixapi-mcp init" again.');
  }
  if (mcpUrl.protocol !== 'https:' && mcpUrl.hostname !== 'localhost') {
    throw new PublicError('Invalid Pixapi MCP URL. Run "pixapi-mcp init" again.');
  }

  return credential as StoredCredential;
}

export function getCredentialPath(options: CredentialStoreOptions = {}): string {
  return credentialPaths(options).path;
}

/**
 * Atomically write the full API key:
 * 1. private directory 0700; 2. temp file 0600; 3. rename into place.
 * A crash during the write cannot leave a half-written JSON file for the bridge to read.
 */
export async function writeCredential(
  credential: StoredCredential,
  options: CredentialStoreOptions = {}
): Promise<string> {
  const validated = validateCredential(credential);
  const { directory, path, temporaryPath } = credentialPaths(options);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  // rename preserves the temporary file's permissions. Keep it as the final
  // operation so a later chmod failure cannot report failure after replacement.
  await rename(temporaryPath, path);

  return path;
}

/** Read and validate credentials. Expired keys are not used by the local bridge. */
export async function loadCredential(
  options: CredentialStoreOptions = {}
): Promise<StoredCredential> {
  const { path } = credentialPaths(options);
  const content = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PublicError('Invalid Pixapi credential file. Remove ~/.pixapi/mcp-credentials.json or run "pixapi-mcp login".');
  }

  const credential = validateCredential(parsed);
  if (
    credential.expiresAt !== null &&
    Date.parse(credential.expiresAt) <= Date.now()
  ) {
    // Do not silently refresh API keys; the stdio bridge falls back to OAuth.
    throw new PublicError('Pixapi API key expired. Run "pixapi-mcp login" or set PIXAPI_API_KEY.');
  }
  return credential;
}
