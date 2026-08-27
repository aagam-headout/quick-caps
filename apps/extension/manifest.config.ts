import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

/**
 * Exported as a concrete object as well as through defineManifest. crxjs's
 * ManifestV3Export is a union that also admits a Promise and a function form,
 * so reading a field off the defineManifest result does not typecheck — and the
 * permission list is precisely the thing that must stay under test.
 */
export const manifest = {
  manifest_version: 3 as const,
  name: 'QuickCaps',
  short_name: 'QuickCaps',
  description:
    "Save a page's full front-end - HTML, CSS, JavaScript, images, fonts - to your own disk. Nothing is uploaded.",
  version: pkg.version,
  minimum_chrome_version: '116',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Capture page',
  },
  // Invoking either grants activeTab for that tab, same as the toolbar
  // button — no popup needed to read the page. Cross-origin asset access
  // still depends on the optional <all_urls> grant from a popup visit; a
  // headless trigger degrades the same way the popup capture already does
  // when that grant is missing.
  commands: {
    'capture-page': {
      suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
      description: 'Capture the current page with QuickCaps',
    },
  },
  permissions: [
    'activeTab',
    'scripting',
    'storage',
    'downloads',
    // Lets a click on a Recent entry open the captured file directly, rather
    // than only revealing it in its folder.
    'downloads.open',
    'offscreen',
    // The right-click "Capture page with QuickCaps" menu entry.
    'contextMenus',
    // Feedback for captures triggered without a popup open (shortcut, menu).
    'notifications',
  ],
  // <all_urls> is requested at capture time, not at install: a store reviewer
  // should not have to take a broad host grant on trust.
  optional_host_permissions: ['<all_urls>'],
  // The e2e build alone gets the grant up front. Chrome's permission dialog
  // cannot be automated, and chrome.permissions.request needs a user gesture
  // that page.evaluate does not provide. The request flow itself is covered by
  // the popup unit tests; this only removes the dialog from the browser tests.
  ...(process.env['PC_E2E'] === '1'
    ? { host_permissions: ['<all_urls>' as const] }
    : {}),
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/recorder-entry.ts'],
      run_at: 'document_start' as const,
      world: 'MAIN' as const,
      all_frames: false,
    },
  ],
  icons: {
    '16': 'icons/icon-16.png',
    '32': 'icons/icon-32.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
  content_security_policy: {
    // No remote code: script-src and style-src stay local, which is what a
    // store reviewer checks and what keeps the extension safe.
    //
    // connect-src must allow arbitrary hosts. Fetching the assets of the page
    // being captured is the entire product, it happens from the offscreen
    // document, which is an extension page, and it is already gated by the
    // optional host permission the user grants. 'self' here silently blocked
    // every asset fetch.
    extension_pages:
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src * data: blob:",
  },
};

// defineManifest validates the object against crxjs's expected shape at this
// call site, which is the check that matters; the const above keeps the fields
// concretely typed for the test.
export default defineManifest(manifest);
