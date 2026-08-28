import type { CaptureSettings, PageIR, Warning } from '@quickcaps/core';
import type { StitchRequest } from '../background/chrome-driver.js';
import type { Frame } from './capture.js';

/**
 * One-off request from the popup's "Preview screenshot" button: capture and
 * stitch the current tab's full page, then open it in a new tab. Independent
 * of the "Full-page screenshot (PNG)" setting, which only controls whether
 * the screenshot rides along with an actual capture.
 */
export const PREVIEW_SCREENSHOT = '__quickcaps-preview-screenshot';

export type OffscreenCaptureRequest = {
  type: 'offscreen:capture';
  ir: PageIR;
  /** Already self-contained: single-file-core inlined it in the page. */
  html: string;
  settings: CaptureSettings;
  frames?: Frame[];
};

export type OffscreenCaptureResult = {
  filename: string;
  mimeType: string;
  byteLength: number;
  objectUrl: string;
  warnings: Warning[];
};

export type OffscreenRequest =
  | OffscreenCaptureRequest
  | { type: 'offscreen:stitch'; request: StitchRequest }
  | { type: 'offscreen:object-url'; bytes: number[]; mimeType: string }
  | { type: 'offscreen:revoke'; url: string };

export type OffscreenResponse =
  | { ok: true; type: 'capture'; result: OffscreenCaptureResult }
  | { ok: true; type: 'stitch'; bytes: number[] }
  | { ok: true; type: 'object-url'; url: string }
  | { ok: true; type: 'revoked' }
  | { ok: false; error: string };

export type CapturePhase =
  | 'idle'
  | 'permissions'
  | 'collecting'
  | 'fetching-assets'
  | 'screenshot'
  | 'bundling'
  | 'downloading'
  | 'done'
  | 'failed';

export type CaptureProgress = {
  phase: CapturePhase;
  done: number;
  total: number;
  warningCount: number;
  message?: string;
};

export type CaptureWarningView = {
  phase: string;
  url?: string;
  reason: string;
  detail?: string;
};

export type PopupToWorker =
  | {
      type: 'capture:start';
      tabId: number;
      /**
       * Decided in the popup: chrome.permissions.request requires a user
       * gesture, which a message-handling worker does not have.
       */
      hasHostPermission: boolean;
      /** Whether the captured page's own origin is readable. */
      hasPageAccess: boolean;
    }
  | { type: 'capture:cancel' };

export type WorkerToPopup =
  | { type: 'capture:progress'; progress: CaptureProgress }
  | {
      type: 'capture:done';
      filename: string;
      byteLength: number;
      warnings: CaptureWarningView[];
    }
  | { type: 'capture:failed'; reason: string; recoverable: boolean };

/**
 * Progress relayed from the offscreen document to the worker, which forwards it
 * to the popup. The offscreen document has no port of its own.
 */
export type OffscreenProgress = {
  type: 'offscreen:progress';
  progress: CaptureProgress;
};

export const CAPTURE_PORT = 'quickcaps';
