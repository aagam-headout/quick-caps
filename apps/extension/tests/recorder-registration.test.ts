import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSettings } from 'quick-caps-core/settings';
import {
  RECORDER_SCRIPT_ID,
  recorderIsWanted,
  syncRecorderRegistration,
} from '../src/background/recorder-registration.js';

type Registered = { id: string } & Record<string, unknown>;

let scripts: Registered[];
let scripting: {
  getRegisteredContentScripts: ReturnType<typeof vi.fn>;
  registerContentScripts: ReturnType<typeof vi.fn>;
  unregisterContentScripts: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  scripts = [];
  scripting = {
    getRegisteredContentScripts: vi.fn(async () => [...scripts]),
    registerContentScripts: vi.fn(async (added: Registered[]) => {
      scripts.push(...added);
    }),
    unregisterContentScripts: vi.fn(async (filter: { ids: string[] }) => {
      scripts = scripts.filter((script) => !filter.ids.includes(script.id));
    }),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { scripting };
});

/** Stored settings with only the named include flags turned on. */
function settingsWith(include: Record<string, boolean>) {
  return parseSettings({ include });
}

describe('recorderIsWanted', () => {
  it('is false for default settings, where nothing consumes the recorder', () => {
    expect(recorderIsWanted(parseSettings({}))).toBe(false);
  });

  // One per consumer named in collector.ts's runCollector: the log ring, the
  // vitals the perf report needs, and the recording the data report reads.
  it.each(['logs', 'perf', 'data'])('is true when include.%s is on', (flag) => {
    expect(recorderIsWanted(settingsWith({ [flag]: true }))).toBe(true);
  });

  it('is false when only settings nothing to do with observation are on', () => {
    expect(
      recorderIsWanted(settingsWith({ screenshot: true, tokens: true })),
    ).toBe(false);
  });
});

describe('syncRecorderRegistration', () => {
  it('registers nothing while every consuming setting is off', async () => {
    await syncRecorderRegistration(parseSettings({}));

    expect(scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(scripts).toEqual([]);
  });

  it('registers the recorder in the main world at document_start when asked', async () => {
    await syncRecorderRegistration(settingsWith({ logs: true }));

    expect(scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(scripts).toEqual([
      {
        id: RECORDER_SCRIPT_ID,
        matches: ['<all_urls>'],
        js: ['recorder.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  });

  it('unregisters the recorder once the last consuming setting goes off', async () => {
    await syncRecorderRegistration(settingsWith({ logs: true }));
    await syncRecorderRegistration(parseSettings({}));

    expect(scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: [RECORDER_SCRIPT_ID],
    });
    expect(scripts).toEqual([]);
  });

  it('does not re-register a recorder that is already registered', async () => {
    await syncRecorderRegistration(settingsWith({ logs: true }));
    await syncRecorderRegistration(settingsWith({ perf: true }));

    expect(scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(scripts).toHaveLength(1);
  });

  it('does not unregister a recorder that was never registered', async () => {
    await syncRecorderRegistration(parseSettings({}));

    expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it('leaves another extension registration of its own alone', async () => {
    scripts.push({ id: 'something-else' });
    await syncRecorderRegistration(parseSettings({}));

    expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
    expect(scripts).toHaveLength(1);
  });

  it('survives a scripting API that rejects', async () => {
    scripting.registerContentScripts.mockRejectedValue(new Error('nope'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      syncRecorderRegistration(settingsWith({ logs: true })),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
