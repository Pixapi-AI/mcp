import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { DEFAULT_MCP_URL } from './oauth.js';
import { PublicError } from './public-error.js';

/** Only installation formats differ; authentication uses standard OAuth. */
const CLIENT_CONFIGS = {
  'claude-code': { path: '.mcp.json', format: 'json', key: 'mcpServers', type: true, remote: { type: 'http', url: DEFAULT_MCP_URL } },
  cursor: { path: '.cursor/mcp.json', format: 'json', key: 'mcpServers', type: true, remote: { url: DEFAULT_MCP_URL } },
  codex: { path: '.codex/config.toml', format: 'toml', key: 'mcp_servers', type: false, remote: { url: DEFAULT_MCP_URL } },
  vscode: { path: '.vscode/mcp.json', format: 'jsonc', key: 'servers', type: true, remote: { type: 'http', url: DEFAULT_MCP_URL } },
  'gemini-cli': { path: '.gemini/settings.json', format: 'json', key: 'mcpServers', type: false, remote: { httpUrl: DEFAULT_MCP_URL } },
} as const;

export type SupportedClient = keyof typeof CLIENT_CONFIGS;
export const SUPPORTED_CLIENTS = Object.keys(CLIENT_CONFIGS) as SupportedClient[];
export const DEFAULT_CLIENTS: SupportedClient[] = ['claude-code', 'cursor'];

export function isSupportedClient(value: string): value is SupportedClient {
  return Object.hasOwn(CLIENT_CONFIGS, value);
}

export interface ConfigureProjectClientsOptions {
  projectDir: string;
  clients: SupportedClient[];
  transport?: 'remote' | 'stdio';
}

export interface ConfigWriteResult {
  client: SupportedClient;
  path: string;
}

type JsonRecord = Record<string, unknown>;
type ClientConfig = (typeof CLIENT_CONFIGS)[SupportedClient];

// No credentials in project files. The proxy reads the shared private store.
const PIXAPI_SERVER_CONFIG = {
  command: 'npx',
  args: ['-y', 'pixapi-mcp', 'proxy'],
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readConfig(path: string, definition: ClientConfig): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return definition.format === 'toml' ? '' : '{}';
    }
    throw error;
  }
}

function updateConfig(content: string, definition: ClientConfig, transport: 'remote' | 'stdio'): string {
  let parsed: unknown;
  const format = definition.format === 'toml' ? 'TOML' : 'JSON';
  try {
    if (definition.format === 'toml') {
      parsed = parseToml(content);
    } else if (definition.format === 'jsonc') {
      const errors: ParseError[] = [];
      parsed = parseJsonc(content, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error('Invalid JSONC');
    } else {
      parsed = JSON.parse(content);
    }
  } catch {
    throw new PublicError(`Cannot update invalid ${format} config. Fix the selected project MCP configuration and run init again.`);
  }
  if (!isRecord(parsed)) {
    throw new PublicError(`Cannot update non-object ${format} config. Fix the selected project MCP configuration and run init again.`);
  }
  const server = transport === 'remote' ? { ...definition.remote } : definition.type
    ? { type: 'stdio', ...PIXAPI_SERVER_CONFIG }
    : { ...PIXAPI_SERVER_CONFIG };
  const existingServers = parsed[definition.key];
  const servers = {
    ...(isRecord(existingServers) ? existingServers : {}),
    pixapi: server,
  };

  if (definition.format === 'jsonc') {
    // VS Code files commonly contain comments and trailing commas.
    const path = isRecord(existingServers) ? [definition.key, 'pixapi'] : [definition.key];
    return applyEdits(content, modify(content, path,
      isRecord(existingServers) ? server : servers,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  const updated = { ...parsed, [definition.key]: servers };
  return definition.format === 'toml'
    ? stringifyToml(updated)
    : `${JSON.stringify(updated, null, 2)}\n`;
}

async function writePrivateConfig(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

export async function configureProjectClients(
  options: ConfigureProjectClientsOptions
): Promise<ConfigWriteResult[]> {
  const projectDir = resolve(options.projectDir);
  const pending: Array<ConfigWriteResult & { content: string }> = [];

  // Read and validate every file before writing any client configuration.
  for (const client of new Set(options.clients)) {
    if (!isSupportedClient(client)) {
      throw new PublicError('Unsupported client. Run "pixapi-mcp --help".');
    }
    const definition = CLIENT_CONFIGS[client];
    const path = join(projectDir, definition.path);
    const content = updateConfig(await readConfig(path, definition), definition, options.transport ?? 'remote');
    pending.push({ client, path, content });
  }

  for (const { path, content } of pending) {
    await writePrivateConfig(path, content);
  }
  return pending.map(({ client, path }) => ({ client, path }));
}
