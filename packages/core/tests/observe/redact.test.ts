import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  redactHeaders,
  redactRecording,
  redactRequest,
  redactUrl,
} from '../../src/observe/redact.js';
import {
  RECORDING_BODY_CAP_BYTES,
  RECORDING_TOTAL_BODY_CAP_BYTES,
  type RecordedRequest,
  type Recording,
} from '../../src/observe/types.js';

function request(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    at: 12,
    method: 'GET',
    url: 'https://api.example.com/cart',
    status: 200,
    resourceType: 'xhr',
    requestHeaders: {},
    responseHeaders: {},
    durationMs: 34,
    transferSizeBytes: 512,
    body: { kept: false, reason: 'binary-type' },
    ...overrides,
  };
}

describe('redactHeaders', () => {
  it('replaces the three headers the threat model names outright', () => {
    const redacted = redactHeaders({
      Authorization: 'Bearer eyJhbGciOi.live.token',
      Cookie: 'sid=abc123',
      'Set-Cookie': 'sid=abc123; HttpOnly',
      'Content-Type': 'application/json',
    });

    expect(redacted).toEqual({
      Authorization: REDACTED,
      Cookie: REDACTED,
      'Set-Cookie': REDACTED,
      'Content-Type': 'application/json',
    });
  });

  it('matches header names case-insensitively, as HTTP does', () => {
    expect(redactHeaders({ authorization: 'Bearer x' }).authorization).toBe(
      REDACTED,
    );
    expect(redactHeaders({ COOKIE: 'sid=1' }).COOKIE).toBe(REDACTED);
  });

  it('covers the common token headers, not only the RFC ones', () => {
    const redacted = redactHeaders({
      'X-Api-Key': 'k-123',
      'x-auth-token': 't-123',
      'X-CSRF-Token': 'c-123',
      'Proxy-Authorization': 'Basic abc',
      'X-Amz-Security-Token': 'a-123',
    });

    for (const value of Object.values(redacted)) expect(value).toBe(REDACTED);
  });

  it('leaves an innocuous header whose name merely looks similar alone', () => {
    const redacted = redactHeaders({
      'X-Author': 'alice',
      Accept: 'application/json',
      'Content-Length': '12',
    });

    expect(redacted).toEqual({
      'X-Author': 'alice',
      Accept: 'application/json',
      'Content-Length': '12',
    });
  });

  it('returns a fresh object rather than mutating the input', () => {
    const headers = { Authorization: 'Bearer x' };
    const redacted = redactHeaders(headers);

    expect(headers.Authorization).toBe('Bearer x');
    expect(redacted).not.toBe(headers);
  });
});

describe('redactUrl', () => {
  it('redacts a token-bearing query parameter — the case most often missed', () => {
    expect(
      redactUrl('https://api.example.com/v1/me?access_token=live-secret'),
    ).toBe(`https://api.example.com/v1/me?access_token=${REDACTED}`);
  });

  it('keeps every other parameter, and their order, intact', () => {
    expect(
      redactUrl('https://x.test/s?q=shoes&token=abc&page=2&sort=price'),
    ).toBe(`https://x.test/s?q=shoes&token=${REDACTED}&page=2&sort=price`);
  });

  it('covers the parameter names an API actually uses', () => {
    for (const name of [
      'token',
      'access_token',
      'refresh_token',
      'id_token',
      'api_key',
      'apikey',
      'key',
      'auth',
      'signature',
      'sig',
      'password',
      'client_secret',
      'session',
      'sessionid',
      'code',
      'jwt',
    ]) {
      expect(redactUrl(`https://x.test/a?${name}=secret`), name).toBe(
        `https://x.test/a?${name}=${REDACTED}`,
      );
    }
  });

  it('matches parameter names case- and separator-insensitively', () => {
    expect(redactUrl('https://x.test/a?AccessToken=s')).toBe(
      `https://x.test/a?AccessToken=${REDACTED}`,
    );
    expect(redactUrl('https://x.test/a?access-token=s')).toBe(
      `https://x.test/a?access-token=${REDACTED}`,
    );
  });

  it('leaves a parameter that only shares a substring alone', () => {
    expect(redactUrl('https://x.test/a?author=alice&keyword=shoes')).toBe(
      'https://x.test/a?author=alice&keyword=shoes',
    );
  });

  it('strips url userinfo, which is a credential in the url itself', () => {
    expect(redactUrl('https://user:pw@x.test/a')).toBe(
      `https://${REDACTED}@x.test/a`,
    );
  });

  it('leaves the fragment and path untouched', () => {
    expect(redactUrl('https://x.test/token/list#token')).toBe(
      'https://x.test/token/list#token',
    );
  });

  it('returns an unparseable url unchanged rather than throwing', () => {
    expect(redactUrl('not a url ?token=x')).toBe('not a url ?token=x');
  });
});

describe('redactRequest', () => {
  it('redacts headers on both sides and the url together', () => {
    const redacted = redactRequest(
      request({
        url: 'https://api.example.com/cart?token=live',
        requestHeaders: { Authorization: 'Bearer live', Accept: '*/*' },
        responseHeaders: { 'Set-Cookie': 'sid=1', Server: 'nginx' },
      }),
    );

    expect(redacted.url).toBe(`https://api.example.com/cart?token=${REDACTED}`);
    expect(redacted.requestHeaders).toEqual({
      Authorization: REDACTED,
      Accept: '*/*',
    });
    expect(redacted.responseHeaders).toEqual({
      'Set-Cookie': REDACTED,
      Server: 'nginx',
    });
  });

  it('leaves the metadata a caller reasons about untouched', () => {
    const original = request({ status: 302, transferSizeBytes: null });
    const redacted = redactRequest(original);

    expect(redacted.method).toBe('GET');
    expect(redacted.status).toBe(302);
    expect(redacted.resourceType).toBe('xhr');
    expect(redacted.durationMs).toBe(34);
    expect(redacted.transferSizeBytes).toBeNull();
    expect(redacted.at).toBe(12);
  });

  it('carries a skipped body through with its reason', () => {
    const redacted = redactRequest(
      request({ body: { kept: false, reason: 'evicted' } }),
    );
    expect(redacted.body).toEqual({ kept: false, reason: 'evicted' });
  });

  it('redacts a credential inside a kept body', () => {
    const redacted = redactRequest(
      request({
        body: {
          kept: true,
          bytes: 40,
          text: '{"access_token":"live-secret","id":7}',
        },
      }),
    );

    expect(redacted.body.kept).toBe(true);
    if (redacted.body.kept) {
      expect(redacted.body.text).not.toContain('live-secret');
      expect(redacted.body.text).toContain(REDACTED);
      expect(redacted.body.text).toContain('"id":7');
      // Byte count still describes what policy accounted for, not the
      // shorter redacted text — the caps were spent on the original.
      expect(redacted.body.bytes).toBe(40);
    }
  });
});

describe('redactRecording', () => {
  it('redacts every request and records that it happened', () => {
    const recording: Recording = {
      startedAt: '2026-08-31T10:00:00.000Z',
      redacted: false,
      bodyBytes: 0,
      requests: [
        request({ requestHeaders: { Cookie: 'sid=1' } }),
        request({ url: 'https://x.test/a?api_key=live' }),
      ],
    };

    const redacted = redactRecording(recording);

    expect(redacted.redacted).toBe(true);
    expect(redacted.requests[0]?.requestHeaders.Cookie).toBe(REDACTED);
    expect(redacted.requests[1]?.url).toBe(
      `https://x.test/a?api_key=${REDACTED}`,
    );
    // The input is untouched: this is a pure function the host calls on the
    // way to disk, not an in-place scrubber.
    expect(recording.redacted).toBe(false);
    expect(recording.requests[0]?.requestHeaders.Cookie).toBe('sid=1');
  });

  it('preserves the storage bookkeeping the caps depend on', () => {
    const redacted = redactRecording({
      startedAt: '2026-08-31T10:00:00.000Z',
      redacted: false,
      bodyBytes: 4096,
      requests: [],
    });

    expect(redacted.bodyBytes).toBe(4096);
    expect(redacted.startedAt).toBe('2026-08-31T10:00:00.000Z');
  });
});

describe('recording caps', () => {
  /** The constants are policy three collectors will implement against, so
   * their relationship — not just their presence — is asserted here. */
  it('names a per-body cap below the per-session total', () => {
    expect(RECORDING_BODY_CAP_BYTES).toBeGreaterThan(0);
    expect(RECORDING_TOTAL_BODY_CAP_BYTES).toBeGreaterThan(
      RECORDING_BODY_CAP_BYTES,
    );
  });

  it('keeps the session total at the 2 MB the spec prints', () => {
    expect(RECORDING_TOTAL_BODY_CAP_BYTES).toBe(2 * 1024 * 1024);
  });
});
