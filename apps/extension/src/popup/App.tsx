import { useEffect } from 'react';
import type { CaptureSettings } from '@page-capture/core';
import { Checkbox } from './components/Checkbox.js';
import { Section } from './components/Section.js';
import { MultiSelectDropdown } from './components/MultiSelectDropdown.js';
import { SingleSelectDropdown } from './components/SingleSelectDropdown.js';
import { Progress } from './components/Progress.js';
import { CaptureButton } from './components/CaptureButton.js';
import { WarningList } from './components/WarningList.js';
import { RecentList } from './components/RecentList.js';
import { useSettings } from './use-settings.js';
import { useCapture } from './use-capture.js';
import { useHistory } from './use-history.js';

type Include = CaptureSettings['include'];
type Toggle = { key: keyof Include; label: string; hint?: string };

const PAGE_TOGGLES: Toggle[] = [
  { key: 'html', label: 'HTML / DOM' },
  { key: 'styles', label: 'Stylesheets' },
  { key: 'scripts', label: 'Scripts' },
  { key: 'images', label: 'Images' },
  { key: 'fonts', label: 'Fonts' },
];

const EXTRA_TOGGLES: Toggle[] = [
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

type OptionKey = 'scrollToLoadLazy' | 'inertSnapshot';
const OPTION_TOGGLES: { key: OptionKey; label: string; hint: string }[] = [
  {
    key: 'scrollToLoadLazy',
    label: 'Scroll to load lazy content',
    hint: 'Materializes lazy images before capturing',
  },
  {
    key: 'inertSnapshot',
    label: 'Inert snapshot',
    hint: 'Archive scripts without letting them run when reopened',
  },
];

/**
 * Presets exist because twelve independent checkboxes is a configuration
 * screen, not a tool. Most captures are one of these three.
 */
const PRESETS: { value: string; label: string; include: Include }[] = [
  {
    value: 'everything',
    label: 'Everything',
    include: {
      html: true,
      styles: true,
      scripts: true,
      images: true,
      fonts: true,
      screenshot: true,
      tokens: true,
      metadata: true,
      logs: true,
      rawSources: true,
    },
  },
  {
    value: 'page',
    label: 'Page only',
    include: {
      html: true,
      styles: true,
      scripts: true,
      images: true,
      fonts: true,
      screenshot: false,
      tokens: false,
      metadata: true,
      logs: false,
      rawSources: false,
    },
  },
  {
    value: 'design',
    label: 'Design audit',
    include: {
      html: true,
      styles: true,
      scripts: false,
      images: true,
      fonts: true,
      screenshot: true,
      tokens: true,
      metadata: true,
      logs: false,
      rawSources: false,
    },
  },
];

const THEME_ICONS = {
  system: (
    <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]">
      <rect
        x="1.5"
        y="2"
        width="9"
        height="6.5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M4 10.5h4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]">
      <circle
        cx="6"
        cy="6"
        r="2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M6 1v1.2M6 9.8V11M1 6h1.2M9.8 6H11M2.6 2.6l.85.85M8.55 8.55l.85.85M9.4 2.6l-.85.85M3.45 8.55l-.85.85"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]">
      <path
        d="M9.5 7.6A4 4 0 1 1 4.4 2.5a4 4 0 0 0 5.1 5.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

function matchingPreset(include: Include): string {
  const found = PRESETS.find((preset) =>
    (Object.keys(preset.include) as (keyof Include)[]).every(
      (key) => preset.include[key] === include[key],
    ),
  );
  return found?.value ?? '';
}

export function App() {
  const { settings, update } = useSettings();
  const { start, progress, result, error, running } = useCapture();
  const { entries } = useHistory();

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  const setInclude = (key: keyof Include, value: boolean): void => {
    update({ include: { ...settings.include, [key]: value } });
  };

  const setOption = (key: OptionKey, value: boolean): void => {
    update({ [key]: value });
  };

  return (
    <main className="flex flex-col gap-[14px] p-[14px]">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-[7px]">
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-gradient-to-br from-[#5eb0ff] to-[#003a9e] text-white shadow-[inset_0_0_0_1px_rgba(0,40,120,0.55)]">
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="h-[11px] w-[11px]"
            >
              {/* Viewfinder corner brackets around a faceted focus dot —
                  matches the extension icon. */}
              <path
                d="M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="8" cy="8" r="2.4" fill="currentColor" />
              <path
                d="M8 8L8 5.6A2.4 2.4 0 0 1 10.08 6.8Z"
                fill="currentColor"
                opacity="0.85"
              />
            </svg>
          </span>
          <h1 className="text-[13px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
            QuickCaps
          </h1>
        </div>
        <SingleSelectDropdown
          legend="Theme"
          compact
          value={settings.theme}
          options={[
            { value: 'system', label: 'System', icon: THEME_ICONS.system },
            { value: 'light', label: 'Light', icon: THEME_ICONS.light },
            { value: 'dark', label: 'Dark', icon: THEME_ICONS.dark },
          ]}
          onChange={(theme) =>
            update({ theme: theme as CaptureSettings['theme'] })
          }
        />
      </header>

      <SingleSelectDropdown
        legend="Preset"
        emphasis
        value={matchingPreset(settings.include)}
        options={PRESETS.map(({ value, label }) => ({ value, label }))}
        onChange={(value) => {
          const preset = PRESETS.find((candidate) => candidate.value === value);
          if (preset) update({ include: preset.include });
        }}
      />

      <div className="flex flex-col gap-[10px]">
        <Section title="Page contents">
          <div className="-mx-[6px]">
            {PAGE_TOGGLES.map(({ key, label, hint }) => (
              <Checkbox
                key={key}
                id={`include-${key}`}
                label={label}
                {...(hint ? { hint } : {})}
                checked={settings.include[key]}
                onChange={(checked) => setInclude(key, checked)}
              />
            ))}
          </div>
        </Section>

        <MultiSelectDropdown
          legend="Extras"
          options={EXTRA_TOGGLES}
          values={settings.include}
          onChange={setInclude}
        />

        <MultiSelectDropdown
          legend="Options"
          options={OPTION_TOGGLES}
          values={{
            scrollToLoadLazy: settings.scrollToLoadLazy,
            inertSnapshot: settings.inertSnapshot,
          }}
          onChange={setOption}
        />
      </div>

      <SingleSelectDropdown
        legend="Output"
        value={settings.output}
        options={[
          {
            value: 'single-file',
            label: 'Single self-contained HTML',
            hint: 'One file, opens anywhere offline',
          },
          {
            value: 'zip',
            label: 'ZIP folder',
            hint: 'Separate, editable assets',
          },
        ]}
        onChange={(output) =>
          update({ output: output as CaptureSettings['output'] })
        }
      />

      <div className="flex flex-col gap-[10px]">
        <CaptureButton running={running} onClick={() => void start()} />

        {progress && running ? <Progress progress={progress} /> : null}

        {error ? (
          <p
            role="alert"
            className="pc-enter rounded-[var(--radius-control)] border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)] px-[8px] py-[6px] text-[11.5px] leading-[1.4] text-[var(--error)]"
          >
            {error}
          </p>
        ) : null}

        {result ? (
          <section className="pc-enter rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-raised)] p-[10px]">
            <div className="flex items-start gap-[7px]">
              <svg
                viewBox="0 0 14 14"
                aria-hidden="true"
                className="mt-[1px] h-[13px] w-[13px] shrink-0 text-[var(--success)]"
              >
                <circle
                  cx="7"
                  cy="7"
                  r="6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M4.2 7.3 6.1 9.2 9.8 5.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="min-w-0">
                <p className="truncate font-mono text-[11.5px] text-[var(--text-primary)]">
                  {result.filename}
                </p>
                <p className="text-[10.5px] text-[var(--text-secondary)]">
                  {(result.byteLength / 1024).toFixed(1)} KB saved to Downloads
                </p>
              </div>
            </div>
            <WarningList warnings={result.warnings} />
          </section>
        ) : null}
      </div>

      <div className="border-t border-[var(--border)] pt-[10px]">
        <RecentList entries={entries} />
      </div>
    </main>
  );
}
