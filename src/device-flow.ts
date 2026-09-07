/** 发起安装授权时用于标识客户端和设备，最终会显示在用户的凭证管理页。 */
export interface StartInstallParams {
  clientName: string;
  deviceName: string;
}

/**
 * start 接口返回的一次性安装会话。
 * deviceCode 是高熵领取凭证，不能输出到终端；userCode 才是给用户看的短码。
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

/** exchange 成功后唯一一次返回给安装器的完整凭证。 */
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
    // 不拼接原始响应，避免服务端堆栈、SQL 信息等内部细节出现在终端。
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
  // 生产环境强制 HTTPS；仅允许 localhost/127.0.0.1 使用 HTTP 进行本地联调。
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Pixapi API URL must use HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}

function validateCredential(value: JsonRecord): InstallCredential {
  // API Key、过期时间和 MCP 地址缺一不可，防止把不完整凭证落盘。
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
   * 创建十分钟左右的一次性安装会话。
   * 此请求尚未登录，因此绝不能携带已有 API Key 或其他本地凭证。
   */
  async start(params: StartInstallParams): Promise<InstallSession> {
    let response: Response;
    try {
      // TODO(mcp-install-api): 在 Web 端实现 start/exchange 路由后再开放 CLI 安装流程。
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
   * 轮询安装会话，直到用户确认、拒绝或会话过期。
   * deviceCode 只放在 HTTPS JSON body 中，不进入 URL、日志或错误信息。
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
        // 服务端保证完整 key 只能领取一次；客户端验证后立即交给私有凭证存储。
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
        // 遵循服务端返回的轮询节奏；收到 slow_down/429 时主动增加间隔。
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
