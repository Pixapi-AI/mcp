import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function checkReleaseVersion(ref, pkg, manifest) {
  if (!/^refs\/tags\/v\d+\.\d+\.\d+$/.test(ref ?? '')) {
    throw new Error('Run this workflow on a release tag, including manual reruns.');
  }
  if (ref !== `refs/tags/v${pkg.version}` || manifest.version !== pkg.version ||
      !manifest.packages?.length || manifest.packages.some(p => p.version !== pkg.version || p.identifier !== pkg.name)) {
    throw new Error('The tag, package and Registry manifest version must match.');
  }
}

function includes(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => includes(actual[index], value));
  if (expected && typeof expected === 'object') return actual && Object.entries(expected).every(([key, value]) => includes(actual[key], value));
  return actual === expected;
}

export async function releaseState(pkg, manifest, integrity, fetcher = fetch) {
  async function lookup(url) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Release lookup failed with HTTP ${response.status}; retry later.`);
    return response.json();
  }
  const npm = await lookup(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`);
  if (npm && npm.dist?.integrity !== integrity) throw new Error('Existing npm version contains different content. Use a new version.');
  const registry = await lookup(`https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(manifest.name)}/versions/${encodeURIComponent(manifest.version)}`);
  if (registry && !includes(registry.server, manifest)) throw new Error('Existing Registry version contains different metadata. Use a new version.');
  return { npm: !npm, registry: !registry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const manifest = JSON.parse(await readFile('server.json', 'utf8'));
  checkReleaseVersion(process.env.GITHUB_REF, pkg, manifest);
  if (process.argv[2] !== '--validate-version') {
    const artifact = `${pkg.name}-${pkg.version}.tgz`;
    const integrity = `sha512-${createHash('sha512').update(await readFile(artifact)).digest('base64')}`;
    const state = await releaseState(pkg, manifest, integrity);
    console.log(`npm=${state.npm}\nregistry=${state.registry}\nartifact=${artifact}`);
  }
}
