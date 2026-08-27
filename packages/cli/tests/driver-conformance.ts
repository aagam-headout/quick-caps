import { describe, expect, it } from 'vitest';
import type { PageDriver } from '@page-capture/core';

export type ConformanceFactory = () => Promise<{
  driver: PageDriver;
  teardown: () => Promise<void>;
}>;

export type ConformanceCapabilities = {
  /** StaticDriver has no renderer, so full-page screenshots are N/A, not a bug. */
  screenshot?: boolean;
};

/**
 * Runs the same behavioral assertions against any PageDriver. Existence of
 * this file, and every driver passing it, is the proof that the driver seam
 * (packages/core/src/driver.ts) is real: the capture pipeline can run against
 * any of them unchanged.
 */
export function runDriverConformance(
  name: string,
  factory: ConformanceFactory,
  capabilities: ConformanceCapabilities = {},
): void {
  describe(`${name} (driver conformance)`, () => {
    it('evaluates a self-contained function against the page', async () => {
      const { driver, teardown } = await factory();
      try {
        const title = await driver.evaluate(
          () => document.querySelector('h1')?.textContent ?? '',
        );
        expect(title).toBe('Driver Fixture');
      } finally {
        await teardown();
      }
    });

    it('reports a viewport with numeric width and height', async () => {
      const { driver, teardown } = await factory();
      try {
        const viewport = await driver.viewport();
        expect(typeof viewport.width).toBe('number');
        expect(typeof viewport.height).toBe('number');
      } finally {
        await teardown();
      }
    });

    it('records a scroll position it was moved to', async () => {
      const { driver, teardown } = await factory();
      try {
        await driver.scrollTo(0, 40);
        const viewport = await driver.viewport();
        expect(viewport.scrollY).toBe(40);
      } finally {
        await teardown();
      }
    });

    if (capabilities.screenshot !== false) {
      it('captures a non-empty full-page screenshot', async () => {
        const { driver, teardown } = await factory();
        try {
          const png = await driver.screenshotFullPage();
          expect(png.byteLength).toBeGreaterThan(0);
          // PNG magic number.
          expect(Array.from(png.slice(0, 4))).toEqual([137, 80, 78, 71]);
        } finally {
          await teardown();
        }
      });
    }
  });
}
