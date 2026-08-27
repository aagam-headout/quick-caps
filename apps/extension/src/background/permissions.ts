// Not `as const`: chrome.permissions expects mutable arrays.
const ALL_URLS: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

/**
 * Whether the extension may currently fetch cross-origin assets.
 *
 * Only a check, never a request: chrome.permissions.request must run during a
 * user gesture, which a worker handling a message does not have. The popup owns
 * the request (see popup/use-capture.ts) and passes its answer along; this
 * guards against a grant revoked in between.
 */
export async function hasHostPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(ALL_URLS);
  } catch {
    return false;
  }
}
