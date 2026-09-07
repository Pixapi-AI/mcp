import { spawn } from 'node:child_process';

export async function openBrowser(urlValue: string): Promise<void> {
  const url = new URL(urlValue);
  // 安装确认页会处理账号登录，生产地址必须使用 HTTPS。
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
    // URL 作为独立参数传入，并禁用 shell，避免被解释成命令片段。
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
