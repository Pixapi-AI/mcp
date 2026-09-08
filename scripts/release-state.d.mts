interface Package { name: string; version: string }
interface Manifest { name: string; version: string; packages: Array<{ identifier: string; version: string }> }
export function checkReleaseVersion(ref: string, pkg: Package, manifest: Manifest): void;
export function releaseState(pkg: Package, manifest: Manifest, integrity: string, fetcher?: (url: string) => Promise<Response>): Promise<{ npm: boolean; registry: boolean }>;
