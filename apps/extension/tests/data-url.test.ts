import { describe, expect, it } from 'vitest';
import { bytesToDataUrl } from '../src/lib/data-url.js';

describe('bytesToDataUrl', () => {
  it('encodes bytes with the given mime type', () => {
    const url = bytesToDataUrl(new Uint8Array([137, 80, 78, 71]), 'image/png');
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('round-trips through decoding back to the original bytes', () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const url = bytesToDataUrl(original, 'image/png');
    const base64 = url.split(',')[1]!;
    const decoded = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(original);
  });

  it('handles an array larger than one chunk', () => {
    const original = new Uint8Array(0x8000 * 2 + 10).map((_, i) => i % 256);
    const url = bytesToDataUrl(original, 'image/png');
    const base64 = url.split(',')[1]!;
    const decoded = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(original);
  });

  it('handles an empty array', () => {
    expect(bytesToDataUrl(new Uint8Array(0), 'image/png')).toBe(
      'data:image/png;base64,',
    );
  });
});
