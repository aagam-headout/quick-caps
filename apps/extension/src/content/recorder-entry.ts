import { installRecorder, type RecorderTarget } from './recorder.js';

/**
 * The content script the manifest registers. Kept separate from recorder.ts so
 * that module stays side-effect free and can be imported by a test in Node,
 * where `window` does not exist.
 */
installRecorder(window as RecorderTarget, { size: 500 });
