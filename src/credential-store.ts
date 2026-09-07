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
 * 本地代理读取的最小凭证集合。
 * 不保存用户资料、订单或余额；这些数据始终属于服务端正式账号。
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
  // 凭证放在用户私有目录，而不是项目目录，避免被 Git 意外提交。
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
 * 原子写入完整 API Key：
 * 1. 私有目录 0700；2. 临时文件 0600；3. rename 替换正式文件。
 * 即使进程在写入中途退出，也不会留下可被代理误读的半截 JSON。
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

/** 读取并验证凭证；过期 key 不会被本地代理继续使用。 */
export async function loadCredential(
  options: CredentialStoreOptions = {}
): Promise<StoredCredential> {
  const { path } = credentialPaths(options);
  const content = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PublicError('Invalid Pixapi credential file. Run "pixapi-mcp init" again.');
  }

  const credential = validateCredential(parsed);
  if (
    credential.expiresAt !== null &&
    Date.parse(credential.expiresAt) <= Date.now()
  ) {
    // 不做静默刷新：用户重新登录授权后，服务端会创建一把新的设备 key。
    throw new PublicError('Pixapi API key expired. Run "npx pixapi-mcp init" again.');
  }
  return credential;
}
