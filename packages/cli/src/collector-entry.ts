import { collectFromDocument, type CollectOptions } from '@quickcaps/core';

/**
 * The one function this bundle exposes across the injection boundary.
 * `options` omits `computedStyle` deliberately — a function value can't
 * survive JSON serialization back to the CLI's process, and Phase C1 has
 * no caller that needs the style tally, only the region tree. A later
 * phase (tokens/scrape, per the parent spec) can add it back.
 */
(globalThis as Record<string, unknown>)['__quickcapsCollect'] = (
  options: Omit<CollectOptions, 'computedStyle'>,
) => collectFromDocument(document, options);
