import { describe, expect, it } from 'vitest';
import { manifest } from '../manifest.config.js';

describe('manifest', () => {
  it('targets manifest v3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('requests exactly the permissions the spec allows at install time', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'activeTab',
      'contextMenus',
      'downloads',
      'downloads.open',
      'notifications',
      'offscreen',
      'scripting',
      'storage',
    ]);
  });

  it('declares the keyboard shortcut for a popup-free capture', () => {
    expect(manifest.commands['capture-page']?.suggested_key?.default).toBe(
      'Ctrl+Shift+K',
    );
  });

  it('keeps all_urls optional rather than install-time', () => {
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    // Asserted as key absence, not an undefined value: a manifest carrying
    // host_permissions: undefined would still be a broad-grant manifest to
    // review, and would satisfy a toBeUndefined check.
    //
    // The e2e build adds host_permissions behind PC_E2E; this asserts the
    // shipped build never does.
    expect(process.env['PC_E2E']).not.toBe('1');
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

  it('forbids remote code but permits asset fetching', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("default-src 'self'");
    // No remote executable code. This is the security-relevant invariant.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*https?:/);
    expect(csp).not.toMatch(/style-src[^;]*https?:/);
    // Asset fetching must be possible. An earlier version asserted the CSP
    // contained no 'http' at all, which forced connect-src 'self' and blocked
    // every asset fetch the product exists to make.
    expect(csp).toMatch(/connect-src[^;]*\*/);
  });

  it('does not load remote fonts, which the CSP could not permit anyway', () => {
    expect(manifest.content_security_policy.extension_pages).toContain(
      "font-src 'self'",
    );
  });

  it('takes its version from package.json so releases cannot drift', async () => {
    const pkg = (await import('../package.json')) as unknown as {
      default: { version: string };
    };
    expect(manifest.version).toBe(pkg.default.version);
  });
});
