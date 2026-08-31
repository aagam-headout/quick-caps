# Privacy Policy — Quick-Caps

**Last updated:** 2026-08-27

Quick-Caps collects nothing, transmits nothing, and makes no network request
other than fetching the assets of the page you explicitly capture.

## What the extension does

When you click "Capture page," the extension reads the current tab's DOM and,
if you've granted the optional permission, fetches that page's own
cross-origin assets (stylesheets, fonts, scripts) so they can be inlined into
the archive. The result is saved to your own Downloads folder as a file you
control.

## What it does not do

- No analytics, telemetry, or usage tracking of any kind.
- No accounts, sign-in, or user identifiers.
- No remote logging or error reporting.
- No data — captured pages, settings, or history — ever leaves your machine.
- No network request is made to any server operated by us or any third
  party, at any time, for any reason.

## Data stored locally

Your settings (which toggles are on, output format, theme) and a short
capture history (filenames and timestamps of your last 50 captures, kept for
your own reference) are stored using Chrome's local `storage` API, on your
device only. Uninstalling the extension deletes this data. None of it is
sent anywhere.

## Permissions

Every permission the extension requests is used for exactly one purpose, with
no broader access than that purpose needs. The full justification for each
permission is in [`docs/store/listing.md`](docs/store/listing.md).

## Changes to this policy

If this policy changes, the date above will change and the new text will
ship with the extension update. The core commitment — nothing leaves your
machine — will not change.

## Contact

Open an issue on the project's repository for any privacy question.
