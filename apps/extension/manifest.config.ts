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
  name: 'Page Capture',
  short_name: 'Capture',
  description:
    "Save a page's full front-end - HTML, CSS, JavaScript, images, fonts - to your own disk. Nothing is uploaded.",
  version: pkg.version,
  minimum_chrome_version: '116',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Capture page',
  },
  permissions: ['activeTab', 'scripting', 'storage', 'downloads', 'offscreen'],
  // <all_urls> is requested at capture time, not at install: a store reviewer
  // should not have to take a broad host grant on trust.
  optional_host_permissions: ['<all_urls>'],
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
    extension_pages:
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
  },
};

// defineManifest validates the object against crxjs's expected shape at this
// call site, which is the check that matters; the const above keeps the fields
// concretely typed for the test.
export default defineManifest(manifest);
