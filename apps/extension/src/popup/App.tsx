import { useEffect, useState } from 'react';
import type { CaptureSettings } from '@quickcaps/core';
import { Checkbox } from './components/Checkbox.js';
import { Section } from './components/Section.js';
import { TextField } from './components/TextField.js';
import { SingleSelectDropdown } from './components/SingleSelectDropdown.js';
import { Progress } from './components/Progress.js';
import { CaptureButton } from './components/CaptureButton.js';
import { WarningList } from './components/WarningList.js';
import { RecentList } from './components/RecentList.js';
import { CompareCaptures } from './components/CompareCaptures.js';
import { useSettings } from './use-settings.js';
import { useCapture } from './use-capture.js';
import { useHistory } from './use-history.js';
import { usePicker } from './use-picker.js';
import { usePreview } from './use-preview.js';
import { formatSize } from './lib/format-size.js';

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
  {
    key: 'screenshot',
    label: 'Full-page screenshot (PNG)',
    hint: 'Stitched top to bottom, saved alongside the capture',
  },
  {
    key: 'tokens',
    label: 'Design tokens (JSON)',
    hint: 'Colours, type scale, spacing used on the page',
  },
  {
    key: 'metadata',
    label: 'Metadata',
    hint: 'URL, capture time, warnings, and the settings used',
  },
  {
    key: 'logs',
    label: 'Console + network log',
    hint: 'Needs the page open since load',
  },
  {
    key: 'perf',
    label: 'Performance snapshot (JSON)',
    hint: 'TTFB, paint timing, load time - not a Lighthouse audit',
  },
  {
    key: 'rawSources',
    label: 'Raw network sources',
    hint: 'What the server sent, before JavaScript',
  },
];

/** Behavior toggles, shown in Advanced alongside the text fields — merged
 * out of a former "Options" dropdown that only added a second vague bucket
 * next to "Extras" and "Advanced". */
type OptionKey = 'scrollToLoadLazy' | 'inertSnapshot' | 'embedViewer';
const OPTION_TOGGLES: { key: OptionKey; label: string; hint: string }[] = [
  {
    key: 'scrollToLoadLazy',
    label: 'Scroll to load lazy content',
    hint: 'Materializes lazy images before capturing',
  },
  {
    key: 'inertSnapshot',
    label: 'Inert snapshot',
    hint: 'Strips and blocks scripts so a reopened capture never re-runs analytics or trackers',
  },
  {
    key: 'embedViewer',
    label: 'Embed viewer panel',
    hint: 'Adds a button to the archive for browsing its metadata/tokens/logs/perf/raw data',
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
      perf: true,
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
      perf: false,
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
      perf: true,
    },
  },
  {
    value: 'quick',
    label: 'Quick capture',
    include: {
      html: true,
      styles: true,
      scripts: false,
      images: true,
      fonts: true,
      screenshot: false,
      tokens: false,
      metadata: true,
      logs: false,
      rawSources: false,
      perf: false,
    },
  },
  {
    value: 'archive',
    label: 'Raw archive',
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
      rawSources: true,
      perf: false,
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
  const { pick, error: pickerError } = usePicker();
  const {
    preview,
    running: previewRunning,
    error: previewError,
  } = usePreview();
  const [mode, setMode] = useState<'page' | 'element'>('page');

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
          <img
            src={chrome.runtime.getURL('icons/icon-96.png')}
            alt=""
            className="h-[18px] w-[18px] rounded-[5px]"
          />
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

        <Section
          title="Also include"
          collapsible
          summary={`${EXTRA_TOGGLES.filter(({ key }) => settings.include[key]).length}/${EXTRA_TOGGLES.length}`}
        >
          <div className="-mx-[6px]">
            {EXTRA_TOGGLES.map(({ key, label, hint }) => (
              <Checkbox
                key={key}
                id={`include-${key}`}
                label={label}
                {...(hint ? { hint } : {})}
                checked={settings.include[key]}
                onChange={(checked) => setInclude(key, checked)}
                {...(key === 'screenshot'
                  ? {
                      trailing: (
                        <button
                          type="button"
                          onClick={(event) => {
                            // A trailing button inside the row's <label>
                            // would otherwise also toggle the checkbox it
                            // sits in.
                            event.preventDefault();
                            event.stopPropagation();
                            void preview();
                          }}
                          disabled={previewRunning}
                          className="cursor-pointer rounded-[var(--radius-control)] px-[7px] py-[3px] text-[11px] font-medium text-[var(--accent)] transition-colors duration-[var(--duration-fast)] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] disabled:cursor-default disabled:opacity-60"
                        >
                          {previewRunning ? 'Previewing…' : 'Preview'}
                        </button>
                      ),
                    }
                  : {})}
              />
            ))}
          </div>
        </Section>

        <Section
          title="Advanced"
          collapsible
          summary={`${OPTION_TOGGLES.filter(({ key }) => settings[key]).length}/${OPTION_TOGGLES.length}`}
        >
          <div className="-mx-[6px]">
            {OPTION_TOGGLES.map(({ key, label, hint }) => (
              <Checkbox
                key={key}
                id={`option-${key}`}
                label={label}
                hint={hint}
                checked={settings[key]}
                onChange={(checked) => setOption(key, checked)}
              />
            ))}
            <TextField
              id="filename-template"
              label="Filename template"
              hint="Tokens: {host} {date} {time} {timestamp}"
              placeholder="{host}-{timestamp}"
              value={settings.filenameTemplate}
              onChange={(value) => update({ filenameTemplate: value })}
            />
            <TextField
              id="exclude-selector"
              label="Exclude selector"
              hint="CSS selector for elements to drop before capture"
              placeholder=".cookie-banner, #chat-widget"
              value={settings.excludeSelector}
              onChange={(value) => update({ excludeSelector: value })}
            />
          </div>
        </Section>
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
        <div
          role="tablist"
          aria-label="Capture mode"
          className="flex gap-[2px] rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-raised)] p-[2px]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'page'}
            onClick={() => setMode('page')}
            className={`flex-1 cursor-pointer rounded-[calc(var(--radius-control)-2px)] px-3 py-[6px] text-[12px] font-medium transition-colors duration-[var(--duration-fast)] ${
              mode === 'page'
                ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Full page
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'element'}
            onClick={() => setMode('element')}
            className={`flex-1 cursor-pointer rounded-[calc(var(--radius-control)-2px)] px-3 py-[6px] text-[12px] font-medium transition-colors duration-[var(--duration-fast)] ${
              mode === 'element'
                ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Pick element…
          </button>
        </div>

        {mode === 'page' ? (
          <CaptureButton running={running} onClick={() => void start()} />
        ) : (
          <button
            type="button"
            onClick={() => void pick()}
            disabled={running}
            className="flex w-full cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-[9px] text-[13px] font-medium text-white transition-all duration-[var(--duration-fast)] hover:bg-[var(--accent-hover)] active:scale-[0.985] disabled:cursor-default disabled:opacity-70 disabled:active:scale-100"
          >
            Choose element…
          </button>
        )}

        {mode === 'element' ? (
          <p className="text-[11px] text-[var(--text-secondary)]">
            Hover the page to highlight, click to select, then confirm in the
            bar that appears. Esc cancels.
          </p>
        ) : null}

        {pickerError ? (
          <p role="alert" className="text-[11.5px] text-[var(--error)]">
            {pickerError}
          </p>
        ) : null}

        {previewError ? (
          <p role="alert" className="text-[11.5px] text-[var(--error)]">
            {previewError}
          </p>
        ) : null}

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
                  {formatSize(result.byteLength)} saved to Downloads
                </p>
              </div>
            </div>
            <WarningList warnings={result.warnings} />
          </section>
        ) : null}
      </div>

      <div className="flex flex-col gap-[10px] border-t border-[var(--border)] pt-[10px]">
        <RecentList entries={entries} />
        <Section title="Compare captures" collapsible>
          <CompareCaptures />
        </Section>
      </div>
    </main>
  );
}
