import { describe, expect, it } from 'vitest';
import { countTokens } from '../src/tokenize.js';

describe('countTokens', () => {
  it('counts a short known string', () => {
    expect(countTokens('hello world')).toBe(2);
  });

  it('counts more tokens for longer text', () => {
    expect(countTokens('a'.repeat(1000))).toBeGreaterThan(countTokens('a'));
  });

  it('returns 0 for an empty string', () => {
    expect(countTokens('')).toBe(0);
  });
});
