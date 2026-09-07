import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { expect, it } from 'vitest';
import { PublicError, publicErrorMessage } from '../src/public-error.js';

it.each([
  [new StreamableHTTPError(401, 'sk_private'), 'authentication failed'],
  [new StreamableHTTPError(403, 'sk_private'), 'authentication failed'],
  [new UnauthorizedError('sk_private'), 'authentication failed'],
  [new StreamableHTTPError(502, '<html>sk_private</html>'), 'temporarily unavailable'],
  [Object.assign(new Error('sk_private'), { code: 'ENOENT' }), 'file is missing'],
  [Object.assign(new Error('sk_private'), { code: 'EACCES' }), 'permissions'],
  [Object.assign(new Error('sk_private'), { code: 'EPERM' }), 'permissions'],
  [new Error('sk_private'), '--help'],
  ['sk_private', '--help'],
  [null, '--help'],
])('provides safe guidance for error %#', (error, guidance) => {
  const message = publicErrorMessage(error);
  expect(message).toContain(guidance);
  expect(message).not.toContain('sk_private');
});

it('preserves locally authored guidance', () => {
  expect(publicErrorMessage(new PublicError('Run init again.'))).toBe('Run init again.');
});
