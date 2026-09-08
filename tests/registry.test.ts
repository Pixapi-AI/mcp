import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('offers keyless npm and remote Registry installations', async () => {
  const registry = JSON.parse(await readFile('server.json', 'utf8'));
  expect(registry.packages[0].environmentVariables ?? []).toEqual([]);
  expect(registry.remotes).toContainEqual({ type: 'streamable-http', url: 'https://api.pixapi.ai/mcp' });
});
