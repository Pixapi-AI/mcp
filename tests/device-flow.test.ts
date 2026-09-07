import { describe, expect, it, vi } from 'vitest';

import {
  DeviceFlowClient,
  InstallFlowError,
  type InstallCredential,
} from '../src/device-flow.js';

describe('DeviceFlowClient', () => {
  it('starts an install session without sending an API key', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).not.toHaveProperty('authorization');
      return Response.json({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://pixapi.ai/mcp/install',
        verification_url_complete: 'https://pixapi.ai/mcp/install?code=ABCD-EFGH',
        expires_in: 600,
        interval: 2,
      });
    });
    const client = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: fetchMock,
    });

    const session = await client.start({
      clientName: 'claude-code',
      deviceName: 'Alvin Mac',
    });

    expect(session.userCode).toBe('ABCD-EFGH');
    expect(session.verificationUrlComplete).toContain('ABCD-EFGH');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pixapi.ai/api/mcp/install/start',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('polls pending sessions until the API key can be claimed once', async () => {
    const approved: InstallCredential = {
      apiKey: 'sk_test_credential',
      expiresAt: '2027-01-23T00:00:00.000Z',
      mcpUrl: 'https://api.pixapi.ai/mcp',
    };
    const responses = [
      new Response(JSON.stringify({ status: 'pending', retry_after: 1 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
      Response.json({
        status: 'approved',
        api_key: approved.apiKey,
        expires_at: approved.expiresAt,
        mcp_url: approved.mcpUrl,
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const sleep = vi.fn(async () => undefined);
    const client = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai/',
      fetch: fetchMock,
      sleep,
      now: () => 1_000,
    });

    const credential = await client.exchange({
      deviceCode: 'device-secret',
      expiresAtMs: 11_000,
      intervalSeconds: 1,
    });

    expect(credential).toEqual(approved);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('stops when the install session expires', async () => {
    const client = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: vi.fn(),
      now: () => 10_001,
    });

    await expect(
      client.exchange({
        deviceCode: 'device-secret',
        expiresAtMs: 10_000,
        intervalSeconds: 1,
      })
    ).rejects.toMatchObject({ code: 'expired' } satisfies Partial<InstallFlowError>);
  });

  it('does not expose server internals when the exchange is denied', async () => {
    const client = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: vi.fn(async () =>
        Response.json(
          { status: 'denied', detail: 'database row 42 rejected' },
          { status: 403 }
        )
      ),
      now: () => 1_000,
    });

    await expect(
      client.exchange({
        deviceCode: 'device-secret',
        expiresAtMs: 11_000,
        intervalSeconds: 1,
      })
    ).rejects.toMatchObject({
      code: 'denied',
      message: 'Pixapi authorization was denied.',
    } satisfies Partial<InstallFlowError>);
  });

  it('uses safe defaults when optional start fields are omitted', async () => {
    const client = new DeviceFlowClient({
      apiBaseUrl: 'http://127.0.0.1:3000/',
      fetch: vi.fn(async () =>
        Response.json({
          device_code: 'device-secret',
          user_code: 'ABCD-EFGH',
          verification_url: 'http://localhost:3000/mcp/install',
          expires_in: 600,
        })
      ),
      now: () => 1_000,
    });

    const session = await client.start({
      clientName: 'cursor',
      deviceName: 'Test',
    });

    expect(session.verificationUrlComplete).toBe(session.verificationUrl);
    expect(session.intervalSeconds).toBe(3);
    expect(session.expiresAtMs).toBe(601_000);
  });

  it('rejects insecure non-local API endpoints', () => {
    expect(
      () => new DeviceFlowClient({ apiBaseUrl: 'http://pixapi.example' })
    ).toThrow('must use HTTPS');
  });

  it('turns network and malformed start responses into actionable errors', async () => {
    const offline = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: vi.fn(async () => {
        throw new Error('socket detail');
      }),
    });
    await expect(
      offline.start({ clientName: 'cursor', deviceName: 'Test' })
    ).rejects.toMatchObject({ code: 'network_error' });

    const malformed = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: vi.fn(async () => new Response('not-json')),
    });
    await expect(
      malformed.start({ clientName: 'cursor', deviceName: 'Test' })
    ).rejects.toMatchObject({ code: 'invalid_response' });

    const rejected = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: vi.fn(async () =>
        Response.json({ error: 'rate limited' }, { status: 429 })
      ),
    });
    await expect(
      rejected.start({ clientName: 'cursor', deviceName: 'Test' })
    ).rejects.toMatchObject({
      message: 'Pixapi could not start the authorization flow.',
    });
  });

  it('rejects approved responses with invalid credential fields', async () => {
    const invalidResponses = [
      {
        status: 'approved',
        api_key: 'bad-key',
        expires_at: '2027-01-23T00:00:00.000Z',
        mcp_url: 'https://api.pixapi.ai/mcp',
      },
      {
        status: 'approved',
        api_key: 'sk_valid',
        expires_at: 'not-a-date',
        mcp_url: 'https://api.pixapi.ai/mcp',
      },
      {
        status: 'approved',
        api_key: 'sk_valid',
        expires_at: '2027-01-23T00:00:00.000Z',
        mcp_url: 'http://api.pixapi.ai/mcp',
      },
    ];

    for (const response of invalidResponses) {
      const client = new DeviceFlowClient({
        apiBaseUrl: 'https://pixapi.ai',
        fetch: vi.fn(async () => Response.json(response)),
        now: () => 1_000,
      });
      await expect(
        client.exchange({
          deviceCode: 'device-secret',
          expiresAtMs: 11_000,
          intervalSeconds: 1,
        })
      ).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('backs off on slow_down and rejects unknown exchange states', async () => {
    const sleep = vi.fn(async () => undefined);
    const responses = [
      new Response(JSON.stringify({ status: 'slow_down' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
      Response.json(
        { status: 'approved', api_key: 'sk_valid' },
        { status: 500 }
      ),
    ];
    const client = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: vi.fn(async () => responses.shift()!),
      sleep,
      now: () => 1_000,
    });

    await expect(
      client.exchange({
        deviceCode: 'device-secret',
        expiresAtMs: 11_000,
        intervalSeconds: 1,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it('handles explicit server expiration and exchange network failures', async () => {
    const expired = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: vi.fn(async () =>
        Response.json({ status: 'expired' }, { status: 410 })
      ),
      now: () => 1_000,
    });
    await expect(
      expired.exchange({
        deviceCode: 'device-secret',
        expiresAtMs: 11_000,
        intervalSeconds: 1,
      })
    ).rejects.toMatchObject({ code: 'expired' });

    const offline = new DeviceFlowClient({
      apiBaseUrl: 'https://pixapi.ai',
      fetch: vi.fn(async () => {
        throw new Error('socket detail');
      }),
      now: () => 1_000,
    });
    await expect(
      offline.exchange({
        deviceCode: 'device-secret',
        expiresAtMs: 11_000,
        intervalSeconds: 1,
      })
    ).rejects.toMatchObject({ code: 'network_error' });
  });
});
