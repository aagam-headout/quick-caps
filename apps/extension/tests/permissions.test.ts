import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureHostPermission } from '../src/background/permissions.js';

let contains: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  contains = vi.fn();
  request = vi.fn();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    permissions: { contains, request },
  };
});

describe('ensureHostPermission', () => {
  it('does not prompt when already granted', async () => {
    contains.mockResolvedValue(true);
    await expect(ensureHostPermission()).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('requests all_urls when not granted', async () => {
    contains.mockResolvedValue(false);
    request.mockResolvedValue(true);
    await expect(ensureHostPermission()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  });

  it('returns false when the user declines, without throwing', async () => {
    contains.mockResolvedValue(false);
    request.mockResolvedValue(false);
    await expect(ensureHostPermission()).resolves.toBe(false);
  });

  it('returns false rather than propagating a request error', async () => {
    contains.mockResolvedValue(false);
    request.mockRejectedValue(new Error('no user gesture'));
    await expect(ensureHostPermission()).resolves.toBe(false);
  });
});
