import { useEffect } from 'react';
import type { CaptureSettings } from '@page-capture/core';
import { Checkbox } from './components/Checkbox.js';
import { RadioGroup } from './components/RadioGroup.js';
import { Progress } from './components/Progress.js';
import { WarningList } from './components/WarningList.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { RecentList } from './components/RecentList.js';
import { useSettings } from './use-settings.js';
import { useCapture } from './use-capture.js';
import { useHistory } from './use-history.js';

type Toggle = {
  key: keyof CaptureSettings['include'];
  label: string;
  hint?: string;
};

const TOGGLES: Toggle[] = [
  { key: 'html', label: 'HTML / DOM', hint: 'The rendered document' },
  { key: 'styles', label: 'Stylesheets' },
  { key: 'scripts', label: 'Scripts' },
  { key: 'images', label: 'Images' },
  { key: 'fonts', label: 'Fonts' },
  { key: 'screenshot', label: 'Full-page screenshot (PNG)' },
  {
    key: 'tokens',
    label: 'Design tokens (JSON)',
    hint: 'Colours, type scale, spacing',
  },
  { key: 'metadata', label: 'Metadata' },
  {
    key: 'logs',
    label: 'Console + network log',
    hint: 'Needs the page open since load',
  },
  {
    key: 'rawSources',
    label: 'Raw network sources',
    hint: 'What the server sent, before JavaScript',
  },
];

export function App() {
  const { settings, update } = useSettings();
  const { start, progress, result, error, running } = useCapture();
  const { entries } = useHistory();

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  return (
    <main className="flex flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
          Page Capture
        </h1>
        <ThemeToggle
          value={settings.theme}
          onChange={(theme) => update({ theme })}
        />
      </header>

      <section>
        <h2 className="pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
          What to capture
        </h2>
        {TOGGLES.map(({ key, label, hint }) => (
          <Checkbox
            key={key}
            id={`include-${key}`}
            label={label}
            {...(hint ? { hint } : {})}
            checked={settings.include[key]}
            onChange={(checked) =>
              update({ include: { ...settings.include, [key]: checked } })
            }
          />
        ))}
        <Checkbox
          id="scroll-lazy"
          label="Scroll to load lazy content"
          hint="Materializes lazy images before capturing"
          checked={settings.scrollToLoadLazy}
          onChange={(scrollToLoadLazy) => update({ scrollToLoadLazy })}
        />
        <Checkbox
          id="inert"
          label="Inert snapshot"
          hint="Archive scripts without letting them run when reopened"
          checked={settings.inertSnapshot}
          onChange={(inertSnapshot) => update({ inertSnapshot })}
        />
      </section>

      <RadioGroup
        name="output"
        legend="Output"
        value={settings.output}
        options={[
          { value: 'single-file', label: 'Single self-contained HTML' },
          {
            value: 'zip',
            label: 'ZIP folder',
            hint: 'Separate, editable assets',
          },
        ]}
        onChange={(output) =>
          update({ output: output as typeof settings.output })
        }
      />

      <button
        type="button"
        onClick={() => void start()}
        disabled={running}
        className="rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 text-[13px] font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-60"
      >
        {running ? 'Capturing…' : 'Capture page'}
      </button>

      {progress && running ? <Progress progress={progress} /> : null}

      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-control)] border border-[var(--error)] px-2 py-[6px] text-[12px] text-[var(--error)]"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <section className="rounded-[var(--radius-card)] border border-[var(--border)] p-2">
          <p className="truncate font-mono text-[12px] text-[var(--text-primary)]">
            {result.filename}
          </p>
          <p className="text-[11px] text-[var(--text-secondary)]">
            {(result.byteLength / 1024).toFixed(1)} KB saved to Downloads
          </p>
          <WarningList warnings={result.warnings} />
        </section>
      ) : null}

      <RecentList entries={entries} />
    </main>
  );
}
