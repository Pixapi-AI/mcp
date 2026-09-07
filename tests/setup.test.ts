import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configureWithApiKey } from '../src/setup.js';

describe('configureWithApiKey', () => {
  it('stores a dashboard API key and writes credential-free client configs', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));

    const result = await configureWithApiKey({
      apiKey: 'sk_dashboard_key',
      homeDir,
      projectDir,
      clients: ['claude-code', 'cursor'],
    });

    expect(result.credentialPath).toBe(
      join(homeDir, '.pixapi', 'mcp-credentials.json')
    );
    expect(JSON.parse(await readFile(result.credentialPath, 'utf8'))).toEqual({
      version: 1,
      apiKey: 'sk_dashboard_key',
      expiresAt: null,
      mcpUrl: 'https://api.pixapi.ai/mcp',
    });
    for (const config of result.configs) {
      const content = await readFile(config.path, 'utf8');
      expect(content).not.toContain('sk_dashboard_key');
      expect(JSON.parse(content).mcpServers.pixapi.args).toEqual([
        '-y',
        'pixapi-mcp',
        'proxy',
      ]);
    }
  });

  it('preserves the existing credential when project configuration fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    const options = { homeDir, projectDir, clients: ['claude-code'] as const };
    const first = await configureWithApiKey({ ...options, clients: [...options.clients], apiKey: 'sk_original' });
    const original = await readFile(first.credentialPath, 'utf8');
    await writeFile(join(projectDir, '.mcp.json'), 'broken json');
    await expect(configureWithApiKey({ ...options, clients: [...options.clients], apiKey: 'sk_replacement' })).rejects.toThrow();
    expect(await readFile(first.credentialPath, 'utf8')).toBe(original);
  });

  it('preserves the existing credential when a config cannot be written', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    const first = await configureWithApiKey({ homeDir, projectDir, clients: ['claude-code'], apiKey: 'sk_original' });
    const original = await readFile(first.credentialPath, 'utf8');
    // A regular file where a directory is needed makes Cursor configuration fail.
    await writeFile(join(projectDir, '.cursor'), 'not a directory');
    await expect(configureWithApiKey({ homeDir, projectDir, clients: ['cursor'], apiKey: 'sk_replacement' })).rejects.toThrow();
    expect(await readFile(first.credentialPath, 'utf8')).toBe(original);
  });

  it('rejects missing and malformed API keys before writing files', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));

    await expect(
      configureWithApiKey({
        apiKey: '',
        homeDir,
        projectDir,
        clients: ['claude-code'],
      })
    ).rejects.toThrow('PIXAPI_API_KEY');
    await expect(
      configureWithApiKey({
        apiKey: 'not-a-key',
        homeDir,
        projectDir,
        clients: ['claude-code'],
      })
    ).rejects.toThrow('Invalid Pixapi API key');
    await expect(readFile(join(projectDir, '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
