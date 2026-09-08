import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function run(args: string[], home: string, apiKey = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PIXAPI_API_KEY: apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

it('does not print remote HTTP error bodies to stderr or stdout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pixapi-cli-test-'));
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('PRIVATE_MARKER SQL password=sk_secret');
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    await mkdir(join(home, '.pixapi'));
    await writeFile(join(home, '.pixapi/mcp-credentials.json'), JSON.stringify({
      version: 1, apiKey: 'sk_test', expiresAt: null,
      mcpUrl: `http://localhost:${address.port}/mcp`,
    }));
    const result = await run(['proxy'], home);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(/PRIVATE_MARKER|SQL|sk_secret/);
    expect(result.stderr).toContain('temporarily unavailable');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

it.each([
  ['codex', ['.codex/config.toml']],
  ['vscode', ['.vscode/mcp.json']],
  ['gemini-cli', ['.gemini/settings.json']],
  ['all', ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml', '.vscode/mcp.json', '.gemini/settings.json']],
  ['both', ['.mcp.json', '.cursor/mcp.json']],
])('initializes the selected %s client through the CLI', async (client, paths) => {
  const home = await mkdtemp(join(tmpdir(), 'pixapi-cli-test-'));
  const project = join(home, 'project');
  try {
    const result = await run(['init', '--client', client, '--project', project], home, 'sk_cli_test');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('sk_cli_test');
    for (const path of paths) {
      const content = await readFile(join(project, path), 'utf8');
      expect(content).toContain('pixapi-mcp');
      expect(content).not.toContain('sk_cli_test');
    }
    const credential = JSON.parse(await readFile(join(home, '.pixapi/mcp-credentials.json'), 'utf8'));
    expect(credential.apiKey).toBe('sk_cli_test');
    if (client !== 'all' && client !== 'both') {
      await expect(readFile(join(project, '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('configures OAuth without a key and does not echo unknown arguments', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pixapi-cli-test-'));
  try {
    const init = await run(['init', '--project', join(home, 'project'), '--client', 'codex'], home);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('OAuth');
    expect(await readFile(join(home, 'project/.codex/config.toml'), 'utf8')).toContain('https://api.pixapi.ai/mcp');
    await expect(readFile(join(home, '.pixapi/mcp-credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await run(['sk_private_argument'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('sk_private_argument');
    expect(result.stderr).toContain('--help');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
