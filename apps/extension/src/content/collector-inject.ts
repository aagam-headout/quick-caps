import { parkCollectorResult } from './collector.js';
import { serializePage } from './serialize.js';

/**
 * The build entry injected wholesale by
 * chrome.scripting.executeScript({ files: ['collector.js'] }).
 *
 * Side effects and browser-only dependencies live only in *-entry / *-inject
 * files. single-file-core is imported here rather than in collector.ts so that
 * module stays loadable — and testable — in Node.
 */
void parkCollectorResult(window as unknown as Record<string, unknown>, {
  serialize: serializePage,
});
