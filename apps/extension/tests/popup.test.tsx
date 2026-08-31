/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/popup/App.js';

type Listener = (message: unknown) => void;

let listeners: Listener[];
let disconnectListeners: (() => void)[];
let posted: unknown[];
let sync: Record<string, unknown>;
let local: Record<string, unknown>;
let contains: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;
let downloadsOpen: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listeners = [];
  disconnectListeners = [];
  posted = [];
  sync = {};
  local = { history: [] };
  contains = vi.fn().mockResolvedValue(true);
  request = vi.fn().mockResolvedValue(true);
  downloadsOpen = vi.fn();

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      connect: () => ({
        postMessage: (message: unknown) => posted.push(message),
        disconnect: vi.fn(),
        onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
        // Part of the real Port API: the popup listens for the worker going
        // away so it cannot sit on "Capturing…" forever.
        onDisconnect: {
          addListener: (fn: () => void) => disconnectListeners.push(fn),
        },
      }),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 5, url: 'https://example.com' }]),
    },
    permissions: { contains, request },
    downloads: { open: downloadsOpen },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([{ result: undefined }]),
    },
    storage: {
      sync: {
        get: vi.fn(async (key: string) => ({ [key]: sync[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sync, items);
        }),
      },
      local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
      },
      // The popup subscribes so a capture finishing while it is open refreshes
      // the Recent list.
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
});

// Testing Library only auto-cleans when vitest runs with globals enabled, which
// this project deliberately does not. Without this, every render stacks up and
// queries find duplicates.
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

const emit = (message: unknown): void => {
  for (const listener of listeners) listener(message);
};

const clickCapture = async (): Promise<void> => {
  await userEvent.click(
    await screen.findByRole('button', { name: /capture page/i }),
  );
};

describe('popup', () => {
  it('renders every capture toggle with an associated label', async () => {
    render(<App />);
    for (const label of [
      /HTML \/ DOM/,
      /Stylesheets/,
      /Scripts/,
      /Images/,
      /Fonts/,
    ]) {
      expect(await screen.findByLabelText(label), String(label)).toBeDefined();
    }

    // The rest live inside dropdowns, closed by default.
    await userEvent.click(await screen.findByText(/^Also include/));
    for (const label of [
      /screenshot/i,
      /Design tokens/,
      /Extracted data/,
      /Metadata/,
      /Console \+ network/,
      /Raw network sources/,
    ]) {
      expect(await screen.findByLabelText(label), String(label)).toBeDefined();
    }

    // The behavior toggles that used to live in a separate "Options"
    // dropdown are now Checkboxes inside the "Advanced" section.
    await userEvent.click(await screen.findByText(/^Advanced/));
    for (const label of [/lazy content/, /Inert snapshot/]) {
      expect(await screen.findByLabelText(label), String(label)).toBeDefined();
    }
  });

  it('offers both output modes as radios', async () => {
    render(<App />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^output/i }),
    );
    expect(
      await screen.findByLabelText(/single self-contained html/i),
    ).toBeDefined();
    expect(screen.getByLabelText(/zip folder/i)).toBeDefined();
  });

  it('persists a toggle change to sync storage', async () => {
    render(<App />);
    await userEvent.click(await screen.findByText(/^Also include/));
    await userEvent.click(await screen.findByLabelText(/screenshot/i));
    await waitFor(() => {
      expect(
        (sync['settings'] as { include: { screenshot: boolean } }).include
          .screenshot,
      ).toBe(true);
    });
  });

  it('sends a capture request naming the active tab', async () => {
    render(<App />);
    await clickCapture();
    await waitFor(() => {
      expect(posted).toContainEqual({
        type: 'capture:start',
        tabId: 5,
        hasHostPermission: true,
        hasPageAccess: true,
      });
    });
  });

  it('requests the host permission during the click, not in the worker', async () => {
    contains.mockResolvedValue(false);
    render(<App />);
    await clickCapture();
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    });
  });

  it('reports both grants as absent when everything is declined', async () => {
    contains.mockResolvedValue(false);
    request.mockResolvedValue(false);
    render(<App />);
    await clickCapture();
    await waitFor(() => {
      expect(posted).toContainEqual({
        type: 'capture:start',
        tabId: 5,
        hasHostPermission: false,
        hasPageAccess: false,
      });
    });
  });

  it("falls back to the page's own origin when all_urls is declined", async () => {
    contains.mockResolvedValue(false);
    // Decline <all_urls>, then allow the narrower origin grant.
    request.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<App />);
    await clickCapture();
    await waitFor(() => {
      expect(posted).toContainEqual({
        type: 'capture:start',
        tabId: 5,
        hasHostPermission: false,
        hasPageAccess: true,
      });
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      origins: ['https://example.com/*'],
    });
  });

  it('announces progress in a live region', async () => {
    render(<App />);
    await clickCapture();
    emit({
      type: 'capture:progress',
      progress: {
        phase: 'fetching-assets',
        done: 3,
        total: 10,
        warningCount: 0,
      },
    });
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByText('3/10')).toBeDefined();
  });

  it('shows the filename and warning count when a capture completes', async () => {
    render(<App />);
    await clickCapture();
    emit({
      type: 'capture:done',
      filename: 'example.com-20260827-100000.html',
      byteLength: 2048,
      warnings: [{ phase: 'assets', url: '/x.png', reason: '404' }],
    });
    expect(
      await screen.findByText('example.com-20260827-100000.html'),
    ).toBeDefined();
    expect(screen.getByText(/1 warning/)).toBeDefined();
  });

  it('shows the extracted-data summary when the capture carried one', async () => {
    render(<App />);
    await clickCapture();
    emit({
      type: 'capture:done',
      filename: 'example.com-20260827-100000.html',
      byteLength: 2048,
      warnings: [],
      dataSummary: 'Found: 1 product, price $49.99, 2 authors, 14 links.',
    });
    expect(
      await screen.findByText(/1 product, price \$49\.99, 2 authors, 14 links/),
    ).toBeDefined();
  });

  it('shows a restricted-page failure as an alert', async () => {
    render(<App />);
    await clickCapture();
    emit({
      type: 'capture:failed',
      reason:
        'This page cannot be captured: Chrome does not allow extensions to read Chrome internal pages.',
      recoverable: false,
    });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Chrome internal pages',
    );
  });

  it('re-enables the capture button after a failure', async () => {
    render(<App />);
    const button = await screen.findByRole('button', { name: /capture page/i });
    await clickCapture();
    emit({ type: 'capture:failed', reason: 'boom', recoverable: true });
    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(false);
    });
  });

  it('surfaces an interruption when the worker disconnects mid-capture', async () => {
    render(<App />);
    await clickCapture();
    for (const listener of disconnectListeners) listener();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'interrupted',
    );
    await waitFor(() => {
      expect(
        screen
          .getByRole('button', { name: /capture page/i })
          .hasAttribute('disabled'),
      ).toBe(false);
    });
  });

  it('stays quiet when the port disconnects with no capture running', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /capture page/i });
    for (const listener of disconnectListeners) listener();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when there are no recent captures', async () => {
    render(<App />);
    await userEvent.click(await screen.findByText(/recent/i));
    expect(await screen.findByText(/no captures yet/i)).toBeDefined();
  });

  it('lists recent captures from local storage', async () => {
    local['history'] = [
      {
        url: 'https://example.com/a',
        filename: 'example.com-20260827-100000.html',
        byteLength: 2048,
        warningCount: 0,
        at: Date.UTC(2026, 7, 27, 10, 0, 0),
        downloadId: 42,
      },
    ];
    render(<App />);
    await userEvent.click(await screen.findByText(/recent/i));
    expect(
      await screen.findByText('example.com-20260827-100000.html'),
    ).toBeDefined();
  });

  it('opens a recent capture on click', async () => {
    local['history'] = [
      {
        url: 'https://example.com/a',
        filename: 'example.com-20260827-100000.html',
        byteLength: 2048,
        warningCount: 0,
        at: Date.UTC(2026, 7, 27, 10, 0, 0),
        downloadId: 42,
      },
    ];
    render(<App />);
    await userEvent.click(await screen.findByText(/recent/i));
    await userEvent.click(
      await screen.findByRole('button', {
        name: /open example\.com-20260827-100000\.html/i,
      }),
    );
    expect(downloadsOpen).toHaveBeenCalledWith(42);
  });

  it('disables a recent entry with no known downloadId', async () => {
    local['history'] = [
      {
        url: 'https://example.com/a',
        filename: 'example.com-20260827-100000.html',
        byteLength: 2048,
        warningCount: 0,
        at: Date.UTC(2026, 7, 27, 10, 0, 0),
      },
    ];
    render(<App />);
    await userEvent.click(await screen.findByText(/recent/i));
    expect(
      (
        await screen.findByRole('button', {
          name: /open example\.com-20260827-100000\.html/i,
        })
      ).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('shows a tick for each selected "Also include" item and expands/collapses as an accordion', async () => {
    render(<App />);
    const summary = await screen.findByText(/^Also include/);
    const details = summary.closest('details') as HTMLDetailsElement;
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(await screen.findByLabelText(/Metadata/)).toBeDefined();
    // An accordion pushes content down rather than overlaying it, so
    // collapsing means the <details> itself closes, not the content
    // unmounting — it stays in the DOM either way.
    await userEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it('selecting a Preset closes the dropdown and updates the summary', async () => {
    render(<App />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^preset/i }),
    );
    await userEvent.click(await screen.findByLabelText(/^everything$/i));
    await waitFor(() => {
      expect(screen.queryByLabelText(/^everything$/i)).toBeNull();
    });
    // The legend and the summary are adjacent spans with no whitespace
    // between them, so the computed accessible name is "PresetEverything".
    expect(
      await screen.findByRole('button', { name: /^preset\s*everything/i }),
    ).toBeDefined();
  });

  it('applies an explicit theme choice to the document root', async () => {
    render(<App />);
    await userEvent.click(
      await screen.findByRole('button', { name: /theme/i }),
    );
    await userEvent.click(await screen.findByLabelText(/^dark$/i));
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('swaps the primary button when switching to Pick element mode', async () => {
    render(<App />);
    expect(
      await screen.findByRole('button', { name: /^capture page$/i }),
    ).toBeDefined();
    expect(
      screen.queryByRole('button', { name: /^choose element/i }),
    ).toBeNull();

    await userEvent.click(
      await screen.findByRole('tab', { name: /pick element/i }),
    );
    expect(
      await screen.findByRole('button', { name: /^choose element/i }),
    ).toBeDefined();
    expect(
      screen.queryByRole('button', { name: /^capture page$/i }),
    ).toBeNull();

    await userEvent.click(
      await screen.findByRole('tab', { name: /full page/i }),
    );
    expect(
      await screen.findByRole('button', { name: /^capture page$/i }),
    ).toBeDefined();
  });

  it('injects the picker and closes the popup on Choose element', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<App />);
    await userEvent.click(
      await screen.findByRole('tab', { name: /pick element/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^choose element/i }),
    );
    await waitFor(() => {
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ files: ['picker.js'] }),
      );
      expect(close).toHaveBeenCalled();
    });
  });

  it('the Page Snap tab screenshots without touching the capture settings', async () => {
    render(<App />);
    await userEvent.click(await screen.findByText(/^Also include/));
    const screenshotToggle = (await screen.findByLabelText(
      /screenshot/i,
    )) as HTMLInputElement;
    expect(screenshotToggle.checked).toBe(false);

    await userEvent.click(
      await screen.findByRole('tab', { name: /page snap/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /take page snap/i }),
    );

    // Page Snap is its own action: the "Full-page screenshot" setting governs
    // what rides along with a capture and must stay as the user left it.
    expect(screenshotToggle.checked).toBe(false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.stringContaining('preview') }),
    );
  });

  it('keeps every control keyboard reachable', async () => {
    render(<App />);
    await screen.findByLabelText(/HTML \/ DOM/);
    const focusable = [
      ...document.querySelectorAll<HTMLElement>('input, button, summary'),
    ];
    expect(focusable.length).toBeGreaterThan(10);
    for (const element of focusable) {
      expect(element.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});
