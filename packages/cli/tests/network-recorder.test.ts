import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  RECORDING_BODY_CAP_BYTES,
  RECORDING_TOTAL_BODY_CAP_BYTES,
} from 'quick-caps-core/observe';
import {
  attachNetworkRecorder,
  type RecordablePage,
  type RecordableRequest,
  type RecordableResponse,
} from '../src/drivers/playwright-driver.js';

/**
 * The recorder is driven through the same kind of seam PageDriver/FakeDriver
 * established: it reads a narrow slice of Playwright's Response/Request, so
 * every policy decision (content type, per-body cap, total cap, eviction,
 * skip reasons, redaction) is testable without a browser. The one real-browser
 * assertion — that `response` events fire at all — lives in
 * playwright-driver.test.ts, where a chromium instance already exists.
 */

type FakeInit = {
  url?: string;
  status?: number;
  method?: string;
  resourceType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  body?: string;
  /** Simulates a stream already consumed or a request aborted mid-read. */
  bodyError?: string;
  /** Resolves the body only when this is called, so out-of-order completion
   * is expressible. */
  defer?: boolean;
};

type FakeResponse = RecordableResponse & { release: () => void };

function fakeRequest(init: FakeInit): RecordableRequest {
  return {
    method: () => init.method ?? 'GET',
    url: () => init.url ?? 'https://api.example/thing',
    resourceType: () => init.resourceType ?? 'fetch',
    headers: () => ({ ...init.requestHeaders }),
    timing: () => ({ startTime: 1_000, responseEnd: 42 }),
  };
}

function fakeResponse(init: FakeInit = {}): FakeResponse {
  const body = init.body ?? '{}';
  let release = (): void => {};
  const gate =
    init.defer === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();

  return {
    url: () => init.url ?? 'https://api.example/thing',
    status: () => init.status ?? 200,
    headers: () => ({
      'content-type': 'application/json',
      ...init.responseHeaders,
    }),
    request: () => fakeRequest(init),
    body: async () => {
      await gate;
      if (init.bodyError !== undefined) throw new Error(init.bodyError);
      return new TextEncoder().encode(body);
    },
    release: () => release(),
  };
}

/** Two overloads so a real Playwright Page and this fake satisfy the same
 * type; the implementation signature is what actually stores the handler. */
class FakePage implements RecordablePage {
  private readonly responses: ((r: RecordableResponse) => unknown)[] = [];
  private readonly failures: ((r: RecordableRequest) => unknown)[] = [];

  on(event: 'response', handler: (r: RecordableResponse) => unknown): void;
  on(event: 'requestfailed', handler: (r: RecordableRequest) => unknown): void;
  on(
    event: 'response' | 'requestfailed',
    handler: (arg: never) => unknown,
  ): void {
    if (event === 'response') {
      this.responses.push(handler as (r: RecordableResponse) => unknown);
    } else {
      this.failures.push(handler as (r: RecordableRequest) => unknown);
    }
  }

  emitResponse(response: RecordableResponse): void {
    for (const handler of this.responses) handler(response);
  }

  emitRequestFailed(request: RecordableRequest): void {
    for (const handler of this.failures) handler(request);
  }
}

function armed(opts: { redact?: boolean } = {}) {
  const page = new FakePage();
  const recorder = attachNetworkRecorder(page, {
    redact: opts.redact !== false,
  });
  return { page, recorder };
}

describe('network recorder — metadata', () => {
  it('records metadata for every request, whatever happens to the body', async () => {
    const { page, recorder } = armed();
    page.emitResponse(
      fakeResponse({
        url: 'https://api.example/cart',
        method: 'POST',
        status: 201,
        resourceType: 'xhr',
        requestHeaders: { accept: 'application/json' },
        responseHeaders: {
          'content-type': 'image/png',
          'content-length': '9',
        },
      }),
    );

    const recording = await recorder.finish();
    expect(recording.requests).toHaveLength(1);
    const request = recording.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example/cart');
    expect(request.status).toBe(201);
    expect(request.resourceType).toBe('xhr');
    expect(request.requestHeaders['accept']).toBe('application/json');
    expect(request.responseHeaders['content-type']).toBe('image/png');
    expect(request.durationMs).toBe(42);
    expect(request.transferSizeBytes).toBe(9);
    expect(request.at).toBeGreaterThanOrEqual(0);
    expect(recording.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps requests in the order they were observed even when bodies settle out of order', async () => {
    const { page, recorder } = armed();
    const first = fakeResponse({ url: 'https://api.example/1', defer: true });
    const second = fakeResponse({ url: 'https://api.example/2' });
    page.emitResponse(first);
    page.emitResponse(second);
    // Second body resolves first; the first is released only afterwards.
    first.release();

    const recording = await recorder.finish();
    expect(recording.requests.map((r) => r.url)).toEqual([
      'https://api.example/1',
      'https://api.example/2',
    ]);
  });

  it('records an aborted request as a request with no response', async () => {
    const { page, recorder } = armed();
    page.emitRequestFailed(
      fakeRequest({ url: 'https://api.example/aborted', method: 'GET' }),
    );

    const recording = await recorder.finish();
    const request = recording.requests[0]!;
    expect(request.status).toBeNull();
    expect(request.durationMs).toBeNull();
    expect(request.body).toEqual({ kept: false, reason: 'unreadable' });
  });
});

describe('network recorder — body policy', () => {
  it('keeps a text-ish body', async () => {
    const { page, recorder } = armed();
    page.emitResponse(fakeResponse({ body: '{"items":3}' }));

    const recording = await recorder.finish();
    expect(recording.requests[0]!.body).toEqual({
      kept: true,
      text: '{"items":3}',
      bytes: 11,
    });
    expect(recording.bodyBytes).toBe(11);
  });

  it('keeps bodies for content types carrying parameters and vendor suffixes', async () => {
    const { page, recorder } = armed();
    for (const contentType of [
      'application/json; charset=utf-8',
      'text/html;charset=UTF-8',
      'application/xml',
    ]) {
      page.emitResponse(
        fakeResponse({ responseHeaders: { 'content-type': contentType } }),
      );
    }

    const recording = await recorder.finish();
    expect(recording.requests.map((r) => r.body.kept)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('skips a binary body with the reason, and the observed size', async () => {
    const { page, recorder } = armed();
    page.emitResponse(
      fakeResponse({
        responseHeaders: {
          'content-type': 'image/png',
          'content-length': '4096',
        },
      }),
    );

    const recording = await recorder.finish();
    expect(recording.requests[0]!.body).toEqual({
      kept: false,
      reason: 'binary-type',
      bytes: 4096,
    });
    expect(recording.bodyBytes).toBe(0);
  });

  it('skips a body over the per-body cap, recording the size it would have cost', async () => {
    const { page, recorder } = armed();
    const oversize = 'x'.repeat(RECORDING_BODY_CAP_BYTES + 1);
    page.emitResponse(fakeResponse({ body: oversize }));

    const recording = await recorder.finish();
    expect(recording.requests[0]!.body).toEqual({
      kept: false,
      reason: 'over-cap',
      bytes: RECORDING_BODY_CAP_BYTES + 1,
    });
    expect(recording.bodyBytes).toBe(0);
  });

  it('keeps a body exactly at the per-body cap', async () => {
    const { page, recorder } = armed();
    page.emitResponse(
      fakeResponse({ body: 'x'.repeat(RECORDING_BODY_CAP_BYTES) }),
    );

    const recording = await recorder.finish();
    expect(recording.requests[0]!.body.kept).toBe(true);
  });

  it('records an unreadable body as skipped rather than failing the recording', async () => {
    const { page, recorder } = armed();
    page.emitResponse(
      fakeResponse({ bodyError: 'Response body is unavailable' }),
    );

    const recording = await recorder.finish();
    expect(recording.requests[0]!.body).toEqual({
      kept: false,
      reason: 'unreadable',
    });
  });
});

describe('network recorder — total cap and eviction', () => {
  it('evicts oldest bodies first and keeps the total under the session cap', async () => {
    const { page, recorder } = armed();
    // Twelve 250 kB bodies is ~3 MB of traffic against a 2 MB cap: each body
    // is under the per-body cap, so only the total cap can bound this.
    const bodySize = 250 * 1024;
    const count = 12;
    for (let i = 0; i < count; i += 1) {
      page.emitResponse(
        fakeResponse({
          url: `https://api.example/page/${i}`,
          body: 'x'.repeat(bodySize),
        }),
      );
    }

    const recording = await recorder.finish();
    expect(recording.requests).toHaveLength(count);
    expect(recording.bodyBytes).toBeLessThanOrEqual(
      RECORDING_TOTAL_BODY_CAP_BYTES,
    );

    const kept = recording.requests.filter((r) => r.body.kept);
    const evicted = recording.requests.filter(
      (r) => !r.body.kept && r.body.reason === 'evicted',
    );
    expect(evicted.length).toBeGreaterThan(0);
    expect(kept.length + evicted.length).toBe(count);
    // Oldest first: every evicted request precedes every kept one.
    const lastEvicted = recording.requests.reduce(
      (last, r, index) =>
        !r.body.kept && r.body.reason === 'evicted' ? index : last,
      -1,
    );
    const firstKept = recording.requests.findIndex((r) => r.body.kept);
    expect(lastEvicted).toBeLessThan(firstKept);

    // bodyBytes is the accounting the cap is enforced against, so it has to
    // equal what is actually still on the record.
    const keptBytes = kept.reduce(
      (sum, r) => sum + (r.body.kept ? r.body.bytes : 0),
      0,
    );
    expect(recording.bodyBytes).toBe(keptBytes);

    // An evicted body still says what it cost, and the serialized recording
    // stays within the cap plus metadata rather than growing with traffic.
    for (const request of evicted) {
      expect(request.body.kept === false && request.body.bytes).toBe(bodySize);
    }
    expect(JSON.stringify(recording).length).toBeLessThan(
      RECORDING_TOTAL_BODY_CAP_BYTES + 64 * 1024,
    );
  });
});

describe('network recorder — redaction', () => {
  const secretUrl = 'https://api.example/me?token=super-secret-token&page=2';
  const secretHeaders = {
    authorization: 'Bearer super-secret-token',
    cookie: 'session=super-secret-token',
    accept: 'application/json',
  };

  it('redacts headers, query parameters, and body credentials by default', async () => {
    const { page, recorder } = armed();
    page.emitResponse(
      fakeResponse({
        url: secretUrl,
        requestHeaders: secretHeaders,
        responseHeaders: {
          'content-type': 'application/json',
          'set-cookie': 'session=super-secret-token',
        },
        body: '{"access_token":"super-secret-token","name":"ada"}',
      }),
    );

    const recording = await recorder.finish();
    expect(recording.redacted).toBe(true);
    // The whole security property, asserted the way it matters: the secret is
    // absent from the serialized recording — which is exactly what the session
    // write receives.
    expect(JSON.stringify(recording)).not.toContain('super-secret-token');

    const request = recording.requests[0]!;
    expect(request.url).toContain(`token=${REDACTED}`);
    expect(request.url).toContain('page=2');
    expect(request.requestHeaders['authorization']).toBe(REDACTED);
    expect(request.requestHeaders['cookie']).toBe(REDACTED);
    expect(request.requestHeaders['accept']).toBe('application/json');
    expect(request.responseHeaders['set-cookie']).toBe(REDACTED);
    expect(request.body.kept === true && request.body.text).toContain('ada');
  });

  it('redacts metadata at ingest, before any body has been read', async () => {
    // The recording is already safe while the body read is still pending, so
    // there is no window in which an unredacted request exists anywhere a
    // writer could reach — redaction is not a step on the way to disk.
    const { page, recorder } = armed();
    const pending = fakeResponse({
      url: secretUrl,
      requestHeaders: secretHeaders,
      defer: true,
    });
    page.emitResponse(pending);

    const inFlight = recorder.snapshot();
    expect(JSON.stringify(inFlight)).not.toContain('super-secret-token');
    expect(inFlight.requests[0]!.body.kept).toBe(false);

    pending.release();
    await recorder.finish();
  });

  it('charges the caps for the body as observed, not as redacted', async () => {
    const { page, recorder } = armed();
    const body = '{"access_token":"super-secret-token"}';
    page.emitResponse(fakeResponse({ body }));

    const recording = await recorder.finish();
    expect(recording.bodyBytes).toBe(body.length);
    expect(
      recording.requests[0]!.body.kept === true &&
        recording.requests[0]!.body.bytes,
    ).toBe(body.length);
  });

  it('round-trips credentials when redaction is explicitly off', async () => {
    const { page, recorder } = armed({ redact: false });
    page.emitResponse(
      fakeResponse({
        url: secretUrl,
        requestHeaders: secretHeaders,
        body: '{"access_token":"super-secret-token"}',
      }),
    );

    const recording = await recorder.finish();
    expect(recording.redacted).toBe(false);
    const request = recording.requests[0]!;
    expect(request.url).toBe(secretUrl);
    expect(request.requestHeaders['authorization']).toBe(
      'Bearer super-secret-token',
    );
    expect(request.body.kept === true && request.body.text).toContain(
      'super-secret-token',
    );
  });
});

describe('network recorder — degradation', () => {
  it('drops an observation it cannot even describe rather than throwing at the emitter', async () => {
    const { page, recorder } = armed();
    const hostile = {
      url: () => {
        throw new Error('page closed');
      },
    } as unknown as RecordableResponse;

    expect(() => page.emitResponse(hostile)).not.toThrow();
    page.emitResponse(fakeResponse({ url: 'https://api.example/ok' }));

    const recording = await recorder.finish();
    expect(recording.requests.map((r) => r.url)).toEqual([
      'https://api.example/ok',
    ]);
  });
});
