import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getCredentialPath,
  loadCredential,
  writeCredential,
  type StoredCredential,
} from '../src/credential-store.js';

const credential: StoredCredential = {
  version: 1,
  apiKey: 'sk_test_credential',
  expiresAt: null,
  mcpUrl: 'https://api.pixapi.ai/mcp',
};

describe('credential store', () => {
  it('writes the API key to a private file and reads it back', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-mcp-'));

    const path = await writeCredential(credential, { homeDir });

    expect(await loadCredential({ homeDir })).toEqual(credential);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(homeDir, '.pixapi'))).mode & 0o777).toBe(0o700);
  });

  it('refuses to persist malformed credentials', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-mcp-'));

    await expect(
      writeCredential({ ...credential, apiKey: 'not-a-pixapi-key' }, { homeDir })
    ).rejects.toThrow('Invalid Pixapi API key');
  });

  it('does not leave the API key in a temporary file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-mcp-'));

    const path = await writeCredential(credential, { homeDir });
    const serialized = await readFile(path, 'utf8');

    expect(serialized).toContain(credential.apiKey);
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects malformed, expired, and insecure credential files', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-mcp-'));
    const directory = join(homeDir, '.pixapi');
    const path = getCredentialPath({ homeDir });
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(directory, { recursive: true })
    );

    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(path, 'not-json')
    );
    await expect(loadCredential({ homeDir })).rejects.toThrow(
      'Invalid Pixapi credential file'
    );

    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(
        path,
        JSON.stringify({
          ...credential,
          expiresAt: '2020-01-01T00:00:00.000Z',
        })
      )
    );
    await expect(loadCredential({ homeDir })).rejects.toThrow('expired');

    await expect(
      writeCredential(
        { ...credential, mcpUrl: 'http://api.pixapi.ai/mcp' },
        { homeDir }
      )
    ).rejects.toThrow('Invalid Pixapi MCP URL');
  });

  it('accepts a non-expiring dashboard API key', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'pixapi-mcp-'));

    await writeCredential(credential, { homeDir });

    await expect(loadCredential({ homeDir })).resolves.toEqual(credential);
  });
});
