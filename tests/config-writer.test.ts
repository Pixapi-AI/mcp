import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';

import { configureProjectClients } from '../src/config-writer.js';

describe('configureProjectClients', () => {
  it('configures Codex without losing other TOML settings or servers', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    const path = join(projectDir, '.codex', 'config.toml');
    await mkdir(join(projectDir, '.codex'));
    await writeFile(path, 'model = "custom-model"\n[mcp_servers.existing]\ncommand = "existing"\n[mcp_servers.pixapi]\nurl = "https://old.example/mcp"\n');
    const results = await configureProjectClients({ transport: 'stdio', projectDir, clients: ['codex'] });
    expect(results).toEqual([{ client: 'codex', path }]);
    const content = await readFile(path, 'utf8');
    expect(parseToml(content)).toEqual({
      model: 'custom-model',
      mcp_servers: {
        existing: { command: 'existing' },
        pixapi: { command: 'npx', args: ['-y', 'pixapi-mcp', 'proxy'] },
      },
    });
    expect(content).not.toContain('sk_');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await configureProjectClients({ transport: 'stdio', projectDir, clients: ['codex'] });
    expect(await readFile(path, 'utf8')).toBe(content);
  });

  it('configures VS Code using servers and preserves JSONC comments and inputs', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    const path = join(projectDir, '.vscode', 'mcp.json');
    await mkdir(join(projectDir, '.vscode'));
    await writeFile(path, '{\n // Keep this comment\n "inputs": [],\n "servers": {"existing": {"command": "existing"}},\n}\n');
    await configureProjectClients({ transport: 'stdio', projectDir, clients: ['vscode'] });
    const content = await readFile(path, 'utf8');
    expect(content).toContain('// Keep this comment');
    expect(parseJsonc(content)).toEqual({ inputs: [], servers: {
      existing: { command: 'existing' },
      pixapi: { type: 'stdio', command: 'npx', args: ['-y', 'pixapi-mcp', 'proxy'] },
    } });
  });

  it('configures Gemini CLI without changing other settings', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    const path = join(projectDir, '.gemini', 'settings.json');
    await mkdir(join(projectDir, '.gemini'));
    await writeFile(path, JSON.stringify({ ui: { theme: 'Default' } }));
    await configureProjectClients({ transport: 'stdio', projectDir, clients: ['gemini-cli'] });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      ui: { theme: 'Default' },
      mcpServers: { pixapi: { command: 'npx', args: ['-y', 'pixapi-mcp', 'proxy'] } },
    });
  });

  it('rejects malformed Codex TOML before modifying any selected config', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    await mkdir(join(projectDir, '.codex'));
    await writeFile(join(projectDir, '.codex/config.toml'), 'model = [');
    await expect(configureProjectClients({ transport: 'stdio', projectDir, clients: ['claude-code', 'codex'] })).rejects.toThrow('TOML');
    await expect(readFile(join(projectDir, '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(projectDir, '.codex/config.toml'), 'utf8')).toBe('model = [');
  });

  it('adds a credential-free stdio proxy to Claude Code and Cursor', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));

    const results = await configureProjectClients({ transport: 'stdio',
      projectDir,
      clients: ['claude-code', 'cursor'],
    });

    expect(results).toHaveLength(2);
    for (const relativePath of ['.mcp.json', '.cursor/mcp.json']) {
      const content = await readFile(join(projectDir, relativePath), 'utf8');
      expect(content).not.toContain('sk_');
      expect(JSON.parse(content).mcpServers.pixapi).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'pixapi-mcp', 'proxy'],
      });
    }
  });

  it('preserves unrelated MCP servers and config fields', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    await mkdir(join(projectDir, '.cursor'), { recursive: true });
    await writeFile(
      join(projectDir, '.cursor/mcp.json'),
      JSON.stringify({
        custom: true,
        mcpServers: { existing: { command: 'existing-mcp' } },
      })
    );

    await configureProjectClients({ transport: 'stdio',
      projectDir,
      clients: ['cursor'],
    });

    const config = JSON.parse(
      await readFile(join(projectDir, '.cursor/mcp.json'), 'utf8')
    );
    expect(config.custom).toBe(true);
    expect(config.mcpServers.existing.command).toBe('existing-mcp');
    expect(config.mcpServers.pixapi.command).toBe('npx');
  });

  it('uses owner-only permissions because configs execute a local command', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));

    await configureProjectClients({ transport: 'stdio',
      projectDir,
      clients: ['claude-code'],
    });

    expect((await stat(join(projectDir, '.mcp.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite invalid existing config', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    await writeFile(join(projectDir, '.mcp.json'), 'not-json');

    await expect(
      configureProjectClients({ transport: 'stdio',
        projectDir,
        clients: ['claude-code'],
      })
    ).rejects.toThrow('Cannot update invalid JSON config');

    await writeFile(join(projectDir, '.mcp.json'), '[]');
    await expect(
      configureProjectClients({ transport: 'stdio',
        projectDir,
        clients: ['claude-code'],
      })
    ).rejects.toThrow('Cannot update non-object JSON config');
  });

  it('deduplicates clients and replaces a malformed mcpServers field', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-project-'));
    await writeFile(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: 'invalid' })
    );

    const results = await configureProjectClients({ transport: 'stdio',
      projectDir,
      clients: ['claude-code', 'claude-code'],
    });

    expect(results).toHaveLength(1);
    const config = JSON.parse(
      await readFile(join(projectDir, '.mcp.json'), 'utf8')
    );
    expect(config.mcpServers.pixapi.command).toBe('npx');
  });
});

 it('defaults all clients to native remote OAuth without credential inputs', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'pixapi-oauth-config-'));
  const clients = ['claude-code', 'cursor', 'codex', 'vscode', 'gemini-cli'] as const;
  await configureProjectClients({ projectDir, clients: [...clients] });
  const read = async (path: string) => JSON.parse(await readFile(join(projectDir, path), 'utf8'));
  const url = 'https://api.pixapi.ai/mcp';
  expect((await read('.mcp.json')).mcpServers.pixapi).toEqual({ type: 'http', url });
  expect((await read('.cursor/mcp.json')).mcpServers.pixapi).toEqual({ url });
  expect(parseToml(await readFile(join(projectDir, '.codex/config.toml'), 'utf8'))).toEqual({ mcp_servers: { pixapi: { url } } });
  expect((await read('.vscode/mcp.json')).servers.pixapi).toEqual({ type: 'http', url });
  expect((await read('.gemini/settings.json')).mcpServers.pixapi).toEqual({ httpUrl: url });
});
