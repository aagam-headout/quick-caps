import { installPicker } from './picker.js';
import { PICKER_CAPTURE } from './protocol.js';

/**
 * The build entry injected wholesale by
 * chrome.scripting.executeScript({ files: ['picker.js'] }) when the user
 * clicks "Pick element" in the popup. chrome.runtime is browser-only, so
 * that dependency lives here rather than in picker.ts, which stays loadable
 * — and testable — in Node.
 */
installPicker({
  onCapture: (selector) => {
    void chrome.runtime
      .sendMessage({ type: PICKER_CAPTURE, selector })
      .catch(() => {});
  },
});
