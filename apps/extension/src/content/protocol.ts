/**
 * Shared constants for the content-script protocol. Deliberately free of any
 * side effect or environment access so both worlds' scripts and their tests can
 * import it anywhere, including Node.
 */

/** Where the built collector leaves its result for the worker to read. */
export const IR_KEY = '__pageCaptureIR';

/** Where the worker leaves the settings for the collector to read. */
export const SETTINGS_KEY = '__pageCaptureSettings';

/** DOM attribute the MAIN-world recorder flushes its ring buffer into. */
export const LOGS_ATTRIBUTE = 'data-page-capture-logs';

/** Event the recorder listens for, to flush synchronously. */
export const FLUSH_EVENT = '__page-capture-flush-logs';
