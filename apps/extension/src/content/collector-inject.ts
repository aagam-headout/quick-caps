import { parkCollectorResult } from './collector.js';

/**
 * The build entry injected wholesale by
 * chrome.scripting.executeScript({ files: ['collector.js'] }).
 *
 * Side effects live only in *-entry / *-inject files. Everything else stays
 * importable from Node, which is what keeps it testable.
 */
parkCollectorResult(window as unknown as Record<string, unknown>);
