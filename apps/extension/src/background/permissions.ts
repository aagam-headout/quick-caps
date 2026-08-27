// Not `as const`: chrome.permissions expects mutable arrays.
const ALL_URLS: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

/**
 * True when the extension may fetch cross-origin assets.
 *
 * Declining is a supported path, not an error: the capture proceeds with
 * same-origin material and warns about what it skipped. So this never throws
 * and never blocks — including when chrome rejects the request for want of a
 * user gesture.
 */
export async function ensureHostPermission(): Promise<boolean> {
  try {
    if (await chrome.permissions.contains(ALL_URLS)) return true;
    return await chrome.permissions.request(ALL_URLS);
  } catch {
    return false;
  }
}
