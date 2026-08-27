# Chrome Web Store listing — QuickCaps

## Name

QuickCaps

## Short description (max 132 characters)

Save any page's full front-end — HTML, CSS, JS, images, fonts — to your own disk. Nothing is uploaded. (108 chars)

## Full description

QuickCaps saves a web page exactly as your browser rendered it — HTML,
CSS, JavaScript, images, and fonts — into a single self-contained file or zip
archive on your own disk.

Unlike "Save Page As," it captures the *live* DOM: content added by
JavaScript, lazy-loaded images, infinite-scroll sections. Assets are inlined
so the result opens offline, in any browser, with no network request.

**Nothing is uploaded anywhere.** There are no accounts, no analytics, no
telemetry, and no server. The only network request the extension ever makes
is fetching the assets of the page you explicitly choose to capture — and
even that only happens if you grant it permission.

What you get:
- One-click capture from the toolbar icon.
- Choose what to include: styles, scripts, images, fonts, a full-page
  screenshot, extracted design tokens, or the raw network responses before
  JavaScript touched them.
- Single-file `.html` output, or a `.zip` with metadata and logs alongside
  the page.
- Light, dark, or system theme.

Built for anyone who needs an offline, faithful copy of a page: designers
pulling reference material, developers debugging a live site, or anyone
archiving something before it changes or disappears.

## Category

Developer Tools

## Single purpose statement

QuickCaps's single purpose is to save the currently open web page's
rendered front-end — its DOM, styles, scripts, and assets — to a file on the
user's local disk.

## Permission justifications

- **`activeTab`** — grants temporary access to the page the user is looking
  at only when they click the extension icon, so the capture can read that
  tab's DOM without a standing host-permission grant.
- **`scripting`** — injects the small script that reads the page's DOM and
  scrolls it to materialize lazy-loaded content, and runs it in the page's
  context to build the capture.
- **`storage`** — saves the user's own settings (which toggles are on,
  output format, theme) and a short local history of past captures (filename
  and time only), entirely on-device.
- **`downloads`** — saves the finished capture file to the user's Downloads
  folder; this is the extension's entire output.
- **`downloads.open`** — lets a click on a past capture in the popup's
  Recent list open that file directly, instead of only revealing it in its
  folder.
- **`offscreen`** — runs the archive-building step (assembling the zip or
  single-file blob) in an offscreen document, since a Manifest V3 service
  worker cannot use the Blob/DOM APIs that step needs.
- **`<all_urls>` (optional, requested at capture time, not at install)** —
  lets the extension fetch a page's own cross-origin assets (stylesheets,
  fonts, scripts served from a different domain) on the user's behalf,
  because the page's own JavaScript is blocked from reading those by CORS.
  Requested only when the user clicks Capture on a page that needs it, with
  an in-popup explanation; declining is fully supported and the capture
  proceeds with those assets skipped and a warning shown.

## Privacy policy

See [`PRIVACY.md`](../../PRIVACY.md) at the repository root — captures stay
on the user's machine, the extension makes no network request except to
fetch the assets of the page being captured, and no data is collected or
transmitted.

## Assets

- Icons: `apps/extension/public/icons/icon-{16,32,48,128}.png` (shipped in the extension)
- Larger masters (not shipped, for the store listing / future high-DPI use): `docs/store/icon-{256,512}.png`
- Promo tile (1280×800): `docs/store/promo-tile.png`
- Screenshot: `docs/store/screenshot-popup.png`
