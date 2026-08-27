import { describe, expect, it } from 'vitest';
import { manifest } from '../manifest.config.js';

describe('manifest', () => {
  it('targets manifest v3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('requests exactly the permissions the spec allows at install time', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'activeTab',
      'downloads',
      'offscreen',
      'scripting',
      'storage',
    ]);
  });

  it('keeps all_urls optional rather than install-time', () => {
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    // Asserted as key absence, not an undefined value: a manifest carrying
    // host_permissions: undefined would still be a broad-grant manifest to
    // review, and would satisfy a toBeUndefined check.
    expect('host_permissions' in manifest).toBe(false);
  });

  it('declares a service worker as a module', () => {
    expect(manifest.background.type).toBe('module');
    expect(manifest.background.service_worker).toBe('src/background/index.ts');
  });

  it('registers the recorder at document_start in the main world', () => {
    const script = manifest.content_scripts[0]!;
    expect(script.run_at).toBe('document_start');
    expect(script.world).toBe('MAIN');
    expect(script.matches).toEqual(['<all_urls>']);
  });

  it('declares all four icon sizes', () => {
    expect(Object.keys(manifest.icons).sort()).toEqual([
      '128',
      '16',
      '32',
      '48',
    ]);
  });

  it('sets a CSP with no remote sources', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('http');
  });

  it('takes its version from package.json so releases cannot drift', async () => {
    const pkg = (await import('../package.json')) as unknown as {
      default: { version: string };
    };
    expect(manifest.version).toBe(pkg.default.version);
  });
});
