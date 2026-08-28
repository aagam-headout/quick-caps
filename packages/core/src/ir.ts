import type { PerfReport } from './perf.js';

export type WarningPhase =
  | 'collect'
  | 'permissions'
  | 'assets'
  | 'styles'
  | 'screenshot'
  | 'bundle'
  | 'download';

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
  warnings: Warning[];
};
