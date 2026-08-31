// Narrow subpath, not the root barrel - see background/chrome-driver.ts.
import type { CaptureSettings } from 'quick-caps-core/settings';

/** Id the dynamic registration is reconciled under. */
export const RECORDER_SCRIPT_ID = 'quick-caps-recorder';

/**
 * The recorder, registered from here rather than from the manifest.
 *
 * It has to run in the MAIN world at document_start (see recorder.ts: patching
 * the ISOLATED world's console and fetch would observe nothing the page does),
 * and a MAIN-world script has no chrome.* at all - so it cannot read a setting
 * and decide for itself whether to install. Registration is therefore the only
 * place the decision can be made, which is why a static manifest entry was
 * replaced by this: with every consuming setting off, no script is registered
 * and a page the user merely visits is not touched.
 *
 * `matches` is the broadest pattern, but a dynamically registered script only
 * ever injects where the extension actually holds a *granted* host permission -
 * verified against Chrome, unlike a manifest content_scripts entry, whose match
 * pattern is its own grant. So the effective reach is the optional <all_urls>
 * grant (or the single-origin fallback) the user gave at capture time,
 * intersected with this toggle.
 */
const RECORDER_SCRIPT: chrome.scripting.RegisteredContentScript = {
  id: RECORDER_SCRIPT_ID,
  matches: ['<all_urls>'],
  // Flat filename: built by vite.recorder.config.ts, the same way the injected
  // collector and picker are, because a registered script's js entries cannot
  // resolve module specifiers.
  js: ['recorder.js'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  // Kept across browser restarts so observation does not depend on the service
  // worker waking before the first page of a session loads.
  persistAcrossSessions: true,
};

/**
 * Whether anything the user asked for actually consumes what the recorder
 * observes. The three flags are exactly runCollector's three readers: the log
 * ring, the vitals the perf report needs, and the recording the data report
 * reads. Nothing else in a capture looks at it, so nothing else justifies
 * patching a page.
 */
export function recorderIsWanted(settings: CaptureSettings): boolean {
  const { logs, perf, data } = settings.include;
  return logs || perf || data;
}

/**
 * Brings the dynamic registration in line with the settings - registering when
 * a consumer is switched on, unregistering when the last one goes off.
 *
 * Reconciled against what is actually registered rather than tracked in a
 * variable: the registration outlives the service worker (and the browser
 * session), so the worker cannot assume it knows the current state.
 */
export async function syncRecorderRegistration(
  settings: CaptureSettings,
): Promise<void> {
  const wanted = recorderIsWanted(settings);
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const present = registered.some(
      (script) => script.id === RECORDER_SCRIPT_ID,
    );
    if (wanted === present) return;
    if (wanted) {
      await chrome.scripting.registerContentScripts([RECORDER_SCRIPT]);
    } else {
      // Only ever the recorder's own id: another id here would be someone
      // else's registration, and unregistering a script that does not exist
      // throws.
      await chrome.scripting.unregisterContentScripts({
        ids: [RECORDER_SCRIPT_ID],
      });
    }
  } catch (error) {
    // Logged rather than swallowed - it is the only visible trace, and it
    // decides whether the log/perf/data toggles produce anything. It must not
    // throw: this runs from lifecycle listeners with no caller to report to,
    // and a capture without observations is still a capture.
    console.warn('Quick-Caps: could not sync the recorder registration', error);
  }
}
