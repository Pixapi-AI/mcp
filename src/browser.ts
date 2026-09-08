import { spawn } from 'node:child_process';

export async function openBrowser(urlValue: string): Promise<void> {
  const url = new URL(urlValue);
  // Production authorization URLs must use HTTPS. Localhost HTTP is for development.
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('Verification URL must use HTTPS.');
  }

  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32'
        : 'xdg-open';
  const args =
    process.platform === 'win32'
      ? ['url.dll,FileProtocolHandler', url.toString()]
      : [url.toString()];

  await new Promise<void>((resolve, reject) => {
    // Pass the URL as an argument with shell disabled so it is not interpreted as a command.
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
