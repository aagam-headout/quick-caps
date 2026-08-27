import { useId, useState } from 'react';
import {
  diffCaptures,
  extractCaptureMetadata,
  type CaptureSide,
} from '../lib/compare.js';

type Slot = { file: File; side: CaptureSide } | { file: File; error: string };

function isReady(slot: Slot | null): slot is { file: File; side: CaptureSide } {
  return slot !== null && 'side' in slot;
}

async function readSlot(file: File): Promise<Slot> {
  const doc = await extractCaptureMetadata(file);
  if (!doc) {
    return {
      file,
      error:
        'No metadata found in this file — capture with "Metadata" checked to compare it.',
    };
  }
  return { file, side: { filename: file.name, byteLength: file.size, doc } };
}

function Picker({
  id,
  label,
  slot,
  onPick,
}: {
  id: string;
  label: string;
  slot: Slot | null;
  onPick: (file: File) => void;
}) {
  return (
    <label htmlFor={id} className="block min-w-0 flex-1">
      <span className="block text-[11px] font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      <input
        id={id}
        type="file"
        accept=".html,.zip"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onPick(file);
        }}
        className="mt-[4px] block w-full text-[11px] text-[var(--text-secondary)] file:mr-[6px] file:rounded-[var(--radius-control)] file:border-0 file:bg-[var(--surface-raised)] file:px-[8px] file:py-[4px] file:text-[11px] file:text-[var(--text-primary)]"
      />
      {slot ? (
        <span className="mt-[4px] block truncate text-[10.5px] text-[var(--text-secondary)]">
          {slot.file.name}
        </span>
      ) : null}
      {slot && !isReady(slot) ? (
        <span role="alert" className="mt-[2px] block text-[10.5px] text-[var(--error)]">
          {slot.error}
        </span>
      ) : null}
    </label>
  );
}

function DiffRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[2px]">
      <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>
      <span className="font-mono text-[11px] text-[var(--text-primary)]">
        {value}
      </span>
    </div>
  );
}

function signed(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return `${delta}`;
}

/**
 * Compares two previously saved captures. The extension keeps no handle to a
 * download once Chrome owns it, so the user re-picks the two files from disk
 * — the comparison itself reads the metadata block bundle.ts embeds (§ core
 * `metadataDocument`), not the archives' full content, which is why a
 * capture taken with "Metadata" off can't be compared.
 */
export function CompareCaptures() {
  const idA = useId();
  const idB = useId();
  const [a, setA] = useState<Slot | null>(null);
  const [b, setB] = useState<Slot | null>(null);

  const pick = (setSlot: (slot: Slot) => void) => (file: File) => {
    void readSlot(file).then(setSlot);
  };

  const diff = isReady(a) && isReady(b) ? diffCaptures(a.side, b.side) : null;

  return (
    <div className="flex flex-col gap-[8px]">
      <div className="flex gap-[10px]">
        <Picker id={idA} label="Capture A" slot={a} onPick={pick(setA)} />
        <Picker id={idB} label="Capture B" slot={b} onPick={pick(setB)} />
      </div>

      {diff ? (
        <div className="pc-enter rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-raised)] p-[8px]">
          <DiffRow label="Same URL" value={diff.sameUrl ? 'yes' : 'no'} />
          <DiffRow label="Size" value={`${signed(diff.byteLengthDelta)} B`} />
          <DiffRow label="Warnings" value={signed(diff.warningCountDelta)} />
          {diff.regionCountDelta !== null ? (
            <DiffRow label="Regions" value={signed(diff.regionCountDelta)} />
          ) : null}
          {diff.settingsChanges.length > 0 ? (
            <div className="mt-[4px] border-t border-[var(--border)] pt-[4px]">
              <span className="block pb-[2px] text-[10.5px] uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                Settings changed
              </span>
              {diff.settingsChanges.map((change) => (
                <DiffRow
                  key={change.key}
                  label={change.key}
                  value={`${String(change.a)} → ${String(change.b)}`}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
