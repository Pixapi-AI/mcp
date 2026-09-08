/** Client and device labels shown on the user's credential management page. */
export interface StartInstallParams {
  clientName: string;
  deviceName: string;
}

/**
 * One-time install session returned by the start endpoint.
 * deviceCode is a high-entropy redeem token and must not be printed;
 * userCode is the short code shown to the user.
 */
export interface InstallSession {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresAtMs: number;
  intervalSeconds: number;
}

export interface ExchangeInstallParams {
  deviceCode: string;
  expiresAtMs: number;
  intervalSeconds: number;
}

/** Full credential returned to the installer exactly once after a successful exchange. */
export interface InstallCredential {
  apiKey: string;
  expiresAt: string;
  mcpUrl: string;
}

export type InstallFlowErrorCode =
  | 'denied'
  | 'expired'
  | 'invalid_response'
  | 'network_error';

export class InstallFlowError extends Error {
  constructor(
    readonly code: InstallFlowErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'InstallFlowError';
  }
}

interface DeviceFlowClientOptions {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  value: JsonRecord,
  key: string,
  errorMessage: string
): string {
  const result = value[key];
  if (typeof result !== 'string' || result.length === 0) {
    throw new InstallFlowError('invalid_response', errorMessage);
  }
  return result;
}

function readPositiveNumber(
  value: JsonRecord,
  key: string,
  fallback?: number
): number {
  const result = value[key] ?? fallback;
  if (typeof result !== 'number' || !Number.isFinite(result) || result <= 0) {
    throw new InstallFlowError(
      'invalid_response',
      `Pixapi returned an invalid ${key}.`
    );
  }
  return result;
}

async function readJson(response: Response): Promise<JsonRecord> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    // Do not include the raw response; it may contain stack traces or SQL details.
    throw new InstallFlowError(
      'invalid_response',
      'Pixapi returned an unreadable response.'
    );
  }
  if (!isRecord(value)) {
    throw new InstallFlowError(
      'invalid_response',
      'Pixapi returned an invalid response.'
    );
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  // Require HTTPS in production; allow HTTP only for localhost/127.0.0.1.
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Pixapi API URL must use HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}

function validateCredential(value: JsonRecord): InstallCredential {
  // Require an API key, expiration time, and MCP URL before persisting credentials.
  const apiKey = readString(
    value,
    'api_key',
    'Pixapi did not return an API key.'
  );
  if (!apiKey.startsWith('sk_')) {
    throw new InstallFlowError(
      'invalid_response',
      'Pixapi returned an invalid API key.'
    );
  }

  const expiresAt = readString(
    value,
    'expires_at',
    'Pixapi did not return the API key expiration time.'
  );
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new InstallFlowError(
      'invalid_response',
      'Pixapi returned an invalid API key expiration time.'
    );
  }

  const mcpUrl = readString(
    value,
    'mcp_url',
    'Pixapi did not return the MCP URL.'
  );
  const parsedMcpUrl = new URL(mcpUrl);
  if (parsedMcpUrl.protocol !== 'https:' && parsedMcpUrl.hostname !== 'localhost') {
    throw new InstallFlowError(
      'invalid_response',
      'Pixapi returned an invalid MCP URL.'
    );
  }

  return { apiKey, expiresAt, mcpUrl };
}

export class DeviceFlowClient {
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: DeviceFlowClientOptions) {
    this.apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Create a one-time install session that lasts about ten minutes.
   * This request is unauthenticated and must not send an existing API key.
   */
  async start(params: StartInstallParams): Promise<InstallSession> {
    let response: Response;
    try {
      // TODO(mcp-install-api): open the CLI install flow after the web start/exchange routes exist.
      response = await this.fetch(`${this.apiBaseUrl}/api/mcp/install/start`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_name: params.clientName,
          device_name: params.deviceName,
        }),
      });
    } catch {
      throw new InstallFlowError(
        'network_error',
        'Could not reach Pixapi. Check your connection and try again.'
      );
    }

    const body = await readJson(response);
    if (!response.ok) {
      throw new InstallFlowError(
        'invalid_response',
        'Pixapi could not start the authorization flow.'
      );
    }

    const expiresIn = readPositiveNumber(body, 'expires_in');
    const verificationUrl = readString(
      body,
      'verification_url',
      'Pixapi did not return a verification URL.'
    );

    return {
      deviceCode: readString(
        body,
        'device_code',
        'Pixapi did not return a device code.'
      ),
      userCode: readString(
        body,
        'user_code',
        'Pixapi did not return a user code.'
      ),
      verificationUrl,
      verificationUrlComplete:
        typeof body.verification_url_complete === 'string'
          ? body.verification_url_complete
          : verificationUrl,
      expiresAtMs: this.now() + expiresIn * 1_000,
      intervalSeconds: readPositiveNumber(body, 'interval', 3),
    };
  }

  /**
   * Poll the install session until the user confirms, denies, or it expires.
   * deviceCode stays in the HTTPS JSON body; it is never put in URLs, logs, or errors.
   */
  async exchange(params: ExchangeInstallParams): Promise<InstallCredential> {
    let intervalSeconds = params.intervalSeconds;

    while (this.now() < params.expiresAtMs) {
      let response: Response;
      try {
        response = await this.fetch(
          `${this.apiBaseUrl}/api/mcp/install/exchange`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ device_code: params.deviceCode }),
          }
        );
      } catch {
        throw new InstallFlowError(
          'network_error',
          'Could not reach Pixapi. Check your connection and try again.'
        );
      }

      const body = await readJson(response);
      const status = typeof body.status === 'string' ? body.status : '';

      if (response.ok && status === 'approved') {
        // The server issues the full key once; validate it, then hand it to private storage.
        return validateCredential(body);
      }
      if (response.status === 403 || status === 'denied') {
        throw new InstallFlowError(
          'denied',
          'Pixapi authorization was denied.'
        );
      }
      if (response.status === 410 || status === 'expired') {
        throw new InstallFlowError(
          'expired',
          'Pixapi authorization expired. Run init again.'
        );
      }
      if (
        response.status === 202 ||
        response.status === 429 ||
        status === 'pending' ||
        status === 'slow_down'
      ) {
        // Follow the server poll interval; increase it on slow_down or HTTP 429.
        const retryAfter = body.retry_after;
        if (
          typeof retryAfter === 'number' &&
          Number.isFinite(retryAfter) &&
          retryAfter > 0
        ) {
          intervalSeconds = Math.max(intervalSeconds, retryAfter);
        } else if (status === 'slow_down' || response.status === 429) {
          intervalSeconds += 2;
        }
        await this.sleep(intervalSeconds * 1_000);
        continue;
      }

      throw new InstallFlowError(
        'invalid_response',
        'Pixapi could not complete the authorization flow.'
      );
    }

    throw new InstallFlowError(
      'expired',
      'Pixapi authorization expired. Run init again.'
    );
  }
}
