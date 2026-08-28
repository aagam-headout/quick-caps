/**
 * Opened once, in a new tab, the moment the extension is installed (see
 * chrome.runtime.onInstalled in src/background/index.ts). Its only job is to
 * say what QuickCaps will ask permission for and why, before Chrome's native
 * permission dialog shows up unexplained on the first capture. It does not
 * request anything itself - chrome.permissions.request needs a user gesture
 * inside the popup, which is where that request already lives.
 */

const ACCESS_ITEMS = [
  {
    title: "The page you're on, when you click Capture",
    body: "Chrome will ask for permission to that page (or all sites, if you choose “always allow”). We use it only to fetch that page's own HTML, CSS, JavaScript, images, and fonts - the same things your browser already loaded to show it to you.",
  },
  {
    title: 'Downloads',
    body: 'To save the finished capture straight to your Downloads folder, and let you reopen it from the Recent list.',
  },
  {
    title: 'Storage',
    body: 'To remember your settings and capture history on this device. Nothing is synced anywhere we run.',
  },
];

const NOT_ACCESS_ITEMS = [
  'Nothing is uploaded. Every capture is written straight to your disk.',
  'No browsing history, no analytics, no accounts.',
  "No access to a page you haven't asked to capture.",
];

// Matches manifest.config.ts's commands['capture-page'].suggested_key.
// Spelled out instead of platform glyphs (⌘⇧) so it reads clearly either way.
const isMac =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const SHORTCUT_KEYS = isMac
  ? ['Command', 'Shift', 'U']
  : ['Ctrl', 'Shift', 'U'];

const FEATURE_ITEMS = [
  {
    title: 'Right-click menu',
    body: '“Capture page with QuickCaps” on any page’s right-click menu does the same thing.',
  },
  {
    title: 'Pick just one element',
    body: 'Switch to “Pick element” in the popup, then click anything on the page to capture only that.',
  },
  {
    title: 'Presets',
    body: 'Everything, Page only, Design audit, Quick capture, Raw archive - pick one instead of tuning checkboxes by hand.',
  },
];

function Check() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      className="mt-[2px] h-[13px] w-[13px] shrink-0 text-[#22c55e]"
    >
      <path
        d="M3 7.3 5.6 9.9 11 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Bolt() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      className="mt-[2px] h-[13px] w-[13px] shrink-0 text-[var(--accent)]"
    >
      <path
        d="M7.5 1.5 3 8h3l-.5 4.5L11 6H8l-.5-4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-[3px]">
      {keys.map((key, index) => (
        <kbd
          key={index}
          className="rounded-[5px] border border-[var(--border)] bg-[var(--surface)] px-[6px] py-[2px] font-mono text-[11.5px] font-medium text-[var(--text-primary)] shadow-[0_1px_0_var(--border)]"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Cross() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      className="mt-[2px] h-[13px] w-[13px] shrink-0 text-[#ef4444]"
    >
      <path
        d="M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[780px] flex-col gap-[var(--space-5)] px-[var(--space-4)] py-[var(--space-5)]">
      <header className="flex items-center gap-[var(--space-2)]">
        <img
          src={chrome.runtime.getURL('icons/icon-96.png')}
          alt=""
          className="h-[28px] w-[28px] rounded-[7px]"
        />
        <div>
          <h1 className="text-[16px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
            Welcome to QuickCaps
          </h1>
          <p className="text-[13px] text-[var(--text-secondary)]">
            Save a page&rsquo;s HTML, CSS, JS, images, and fonts to your own
            disk.
          </p>
        </div>
      </header>

      <section className="flex flex-col gap-[var(--space-3)]">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)]">
          What we&rsquo;ll ask to access, and why
        </h2>
        <div className="flex flex-col gap-[var(--space-3)]">
          {ACCESS_ITEMS.map((item) => (
            <div
              key={item.title}
              className="flex items-start gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-raised)] p-[var(--space-3)]"
            >
              <Check />
              <div>
                <p className="text-[13px] font-medium text-[var(--text-primary)]">
                  {item.title}
                </p>
                <p className="text-[12.5px] leading-[1.5] text-[var(--text-secondary)]">
                  {item.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-[var(--space-2)]">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)]">
          What we don&rsquo;t do
        </h2>
        <div className="flex flex-col gap-[var(--space-1)]">
          {NOT_ACCESS_ITEMS.map((line) => (
            <div key={line} className="flex items-start gap-[var(--space-2)]">
              <Cross />
              <p className="text-[12.5px] leading-[1.5] text-[var(--text-secondary)]">
                {line}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-[var(--space-2)]">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)]">
          A few things worth knowing
        </h2>

        <div className="flex items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,var(--surface))] p-[var(--space-3)]">
          <div>
            <p className="text-[13px] font-medium text-[var(--text-primary)]">
              Keyboard shortcut
            </p>
            <p className="text-[12.5px] leading-[1.5] text-[var(--text-secondary)]">
              Capture any page without opening the popup.
            </p>
          </div>
          <Kbd keys={SHORTCUT_KEYS} />
        </div>

        <div className="flex flex-col gap-[var(--space-2)]">
          {FEATURE_ITEMS.map((item) => (
            <div
              key={item.title}
              className="flex items-start gap-[var(--space-2)]"
            >
              <Bolt />
              <p className="text-[12.5px] leading-[1.5] text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">
                  {item.title}.
                </span>{' '}
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <p className="text-[12px] text-[var(--text-secondary)]">
        The permission prompt itself only appears the first time you click
        Capture, and only for the site you&rsquo;re on - not now.
      </p>

      <div className="sticky bottom-0 -mx-[var(--space-4)] mt-auto bg-[var(--surface)] px-[var(--space-4)] pb-[var(--space-5)] pt-[var(--space-3)]">
        <button
          type="button"
          autoFocus
          onClick={() => window.setTimeout(() => window.close(), 500)}
          className="pc-onboarding-cta pc-ripple w-full cursor-pointer rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-[9px] text-[13px] font-medium text-white transition-colors duration-[var(--duration-fast)] hover:bg-[var(--accent-hover)]"
        >
          Got it
        </button>
      </div>
    </main>
  );
}
