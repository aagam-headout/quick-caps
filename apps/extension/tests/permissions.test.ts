import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasHostPermission } from '../src/background/permissions.js';

let contains: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  contains = vi.fn();
  request = vi.fn();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    permissions: { contains, request },
  };
});

describe('hasHostPermission', () => {
  it('is true when the grant is held', async () => {
    contains.mockResolvedValue(true);
    await expect(hasHostPermission()).resolves.toBe(true);
  });

  it('is false when the grant is absent', async () => {
    contains.mockResolvedValue(false);
    await expect(hasHostPermission()).resolves.toBe(false);
  });

  it('never requests from the worker, where there is no user gesture', async () => {
    contains.mockResolvedValue(false);
    await hasHostPermission();
    expect(request).not.toHaveBeenCalled();
  });

  it('returns false rather than propagating an error', async () => {
    contains.mockRejectedValue(new Error('no such permission'));
    await expect(hasHostPermission()).resolves.toBe(false);
  });
});
