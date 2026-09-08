import { readFileSync } from 'node:fs';

// src/ and dist/ are both directly below the published package root.
export const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;
