#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  DEFAULT_CLIENTS,
  SUPPORTED_CLIENTS,
  isSupportedClient,
  type SupportedClient,
} from './config-writer.js';
import { runProxy } from './proxy.js';
import { configureWithApiKey } from './setup.js';
import { PublicError, publicErrorMessage } from './public-error.js';

interface InitOptions {
  projectDir: string;
  clients: SupportedClient[];
}

function usage(): string {
  return `Pixapi MCP

Usage:
  pixapi-mcp init [options]   Configure your MCP client
  pixapi-mcp proxy            Run the local stdio-to-remote MCP proxy

Options:
  --project <path>            Project to configure (default: current directory)
  --client <${SUPPORTED_CLIENTS.join('|')}|all|both>
                             Default: both (Claude Code and Cursor)
  --help                      Show this help

Authentication:
  Set PIXAPI_API_KEY to configure with a key from
  https://pixapi.ai/settings/apikeys.
`;
}

function takeValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new PublicError(`${option} requires a value. Run "pixapi-mcp --help".`);
  }
  return value;
}

function parseInitOptions(args: string[]): InitOptions {
  const options: InitOptions = {
    projectDir: process.cwd(),
    clients: [...DEFAULT_CLIENTS],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--project') {
      options.projectDir = resolve(takeValue(args, index, argument));
      index += 1;
    } else if (argument === '--client') {
      const client = takeValue(args, index, argument);
      if (client === 'both') {
        options.clients = [...DEFAULT_CLIENTS];
      } else if (client === 'all') {
        options.clients = [...SUPPORTED_CLIENTS];
      } else if (isSupportedClient(client)) {
        options.clients = [client];
      } else {
        throw new PublicError('Unsupported client. Run "pixapi-mcp --help" for available clients.');
      }
      index += 1;
    } else if (argument === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      throw new PublicError('Unknown option. Run "pixapi-mcp --help".');
    }
  }

  return options;
}

async function init(args: string[]): Promise<void> {
  const options = parseInitOptions(args);
  const result = await configureWithApiKey({
    apiKey: process.env.PIXAPI_API_KEY ?? '',
    projectDir: options.projectDir,
    clients: options.clients,
  });
  process.stdout.write('Pixapi is connected.\n');
  process.stdout.write(`Private credential: ${result.credentialPath}\n`);
  for (const config of result.configs) {
    process.stdout.write(`Configured ${config.client}: ${config.path}\n`);
  }
}

async function main(): Promise<void> {
  // 无参数默认启动代理，符合 MCP 客户端把本包当 stdio server 执行的方式。
  const [command = 'proxy', ...args] = process.argv.slice(2);
  if (command === 'init') {
    await init(args);
    return;
  }
  if (command === 'proxy') {
    const proxy = await runProxy();
    const close = async () => {
      await proxy.close();
      process.exit(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (command === '--help' || command === 'help') {
    process.stdout.write(usage());
    return;
  }
  throw new PublicError('Unknown command. Run "pixapi-mcp --help".');
}

main().catch((error: unknown) => {
  const message = publicErrorMessage(error);
  process.stderr.write(`Pixapi MCP error: ${message}\n`);
  process.exitCode = 1;
});
