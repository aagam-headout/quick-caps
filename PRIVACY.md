# Privacy Policy — Quick-Caps

**Last updated:** 2026-08-31

Quick-Caps transmits nothing. It makes no network request other than fetching
the assets of the page you explicitly capture, and everything it observes
either stays in the page it came from or lands in a file in your own Downloads
folder.

## What the extension does when you are not capturing

Nothing. Quick-Caps registers no content script of its own, so a page you
merely visit is not read, patched, or measured.

There is one exception, and it is under your control. If you switch on any of
the three settings that need observations gathered _while a page runs_ —
**Console + network log**, **Performance snapshot**, or the **data report** —
Quick-Caps registers a small recorder that Chrome then runs at the start of
every page you load, in pages you have granted it access to. While that
recorder is running it:

- wraps `console.log/info/warn/error/debug`, `fetch` and `XMLHttpRequest` so
  it can note what the page logs and which requests it makes — method, URL,
  status, duration and size. Request and response **bodies are never read**,
  and headers are never recorded.
- starts three `PerformanceObserver`s (layout shift, event timing, largest
  contentful paint) to measure the page's own web vitals.

Every wrapper calls straight through to the original and returns its value
unchanged, so the page behaves exactly as it would without Quick-Caps.

Turn all three settings off and the recorder is unregistered: no wrapping, no
observers, nothing. Turning one on takes effect on a page's **next load** —
nothing can retroactively observe what a page already did — so reload a page
before capturing its log.

## Where observations live

In the page, in memory, in a ring buffer of the most recent 500 entries. It is
per-tab, it is never written to disk on its own, it is never sent anywhere, and
it disappears when you close or navigate the tab.

Observations reach a file only inside a capture you asked for, and only for the
setting that consumes them: the log in **Console + network log**, the vitals in
**Performance snapshot**, the recorded requests in the **data report**.

## What a capture contains

When you click "Capture page" (or use the keyboard shortcut or the right-click
menu), the extension reads the current tab's DOM and, if you have granted the
optional host permission, fetches that page's own cross-origin assets
(stylesheets, fonts, scripts) so they can be inlined. The result is saved to
your Downloads folder as a file you control.

Depending on which settings are on, the capture can also contain:

- **Cookie inventory.** With the data report on, `document.cookie` is read at
  capture time. Cookie **names** and the page's hostname are recorded; **no
  cookie value is ever read or stored**. `HttpOnly` cookies are invisible to
  page JavaScript, so the inventory is partial by construction, and it is
  marked as incomplete in the output rather than presented as the whole list.
- **`data.json`** (a zip entry; the same JSON in an inert
  `<script type="application/json">` block in single-file output), carrying all
  eight extraction domains: structured data, entities, content, design system,
  link graph, **network** (the requests the recorder observed, plus the cookie
  inventory above), **stack** (third-party services inferred locally from
  signatures in the page's own markup and request URLs — no lookup service is
  contacted), and **vitals** (the observed web vitals).
- **`logs.json`** — the console and network ring buffer described above.
- **`perf.json`**, **`metadata.json`**, **`tokens.json`**, **`screenshot.png`**,
  and raw sources, each only when its setting is on.

A capture is a file on your disk. Anything in the list above is in that file,
so treat a capture you share the way you would treat a screenshot of the page
while you were logged in.

## What it does not do

- No analytics, telemetry, or usage tracking of any kind.
- No accounts, sign-in, or user identifiers.
- No remote logging or error reporting.
- No request or response bodies are ever read, and no cookie value is ever
  read.
- Nothing is uploaded anywhere. No captured page, observation, or capture
  history ever leaves your machine, and nothing at all is ever sent to us or
  to a third party. (The one thing that can leave this device is your own
  settings, and only through Chrome's own profile sync — see below.)
- No network request is made to any server operated by us or any third
  party, at any time, for any reason.

## Data stored locally

Two things are stored, both through Chrome's own `storage` API, and neither is
ever sent to us or to any third party:

- **Your settings** (which toggles are on, output format, theme) go in
  `storage.sync`. That means Chrome itself may replicate them to your other
  signed-in Chrome installations through your Google account, the same way it
  syncs bookmarks. Nothing else about them leaves the browser.
- **A short capture history** — filenames and timestamps of your last 50
  captures, for your own reference — goes in `storage.local`, which stays on
  this device.

Uninstalling the extension deletes both.

## Permissions

Every permission the extension requests is used for exactly one purpose, with
no broader access than that purpose needs. Each one is justified individually
in [`docs/store/listing.md`](docs/store/listing.md).

`<all_urls>` is optional and requested at capture time, never at install. It
is what lets a capture fetch the page's own cross-origin assets, and — because
Chrome injects a dynamically registered script only where the extension holds a
granted host permission — it is also the boundary of where the recorder above
can ever run. Declining it is fully supported.

## Changes to this policy

If this policy changes, the date above will change and the new text will
ship with the extension update. The core commitment — nothing leaves your
machine — will not change.

## Contact

Open an issue on the project's repository for any privacy question.
