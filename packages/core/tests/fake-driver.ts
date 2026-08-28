import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import type {
  AssetBytes,
  FetchOptions,
  PageDriver,
  Viewport,
} from '../src/driver.js';

const here = dirname(fileURLToPath(import.meta.url));

export type FixtureName = 'static' | 'spa' | 'gallery' | 'nav-heavy';

export function fixtureHtml(name: FixtureName): string {
  return readFileSync(join(here, 'fixtures', `${name}.html`), 'utf8');
}

/**
 * Parses a fixture and gives every element a deterministic layout box derived
 * from its document order. Real layout is not available under linkedom, and
 * faking it keeps density and geometry tests independent of a layout engine.
 */
function parseFixture(name: FixtureName) {
  const parsed = parseHTML(fixtureHtml(name));
  let index = 0;
  for (const el of parsed.document.querySelectorAll('*')) {
    const position = index++;
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: position * 40,
        width: 800,
        height: 40,
        top: position * 40,
        left: 0,
        right: 800,
        bottom: position * 40 + 40,
      }),
    });
  }
  return parsed;
}

export function fixtureDocument(name: FixtureName): Document {
  return parseFixture(name).document as unknown as Document;
}

export type FakeDriverOptions = {
  fixture: FixtureName;
  assets?: Record<string, Uint8Array>;
  failures?: Record<string, string>;
  hangs?: string[];
  viewport?: Partial<Viewport>;
  screenshot?: Uint8Array;
};

/**
 * A PageDriver over a linkedom-parsed fixture. Its existence is the continuous
 * proof that the driver seam is real: if the pipeline runs against this, it can
 * run against Chrome or Playwright without changing.
 */
export class FakeDriver implements PageDriver {
  readonly fetches: string[] = [];
  readonly document: Document;
  private readonly window: Window & typeof globalThis;
  private scroll = { x: 0, y: 0 };

  constructor(private readonly options: FakeDriverOptions) {
    const parsed = parseFixture(options.fixture);
    this.window = parsed.window as unknown as Window & typeof globalThis;
    this.document = parsed.document as unknown as Document;
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousDocument = globals['document'];
    const previousWindow = globals['window'];
    globals['document'] = this.document;
    globals['window'] = this.window;
    try {
      return fn();
    } finally {
      globals['document'] = previousDocument;
      globals['window'] = previousWindow;
    }
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    this.fetches.push(url);
    if (this.options.hangs?.includes(url)) {
      return new Promise<AssetBytes>(() => {
        /* deliberately never settles, so timeout handling is exercised */
      });
    }
    const failure = this.options.failures?.[url];
    if (failure) throw new Error(failure);
    const bytes = this.options.assets?.[url];
    if (!bytes) throw new Error(`404 ${url}`);
    if (bytes.byteLength > options.maxBytes) {
      throw new Error(`too large: ${url}`);
    }
    return { url, bytes, contentType: null };
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    return this.options.screenshot ?? new Uint8Array([137, 80, 78, 71]);
  }

  async scrollTo(x: number, y: number): Promise<void> {
    this.scroll = { x, y };
  }

  async viewport(): Promise<Viewport> {
    return {
      width: 1280,
      height: 800,
      documentWidth: 1280,
      documentHeight: 2400,
      scrollX: this.scroll.x,
      scrollY: this.scroll.y,
      devicePixelRatio: 2,
      ...this.options.viewport,
    };
  }
}
