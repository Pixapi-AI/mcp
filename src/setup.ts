import { configureProjectClients, type SupportedClient } from './config-writer.js';
import { validateCredential, writeCredential } from './credential-store.js';
import { PublicError } from './public-error.js';

const DEFAULT_MCP_URL = 'https://api.pixapi.ai/mcp';

export interface ConfigureWithApiKeyOptions {
  apiKey: string;
  projectDir: string;
  clients: SupportedClient[];
  homeDir?: string;
  mcpUrl?: string;
}

export interface ConfigureWithApiKeyResult {
  credentialPath: string;
  configs: Awaited<ReturnType<typeof configureProjectClients>>;
}

export async function configureWithApiKey(
  options: ConfigureWithApiKeyOptions
): Promise<ConfigureWithApiKeyResult> {
  if (!options.apiKey) {
    throw new PublicError(
      'PIXAPI_API_KEY is required. Create one at https://pixapi.ai/settings/apikeys.'
    );
  }

  const credential = validateCredential({
    version: 1,
    apiKey: options.apiKey,
    expiresAt: null,
    mcpUrl: options.mcpUrl ?? DEFAULT_MCP_URL,
  });
  // Validate before any writes, and replace the shared credential only after
  // every project config has been written successfully.
  const configs = await configureProjectClients({
    projectDir: options.projectDir,
    clients: options.clients,
  });
  const credentialPath = await writeCredential(credential, {
    homeDir: options.homeDir,
  });

  return { credentialPath, configs };
}
