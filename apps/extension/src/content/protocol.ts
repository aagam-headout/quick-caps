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
export const LOGS_ATTRIBUTE = 'data-quick-caps-logs';

/**
 * Message the page-context serializer sends to the worker to fetch a resource
 * on its behalf. SingleFile runs in the page and cannot fetch cross-origin.
 */
export const FETCH_RESOURCE = '__quick-caps-fetch-resource';

/**
 * Progress from the page-context serializer, relayed by the worker to the
 * popup. Without it a large page looks frozen for the whole serialization.
 */
export const SERIALIZE_PROGRESS = '__quick-caps-serialize-progress';

/** Event the recorder listens for, to flush synchronously. */
export const FLUSH_EVENT = '__quick-caps-flush-logs';

/**
 * Sent by the injected element picker once the user confirms a selection.
 * Triggers a headless capture (no popup involved, same as the keyboard
 * shortcut) scoped to just that element.
 */
export const PICKER_CAPTURE = '__quick-caps-picker-capture';
