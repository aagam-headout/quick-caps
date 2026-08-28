import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  openInputSchema,
  doInputSchema,
  readInputSchema,
  findInputSchema,
  nextInputSchema,
  layoutInputSchema,
  tokensInputSchema,
  scrapeInputSchema,
  captureInputSchema,
} from '../../src/mcp/schemas.js';

describe('open schema', () => {
  it('requires a url, static is optional', () => {
    expect(z.object(openInputSchema).parse({ url: 'https://example.com' })).toEqual({
      url: 'https://example.com',
    });
    expect(() => z.object(openInputSchema).parse({})).toThrow();
  });
});

describe('do schema', () => {
  it('requires an integer handle, value optional', () => {
    expect(z.object(doInputSchema).parse({ handle: 3 })).toEqual({ handle: 3 });
    expect(z.object(doInputSchema).parse({ handle: 3, value: 'x' })).toEqual({
      handle: 3,
      value: 'x',
    });
    expect(() => z.object(doInputSchema).parse({ handle: 1.5 })).toThrow();
  });
});

describe('read schema', () => {
  it('requires an integer handle', () => {
    expect(z.object(readInputSchema).parse({ handle: 2 })).toEqual({ handle: 2 });
    expect(() => z.object(readInputSchema).parse({})).toThrow();
  });
});

describe('find schema', () => {
  it('requires a non-empty query', () => {
    expect(z.object(findInputSchema).parse({ query: 'x' })).toEqual({ query: 'x' });
    expect(() => z.object(findInputSchema).parse({ query: '' })).toThrow();
  });
});

describe('empty schemas', () => {
  it('next/layout/tokens accept no fields', () => {
    expect(z.object(nextInputSchema).parse({})).toEqual({});
    expect(z.object(layoutInputSchema).parse({})).toEqual({});
    expect(z.object(tokensInputSchema).parse({})).toEqual({});
  });
});

describe('scrape schema', () => {
  it('requires a shape string', () => {
    expect(z.object(scrapeInputSchema).parse({ shape: '{"title":"h1"}' })).toEqual({
      shape: '{"title":"h1"}',
    });
    expect(() => z.object(scrapeInputSchema).parse({})).toThrow();
  });
});

describe('capture schema', () => {
  it('zip and outDir are both optional', () => {
    expect(z.object(captureInputSchema).parse({})).toEqual({});
    expect(z.object(captureInputSchema).parse({ zip: true, outDir: '/tmp/x' })).toEqual({
      zip: true,
      outDir: '/tmp/x',
    });
  });
});
