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
      // The two cookie headers keep their structure and lose their values —
      // see the cookie suite below for why the metadata is not a secret.
      Cookie: `sid=${REDACTED}`,
      'Set-Cookie': `sid=${REDACTED}; HttpOnly`,
      'Content-Type': 'application/json',
    });
    for (const value of Object.values(redacted)) {
      expect(value).not.toContain('abc123');
    }
  });

  it('matches header names case-insensitively, as HTTP does', () => {
    expect(redactHeaders({ authorization: 'Bearer x' }).authorization).toBe(
      REDACTED,
    );
    expect(redactHeaders({ COOKIE: 'sid=1' }).COOKIE).toBe(`sid=${REDACTED}`);
    expect(redactHeaders({ 'SET-COOKIE': 'sid=1' })['SET-COOKIE']).toBe(
      `sid=${REDACTED}`,
    );
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

/**
 * The cookie headers are the one family where blanket redaction is safe and
 * useless: the value is the credential, and everything around it is the
 * inventory `stack` reports. These cases pin both halves — the secret is gone,
 * the metadata is intact — and pin the direction the parser errs in when it
 * cannot tell which is which.
 */
describe('redactHeaders — cookies', () => {
  const setCookie = (value: string): string =>
    redactHeaders({ 'Set-Cookie': value })['Set-Cookie']!;
  const cookie = (value: string): string =>
    redactHeaders({ Cookie: value }).Cookie!;

  describe('Set-Cookie keeps its metadata and loses its value', () => {
    it('redacts the value and preserves every attribute', () => {
      const redacted = setCookie(
        'session=abc123; Domain=.shop.example; Path=/; HttpOnly; SameSite=Lax',
      );

      expect(redacted).toBe(
        `session=${REDACTED}; Domain=.shop.example; Path=/; HttpOnly; SameSite=Lax`,
      );
      // Stated separately from the equality above because it is the whole
      // point: the inventory is readable and the credential is not.
      expect(redacted).not.toContain('abc123');
      expect(redacted).toContain('session=');
      expect(redacted).toContain('HttpOnly');
    });

    it('redacts a cookie with no attributes at all', () => {
      expect(setCookie('sid=s%3AZ9y.live')).toBe(`sid=${REDACTED}`);
    });

    it('redacts a value containing = rather than keeping half of it', () => {
      // Base64 padding and signed cookies both put `=` inside the value; the
      // first `=` is the delimiter and everything after it is the secret.
      const redacted = setCookie('jwt=aGVsbG8=.sig=9f2; Path=/');

      expect(redacted).toBe(`jwt=${REDACTED}; Path=/`);
      expect(redacted).not.toContain('aGVsbG8');
      expect(redacted).not.toContain('9f2');
    });

    it('keeps the quotes of a quoted value, which are syntax not secret', () => {
      const redacted = setCookie('pref="a1b2c3"; Path=/; Secure');

      expect(redacted).toBe(`pref="${REDACTED}"; Path=/; Secure`);
      expect(redacted).not.toContain('a1b2c3');
    });

    it('leaves an empty value empty, because a deletion is not a secret', () => {
      // `name=;` with a past expiry is how a server deletes a cookie. Writing
      // a marker in would fabricate a value and hide the deletion.
      expect(setCookie('sid=; Path=/; Max-Age=0')).toBe(
        'sid=; Path=/; Max-Age=0',
      );
    });

    it('preserves Max-Age and an Expires date with its comma intact', () => {
      expect(
        setCookie('_ga=GA1.1.9; Domain=.example.com; Max-Age=63072000'),
      ).toBe(`_ga=${REDACTED}; Domain=.example.com; Max-Age=63072000`);
      // The date's own comma is why Set-Cookie cannot be comma-split; the
      // attribute tail is copied through byte-for-byte.
      expect(
        setCookie('sid=x; Expires=Wed, 09 Sep 2026 10:00:00 GMT; HttpOnly'),
      ).toBe(
        `sid=${REDACTED}; Expires=Wed, 09 Sep 2026 10:00:00 GMT; HttpOnly`,
      );
    });

    it('handles repeated Set-Cookie headers collapsed onto separate lines', () => {
      const redacted = setCookie('a=1; Path=/\nb=2; HttpOnly');

      expect(redacted).toBe(`a=${REDACTED}; Path=/\nb=${REDACTED}; HttpOnly`);
    });

    it('fails closed on a malformed header rather than leaking it', () => {
      // No assignment to find, so nothing here can be named safely.
      expect(setCookie('justatokenstring')).toBe(REDACTED);
      expect(setCookie('opaque-blob; Path=/')).toBe(REDACTED);
      // An empty name would publish the value under a name we invented.
      expect(setCookie('=abc123; Path=/')).toBe(REDACTED);
      expect(setCookie('   =abc123')).toBe(REDACTED);
      for (const malformed of [
        'justatokenstring',
        'opaque-blob; Path=/',
        '=abc123; Path=/',
      ]) {
        expect(setCookie(malformed)).not.toContain('abc123');
      }
    });

    it('costs only the line it cannot parse when others are fine', () => {
      const redacted = setCookie('opaque-blob\nsid=live; HttpOnly');

      expect(redacted).toBe(`${REDACTED}\nsid=${REDACTED}; HttpOnly`);
    });

    it('is idempotent, so a re-redacted recording is unchanged', () => {
      const once = setCookie('sid=live; Path=/; HttpOnly');
      expect(setCookie(once)).toBe(once);
    });
  });

  describe('Cookie keeps its names and loses its values', () => {
    it('preserves every name and redacts every value', () => {
      const redacted = cookie('sid=abc123; _ga=GA1.1.99; consent=yes');

      expect(redacted).toBe(
        `sid=${REDACTED}; _ga=${REDACTED}; consent=${REDACTED}`,
      );
      expect(redacted).not.toContain('abc123');
      expect(redacted).not.toContain('GA1.1.99');
    });

    it('redacts a lone pair and a value containing =', () => {
      expect(cookie('sid=abc')).toBe(`sid=${REDACTED}`);
      expect(cookie('jwt=aGVsbG8=')).toBe(`jwt=${REDACTED}`);
    });

    it('passes a trailing separator through without failing the header', () => {
      expect(cookie('sid=abc; ')).toBe(`sid=${REDACTED}; `);
    });

    it('fails closed on the whole header when a segment has no assignment', () => {
      // One unnameable segment means we cannot trust the split anywhere in
      // this header, and a Cookie header has no attributes to explain it.
      const redacted = cookie('sid=abc123; opaquevalue; _ga=GA1.1.99');

      expect(redacted).toBe(REDACTED);
      expect(redacted).not.toContain('abc123');
      expect(redacted).not.toContain('GA1.1.99');
    });

    it('is idempotent, so a re-redacted recording is unchanged', () => {
      const once = cookie('sid=live; _ga=GA1.1.9');
      expect(cookie(once)).toBe(once);
    });
  });

  it('gives a header that merely contains "cookie" no structural treatment', () => {
    // `X-Cookie-Hash` is not a cookie header; it stays on the blanket path.
    expect(redactHeaders({ 'X-Cookie-Hash': 'a=b' })['X-Cookie-Hash']).toBe(
      REDACTED,
    );
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
        responseHeaders: { 'Set-Cookie': 'sid=1; HttpOnly', Server: 'nginx' },
      }),
    );

    expect(redacted.url).toBe(`https://api.example.com/cart?token=${REDACTED}`);
    expect(redacted.requestHeaders).toEqual({
      Authorization: REDACTED,
      Accept: '*/*',
    });
    expect(redacted.responseHeaders).toEqual({
      'Set-Cookie': `sid=${REDACTED}; HttpOnly`,
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
    expect(redacted.requests[0]?.requestHeaders.Cookie).toBe(`sid=${REDACTED}`);
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
