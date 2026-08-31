import { useEffect, useState } from 'react';
import type { CaptureSettings } from 'quick-caps-core';
import { Checkbox } from './components/Checkbox.js';
import { Section } from './components/Section.js';
import { SingleSelectDropdown } from './components/SingleSelectDropdown.js';
import { Progress } from './components/Progress.js';
import { CaptureButton } from './components/CaptureButton.js';
import { WarningList } from './components/WarningList.js';
import { RecentList } from './components/RecentList.js';
import { useSettings } from './use-settings.js';
import { useCapture } from './use-capture.js';
import { useHistory } from './use-history.js';
import { usePicker } from './use-picker.js';
import { usePreview } from './use-preview.js';
import { formatSize } from './lib/format-size.js';

const OpenArrowIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[13px] w-[13px]">
    <path
      d="M7 9 13 3M9 3h4v4M13 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SpinnerIcon = () => (
  <svg
    viewBox="0 0 16 16"
    aria-hidden="true"
    className="pc-spin h-[13px] w-[13px]"
  >
    <circle
      cx="8"
      cy="8"
      r="6.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeDasharray="30 12"
      opacity="0.9"
    />
  </svg>
);

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
    hint: 'One image of the whole page, from top to bottom',
  },
  {
    key: 'tokens',
    label: 'Design tokens (JSON)',
    hint: "The page's colors, fonts, and spacing values, extracted as data",
  },
  {
    key: 'metadata',
    label: 'Metadata',
    hint: 'Basic info about the capture: page URL, time, and settings used',
  },
  {
    key: 'logs',
    label: 'Console + network log',
    hint: 'Only works if the page was open when it loaded',
  },
  {
    key: 'perf',
    label: 'Performance snapshot (JSON)',
    hint: 'Load and rendering timings, a quick gauge, not a full audit',
  },
  {
    key: 'rawSources',
    label: 'Raw network sources',
    hint: "The page's original files as the server sent them, before any JavaScript ran",
  },
];

/** Behavior toggles, shown in Advanced alongside the text fields - merged
 * out of a former "Options" dropdown that only added a second vague bucket
 * next to "Extras" and "Advanced". */
type OptionKey = 'scrollToLoadLazy' | 'inertSnapshot' | 'embedViewer';
const OPTION_TOGGLES: { key: OptionKey; label: string; hint: string }[] = [
  {
    key: 'scrollToLoadLazy',
    label: 'Scroll to load lazy content',
    hint: 'Scrolls the page first, so images that load on scroll get captured too',
  },
  {
    key: 'inertSnapshot',
    label: 'Inert snapshot',
    hint: "Removes scripts so opening the capture later doesn't re-fire analytics or trackers",
  },
  {
    key: 'embedViewer',
    label: 'Embed viewer panel',
    hint: 'Adds a built-in button for browsing the captured data (metadata, tokens, logs, etc.)',
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

/**
 * The three things the button below can do. Page Snap is the screenshot on its
 * own - no archive, no settings - and it is a mode rather than a checkbox
 * because it answers a different question than "what goes in the capture".
 */
type CaptureMode = 'page' | 'element' | 'snap';

const MODE_TABS: { value: CaptureMode; label: string }[] = [
  { value: 'page', label: 'Full page' },
  { value: 'element', label: 'Pick element…' },
  { value: 'snap', label: 'Page Snap' },
];

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
  const [mode, setMode] = useState<CaptureMode>('page');

  // Accordion: at most one of the three sections open at a time, so opening
  // one for a better look at it doesn't leave the others' checkboxes
  // scrolled halfway off. "Page contents" starts collapsed like the rest - a
  // new user's path is preset -> capture, not five checkboxes - but auto-
  // opens the moment the selection stops matching any preset, since that
  // only happens because the user is already mid-edit; a manual collapse
  // afterwards still wins.
  const isCustom = matchingPreset(settings.include) === '';
  const [openSection, setOpenSection] = useState<
    'page' | 'extras' | 'advanced' | null
  >(isCustom ? 'page' : null);
  useEffect(() => {
    if (isCustom) setOpenSection((current) => current ?? 'page');
  }, [isCustom]);

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
    <main className="flex flex-col gap-[var(--space-4)] p-[var(--space-4)]">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-[7px]">
          <img
            src={chrome.runtime.getURL('icons/icon-96.png')}
            alt=""
            className="h-[18px] w-[18px] rounded-[5px]"
          />
          <h1 className="text-[13px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
            Quick-Caps
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

      <div className="flex flex-col gap-[var(--space-3)]">
        <Section
          title="Page contents"
          collapsible
          summary={`${PAGE_TOGGLES.filter(({ key }) => settings.include[key]).length}/${PAGE_TOGGLES.length}`}
          open={openSection === 'page'}
          onOpenChange={(open) =>
            setOpenSection((current) =>
              open ? 'page' : current === 'page' ? null : current,
            )
          }
        >
          <div>
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
          open={openSection === 'extras'}
          onOpenChange={(open) =>
            setOpenSection((current) =>
              open ? 'extras' : current === 'extras' ? null : current,
            )
          }
        >
          <div>
            {EXTRA_TOGGLES.map(({ key, label, hint }) => (
              <Checkbox
                key={key}
                id={`include-${key}`}
                label={label}
                {...(hint ? { hint } : {})}
                checked={settings.include[key]}
                onChange={(checked) => setInclude(key, checked)}
                // The screenshot row used to carry its own "Preview" button.
                // That action is the Page Snap tab now — one entry point, not
                // two that do the same thing from different places.
                {...(key === 'screenshot'
                  ? {
                      hint: `${hint} · see the Page Snap tab for it on its own`,
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
          open={openSection === 'advanced'}
          onOpenChange={(open) =>
            setOpenSection((current) =>
              open ? 'advanced' : current === 'advanced' ? null : current,
            )
          }
        >
          <div>
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

      <div className="flex flex-col gap-[var(--space-3)]">
        <div
          role="tablist"
          aria-label="Capture mode"
          className="flex gap-[2px] rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-raised)] p-[2px]"
        >
          {MODE_TABS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={`flex-1 cursor-pointer rounded-[calc(var(--radius-control)-2px)] px-2 py-[6px] text-[11.5px] font-medium transition-colors duration-[var(--duration-fast)] ${
                mode === value
                  ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'page' ? (
          <CaptureButton running={running} onClick={() => void start()} />
        ) : mode === 'element' ? (
          <button
            type="button"
            onClick={() => void pick()}
            disabled={running}
            className="flex w-full cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-[9px] text-[13px] font-medium text-white transition-all duration-[var(--duration-fast)] hover:bg-[var(--accent-hover)] active:scale-[0.985] disabled:cursor-default disabled:opacity-70 disabled:active:scale-100"
          >
            Choose element…
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void preview()}
            disabled={previewRunning || running}
            className="flex w-full cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-[9px] text-[13px] font-medium text-white transition-all duration-[var(--duration-fast)] hover:bg-[var(--accent-hover)] active:scale-[0.985] disabled:cursor-default disabled:opacity-70 disabled:active:scale-100"
          >
            {previewRunning ? <SpinnerIcon /> : <OpenArrowIcon />}
            {previewRunning ? 'Taking Page Snap…' : 'Take Page Snap'}
          </button>
        )}

        {mode === 'element' ? (
          <p className="text-[11px] text-[var(--text-secondary)]">
            Hover the page to highlight, click to select, then confirm in the
            bar that appears. Esc cancels.
          </p>
        ) : null}

        {mode === 'snap' ? (
          <p className="text-[11px] text-[var(--text-secondary)]">
            One full-page PNG, top to bottom. Opens in a new tab and saves to
            Downloads/Quick-Caps/previews. No archive, no settings.
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

      <div className="flex flex-col gap-[var(--space-3)] border-t border-[var(--border)] pt-[var(--space-3)]">
        <RecentList entries={entries} />
      </div>
    </main>
  );
}
