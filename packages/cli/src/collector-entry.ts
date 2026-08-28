import { collectFromDocument, type CollectOptions } from '@quickcaps/core';

/** Mirrors apps/extension/src/content/collector.ts's own list — kept as a
 * separate copy rather than a shared import, since sharing it would mean
 * packages/core (or packages/cli) importing from apps/extension, which is
 * backwards; an 18-string list is a small enough duplication cost. */
const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'font-family',
  'font-size',
  'line-height',
  'font-weight',
  'border-radius',
  'box-shadow',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
];

function readComputedStyle(el: Element): Record<string, string> {
  const style = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const property of STYLE_PROPERTIES) {
    out[property] = style.getPropertyValue(property);
  }
  return out;
}

/**
 * The one function this bundle exposes across the injection boundary.
 * `options` omits `computedStyle` because a function value can't survive
 * JSON serialization back to the CLI's process — but the reader itself is
 * constructed right here, inside the browser, and passed to
 * collectFromDocument directly, so no serialization of it is ever needed.
 */
(globalThis as Record<string, unknown>)['__quickcapsCollect'] = (
  options: Omit<CollectOptions, 'computedStyle'>,
) =>
  collectFromDocument(document, {
    ...options,
    computedStyle: readComputedStyle,
  });
