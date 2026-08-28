import { parkCollectorResult } from './collector.js';
import { serializePage } from './serialize.js';
import { SERIALIZE_PROGRESS } from './protocol.js';

/**
 * The build entry injected wholesale by
 * chrome.scripting.executeScript({ files: ['collector.js'] }).
 *
 * Side effects and browser-only dependencies live only in *-entry / *-inject
 * files. single-file-core is imported here rather than in collector.ts so that
 * module stays loadable - and testable - in Node.
 */
void parkCollectorResult(window as unknown as Record<string, unknown>, {
  serialize: (settings) =>
    serializePage(settings, {
      onProgress: (progress) => {
        // Fire and forget: the worker may not be listening, and progress is
        // never worth failing a capture over.
        void chrome.runtime
          .sendMessage({ type: SERIALIZE_PROGRESS, ...progress })
          .catch(() => {});
      },
    }),
});
