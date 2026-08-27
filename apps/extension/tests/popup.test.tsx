import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/popup/App.js';

type Listener = (message: unknown) => void;

let listeners: Listener[];
let posted: unknown[];
let sync: Record<string, unknown>;
let local: Record<string, unknown>;
let contains: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listeners = [];
  posted = [];
  sync = {};
  local = { history: [] };
  contains = vi.fn().mockResolvedValue(true);
  request = vi.fn().mockResolvedValue(true);

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      connect: () => ({
        postMessage: (message: unknown) => posted.push(message),
        disconnect: vi.fn(),
        onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      }),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 5, url: 'https://example.com' }]),
    },
    permissions: { contains, request },
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
      /screenshot/i,
      /Design tokens/,
      /Metadata/,
      /Console \+ network/,
      /Raw network sources/,
      /lazy content/,
      /Inert snapshot/,
    ]) {
      expect(await screen.findByLabelText(label), String(label)).toBeDefined();
    }
  });

  it('offers both output modes as radios', async () => {
    render(<App />);
    expect(
      await screen.findByLabelText(/single self-contained html/i),
    ).toBeDefined();
    expect(screen.getByLabelText(/zip folder/i)).toBeDefined();
  });

  it('persists a toggle change to sync storage', async () => {
    render(<App />);
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

  it('still captures when the permission is declined', async () => {
    contains.mockResolvedValue(false);
    request.mockResolvedValue(false);
    render(<App />);
    await clickCapture();
    await waitFor(() => {
      expect(posted).toContainEqual({
        type: 'capture:start',
        tabId: 5,
        hasHostPermission: false,
      });
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
      },
    ];
    render(<App />);
    await userEvent.click(await screen.findByText(/recent/i));
    expect(
      await screen.findByText('example.com-20260827-100000.html'),
    ).toBeDefined();
  });

  it('applies an explicit theme choice to the document root', async () => {
    render(<App />);
    await userEvent.click(await screen.findByLabelText(/^dark$/i));
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
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
