import { describe, expect, it } from 'vitest';
import { formatSize } from '../src/popup/lib/format-size.js';

describe('formatSize', () => {
  it('rounds to whole KB below 1 MB', () => {
    expect(formatSize(2048)).toBe('2 KB');
  });

  it('switches to MB with one decimal at 1 MB and above', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('rounds a fraction of a KB up to 1 KB rather than 0', () => {
    expect(formatSize(600)).toBe('1 KB');
  });
});
