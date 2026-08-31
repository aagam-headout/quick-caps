import type { PerfReport } from './perf.js';
import type { Recording } from './observe/types.js';

export type WarningPhase =
  | 'collect'
  | 'permissions'
  | 'assets'
  | 'styles'
  | 'screenshot'
  | 'bundle'
  | 'download'
  | 'extract';

export type Warning = {
  phase: WarningPhase;
  url?: string;
  reason: string;
  detail?: string;
};

export type PageMetadata = {
  url: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  documentSize: { width: number; height: number };
  devicePixelRatio: number;
  userAgent: string;
  charset: string;
  meta: Record<string, string>;
};

export type AssetKind = 'image' | 'font' | 'script' | 'media' | 'stylesheet';

export type AssetRef = {
  url: string;
  kind: AssetKind;
  /** Where it was referenced from, for warning messages. */
  referencedBy: string;
};

export type StyleSource =
  | { kind: 'inline'; text: string; index: number }
  | { kind: 'same-origin'; text: string; href: string }
  | { kind: 'cross-origin'; href: string };

export type StyleTallyKey =
  | 'color'
  | 'backgroundColor'
  | 'borderColor'
  | 'fontFamily'
  | 'fontSize'
  | 'lineHeight'
  | 'fontWeight'
  | 'spacing'
  | 'borderRadius'
  | 'boxShadow';

/** Normalized value to occurrence count, per property group. */
export type StyleTally = Record<StyleTallyKey, Record<string, number>>;

export type LogEntry =
  | {
      kind: 'console';
      level: 'log' | 'info' | 'warn' | 'error' | 'debug';
      at: number;
      text: string;
    }
  | {
      kind: 'request';
      at: number;
      method: string;
      url: string;
      status: number | null;
      durationMs: number;
      size: number | null;
    }
  | { kind: 'error'; at: number; message: string; stack?: string };

export type ActionRef = {
  id: number;
  type: 'link' | 'button' | 'input';
  label: string;
  href?: string;
  /** Child-index chain from document.body to this action's own element —
   * lets `do <n>` relocate the exact clickable/fillable element without
   * ambiguity, even when it's inside a wrapper-collapsed container. */
  domPath: number[];
};

export type Region = {
  id: number;
  role: string;
  tag: string;
  box: { x: number; y: number; w: number; h: number };
  textLength: number;
  /** Own text only (not descendants'), trimmed, capped at 200 chars. */
  snippet: string;
  /** Text length per 1000 square pixels of area. Zero when area is zero. */
  textDensity: number;
  actions: ActionRef[];
  children: Region[];
  /** Child-index chain from document.body to this element — e.g. [1, 0, 2]
   * means body.children[1].children[0].children[2]. Read fresh from the
   * live DOM, independent of wrapper collapsing, so `read <n>` can relocate
   * the exact node in a re-parsed PageIR.html. */
  domPath: number[];
};

export type PageIR = {
  metadata: PageMetadata;
  html: string;
  regions: Region[];
  styles: StyleSource[];
  assets: AssetRef[];
  styleTally: StyleTally;
  logs?: LogEntry[];
  perf?: PerfReport;
  /** Present only when the host was armed to watch the network. Absent means
   * nobody was watching — a different answer from "nothing happened", and the
   * reports derived from this field are required to say which. */
  recording?: Recording;
  warnings: Warning[];
};
