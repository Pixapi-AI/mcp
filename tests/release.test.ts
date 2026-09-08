import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { checkReleaseVersion, releaseState } from '../scripts/release-state.mjs';

const pkg = { name: 'pixapi-mcp', version: '0.1.4' };
const manifest = { name: 'io.github.Pixapi-AI/pixapi-mcp', version: '0.1.4', packages: [{ identifier: 'pixapi-mcp', version: '0.1.4' }] };
it('keeps an npm lockfile so the publish workflow can run npm ci', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  expect(lock.name).toBe(pkg.name);
  expect(lock.version).toBe(pkg.version);
  expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
  expect(lock.packages['']?.dependencies?.['@modelcontextprotocol/sdk']).toBe(
    pkg.dependencies['@modelcontextprotocol/sdk']
  );
  expect(lock.packages['node_modules/@modelcontextprotocol/sdk']?.version).toBe('1.29.0');
  expect(JSON.stringify(lock)).not.toContain('../../node_modules');
  expect(await readFile('.github/workflows/publish.yml', 'utf8')).toMatch(/^\s+run: npm ci$/m);
});

it('requires the exact version tag for both automatic and manual releases', () => {
  expect(() => checkReleaseVersion('refs/heads/main', pkg, manifest)).toThrow('tag');
  expect(() => checkReleaseVersion('refs/tags/v0.1.3', pkg, manifest)).toThrow('version');
  expect(() => checkReleaseVersion('refs/tags/v0.1.4', pkg, manifest)).not.toThrow();
});
it('publishes missing versions and resumes a partially published release', async () => {
  const missing = async () => new Response('', { status: 404 });
  expect(await releaseState(pkg, manifest, 'sha512-test', missing)).toEqual({ npm: true, registry: true });
  const partial = async (url: string) => url.includes('registry.npmjs.org')
    ? Response.json({ dist: { integrity: 'sha512-test' } }) : new Response('', { status: 404 });
  expect(await releaseState(pkg, manifest, 'sha512-test', partial)).toEqual({ npm: false, registry: true });
  const complete = async (url: string) => url.includes('registry.npmjs.org')
    ? Response.json({ dist: { integrity: 'sha512-test' } }) : Response.json({ server: manifest });
  expect(await releaseState(pkg, manifest, 'sha512-test', complete)).toEqual({ npm: false, registry: false });
});
it('rejects mismatched existing releases and does not treat network errors as missing versions', async () => {
  await expect(releaseState(pkg, manifest, 'sha512-test', async () => Response.json({ dist: { integrity: 'sha512-other' } }))).rejects.toThrow('npm');
  const mismatch = async (url: string) => url.includes('registry.npmjs.org')
    ? Response.json({ dist: { integrity: 'sha512-test' } }) : Response.json({ server: { ...manifest, packages: [] } });
  await expect(releaseState(pkg, manifest, 'sha512-test', mismatch)).rejects.toThrow('Registry');
  await expect(releaseState(pkg, manifest, 'sha512-test', async () => new Response('', { status: 503 }))).rejects.toThrow('503');
});
