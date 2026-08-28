import { parseHTML } from 'linkedom';
import { readSession } from '../session.js';
import { CliError } from '../errors.js';

/**
 * Splits "selector@attr" into { selector, attr }, treating a top-level `@`
 * (outside any [...] bracket or quoted string) as the suffix marker. An
 * `@` inside a bracketed/quoted attribute selector like `[data-at="x"]` is
 * part of the selector, not this shape's own syntax — a state-machine scan
 * over bracket/quote depth, not a regex, since that nesting is exactly the
 * kind of thing a regex gets subtly wrong.
 */
export function splitSelectorAttr(raw: string): {
  selector: string;
  attr?: string;
} {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char as '"' | "'";
    } else if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth = Math.max(0, depth - 1);
    } else if (char === '@' && depth === 0) {
      const attr = raw.slice(i + 1);
      if (attr.length > 0) return { selector: raw.slice(0, i), attr };
    }
  }
  return { selector: raw };
}

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function parseShape(raw: string): Record<string, string> {
  let shape: unknown;
  try {
    shape = JSON.parse(raw);
  } catch {
    throw new CliError(
      'scrape expects a JSON object mapping field name to CSS selector, e.g. \'{"title":"h1"}\'.',
    );
  }
  if (typeof shape !== 'object' || shape === null || Array.isArray(shape)) {
    throw new CliError(
      'scrape shape must be a JSON object, not an array or primitive.',
    );
  }
  for (const [field, selector] of Object.entries(shape)) {
    if (typeof selector !== 'string') {
      throw new CliError(
        `scrape shape's "${field}" value must be a CSS selector string.`,
      );
    }
  }
  return shape as Record<string, string>;
}

/**
 * Extracts named fields from the *stored* session, offline: session.ir.html
 * already holds a complete serialized DOM regardless of which driver
 * produced it, so re-parsing it with linkedom (the same technique read.ts
 * already uses for domPath) gives scrape everything it needs with zero
 * network calls and zero browser launch.
 */
export async function runScrape(
  rawShape: string,
  cwd: string,
): Promise<string> {
  const session = await readSession(cwd);
  const shape = parseShape(rawShape);
  const { document } = parseHTML(session.ir.html);

  const result: Record<string, string | null> = {};
  for (const [field, rawSelector] of Object.entries(shape)) {
    const { selector, attr } = splitSelectorAttr(rawSelector);
    let el: Element | null;
    try {
      el = document.querySelector(selector);
    } catch {
      throw new CliError(
        `scrape field "${field}" has an invalid CSS selector: "${selector}".`,
      );
    }
    if (!el) {
      result[field] = null;
    } else if (attr) {
      result[field] = el.getAttribute(attr);
    } else {
      result[field] = collapseWhitespace(el.textContent ?? '');
    }
  }
  return JSON.stringify(result, null, 2);
}
