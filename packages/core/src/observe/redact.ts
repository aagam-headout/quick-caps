/**
 * Credential redaction for recorded traffic.
 *
 * Pure, and called at *record* time rather than render time: `.quick-caps/` is
 * gitignored, not encrypted, and its whole purpose is to be read into an
 * agent's context. If a live session token can reach disk it can reach a log,
 * a bug report, or a model prompt by accident — so the host runs a recording
 * through here on the way to `session.json`, and the default path never has a
 * credential to leak.
 */

import type { Recording, RecordedRequest } from './types.js';

/** Deliberately not an empty string: a caller reading a recording has to be
 * able to tell "this header was removed" from "this header was absent". */
export const REDACTED = '[redacted]';

/** Normalizes a header or parameter name for matching: case and separators
 * carry no meaning here, and `X-Auth-Token`, `x_auth_token`, and `xauthtoken`
 * are the same name for redaction's purposes. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Names that are a credential whatever else they contain — matched as
 * substrings, because the space of prefixes and vendor spellings
 * (`x-amz-security-token`, `githubToken`, `apiSecret`) is open-ended and
 * enumerating it would guarantee a miss.
 *
 * Every entry here is long and specific enough that a substring match is not a
 * gamble. `auth` is not in this list on purpose: it would redact `author`.
 */
const SENSITIVE_SUBSTRINGS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'accesskey',
  'sessionid',
  'credential',
  'signature',
  'authorization',
  'authentication',
  'cookie',
];

/**
 * Names that are a credential only when they are the *whole* name. `key`,
 * `code`, and `sig` are genuine credential parameters in the wild (a Maps API
 * key, an OAuth authorization code, a signed-URL signature) and are also
 * common words, so they get exact matching rather than substring matching.
 */
const SENSITIVE_EXACT = new Set([
  'auth',
  'key',
  'code',
  'sig',
  'jwt',
  'bearer',
  'pwd',
  'otp',
  'session',
  'sid',
]);

function isSensitiveName(name: string): boolean {
  const flat = normalize(name);
  if (SENSITIVE_EXACT.has(flat)) return true;
  return SENSITIVE_SUBSTRINGS.some((needle) => flat.includes(needle));
}

// ---------------------------------------------------------------------------
// Cookies: the one header family where the value is a credential and the
// structure around it is not.
//
// Blanket-redacting `Set-Cookie` is safe and useless: `stack`'s cookie
// inventory is built out of the name, Domain, Path, Expires/Max-Age, Secure,
// HttpOnly, and SameSite attributes, none of which is a secret, so replacing
// the whole header value with the marker left that inventory permanently
// empty on the default path. What has to go is the cookie's *value*; what has
// to stay is everything else.
//
// The parsers below fail closed. Anything they cannot confidently split into
// `name=value` collapses to the marker, because a mis-split leaks a secret
// under a name we invented, and an over-redacted header only costs inventory.
// ---------------------------------------------------------------------------

/** Replaces one cookie value, keeping the shape of what was there.
 *
 * An *empty* value is returned as observed: there is nothing to hide, and
 * `session=;` is how a server deletes a cookie — writing a marker in would
 * both fabricate a value and hide the deletion. A quoted value keeps its
 * quotes, since RFC 6265 makes them part of the syntax rather than part of
 * the secret. */
function redactCookieValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return raw;
  if (trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return `"${REDACTED}"`;
  }
  return REDACTED;
}

/**
 * One `Set-Cookie` line: `name=value` followed by `; Attr` pairs.
 *
 * The name/value pair is everything before the first `;` — RFC 6265 forbids a
 * bare `;` inside a cookie value, including a quoted one, so this split is
 * safe without tracking quote state. Within the pair the *first* `=` divides
 * name from value, so a value containing `=` (base64 padding, a signed
 * cookie) is redacted whole rather than half-kept. The attribute tail is
 * copied through byte-for-byte: `Expires=Wed, 09 Sep 2026 …` must survive
 * intact, and it is not ours to normalize.
 */
function redactSetCookieLine(line: string): string {
  if (line.trim() === '') return line;
  const semi = line.indexOf(';');
  const pair = semi === -1 ? line : line.slice(0, semi);
  const attributes = semi === -1 ? '' : line.slice(semi);
  const eq = pair.indexOf('=');
  // eq === 0 is an empty name, eq === -1 no assignment at all. Either way we
  // are not looking at a cookie we can describe, so nothing is preserved.
  if (eq <= 0 || pair.slice(0, eq).trim() === '') return REDACTED;
  return `${pair.slice(0, eq)}=${redactCookieValue(pair.slice(eq + 1))}${attributes}`;
}

/**
 * The request `Cookie` header: `name=value` pairs joined by `;`, with no
 * attributes. The names are inventory — which session, which analytics
 * vendor, whether consent was recorded — and are not themselves credentials,
 * so they are kept and every value is replaced.
 *
 * A segment with content but no `=` means we cannot tell a name from a value
 * anywhere in this header, so the whole header collapses. An empty segment (a
 * trailing `; `) carries neither and is passed through.
 */
function redactCookieHeaderLine(line: string): string {
  const parts = line.split(';');
  const out: string[] = [];
  for (const part of parts) {
    if (part.trim() === '') {
      out.push(part);
      continue;
    }
    const eq = part.indexOf('=');
    if (eq <= 0 || part.slice(0, eq).trim() === '') return REDACTED;
    out.push(`${part.slice(0, eq)}=${redactCookieValue(part.slice(eq + 1))}`);
  }
  return out.join(';');
}

/** Applies a per-line redactor across a header value that may carry repeats.
 * A header map collapses repeated `Set-Cookie` headers onto newline-separated
 * lines (`extract/stack.ts` splits them back apart the same way), and one
 * unparseable line must not cost the others — so `[^\r\n]+` rewrites each run
 * of non-newline text in place, leaving the separators exactly as observed. */
function perLine(value: string, redactLine: (line: string) => string): string {
  return value.replace(/[^\r\n]+/g, redactLine);
}

/** Returns a fresh map with every credential-bearing value replaced. Header
 * names are preserved exactly as observed — the name is evidence, only the
 * value is dangerous.
 *
 * The two cookie headers are matched on their *exact* normalized name rather
 * than the `cookie` substring that sends them down the blanket path: a
 * vendor's `X-Cookie-Hash` is not a cookie header and gets no structural
 * treatment it did not earn. */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const flat = normalize(name);
    if (flat === 'setcookie') out[name] = perLine(value, redactSetCookieLine);
    else if (flat === 'cookie')
      out[name] = perLine(value, redactCookieHeaderLine);
    else out[name] = isSensitiveName(name) ? REDACTED : value;
  }
  return out;
}

/**
 * Redacts token-bearing query parameters and any userinfo in the URL itself.
 *
 * This is the case most often missed. A token in a header is the one everybody
 * remembers; `?access_token=` is just as live, survives copy-paste far more
 * easily, and is what an agent quoting a request URL will actually paste.
 *
 * Path and fragment are left alone: a path segment is structure, not a
 * key-value pair, and rewriting one would break the URL a caller means to
 * reproduce. An unparseable URL is returned unchanged rather than throwing —
 * the same stance the rest of the codebase takes on a malformed URL.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  let touched = false;
  for (const name of [...parsed.searchParams.keys()]) {
    if (!isSensitiveName(name)) continue;
    parsed.searchParams.set(name, REDACTED);
    touched = true;
  }

  // `https://user:pw@host` is a credential in the most quotable position
  // there is. Both halves collapse into one marker rather than keeping the
  // username, which is half a credential.
  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = REDACTED;
    parsed.password = '';
    touched = true;
  }

  // URL.href re-serializes even when nothing matched (percent-encoding,
  // default ports), and a recording should show the URL as observed unless
  // redaction genuinely changed it.
  if (!touched) return url;
  // searchParams.set percent-encodes the marker's brackets; a reader has to
  // recognize the same token here as in a header.
  return parsed.href.replace(/%5Bredacted%5D/g, REDACTED);
}

/**
 * Redacts credentials echoed inside a kept body — a JSON `"access_token":
 * "…"` field or a form-encoded `password=…` pair. Narrowly scoped to those two
 * shapes on purpose: a body is data the caller asked for, and a broader rewrite
 * would corrupt payloads to chase a case the two forms above already cover.
 */
function redactBodyText(text: string): string {
  // Alternatives inside the star are disjoint, so this matches a JSON string
  // in linear time rather than backtracking over it.
  const json = text.replace(
    /("(?:[^"\\]|\\.)*"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (match, prefix: string) => {
      const name = prefix.slice(0, prefix.lastIndexOf('"'));
      return isSensitiveName(name) ? `${prefix}"${REDACTED}"` : match;
    },
  );
  // The form-encoded pass is gated on the body not being JSON: `=` appears
  // inside JSON string values often enough that running both over one body
  // would corrupt payloads to catch a case the pass above already caught.
  const head = json.trimStart().charAt(0);
  if (head === '{' || head === '[') return json;
  return json.replace(
    /(^|[?&])([^=&\s]+)=([^&\s]*)/g,
    (match, lead: string, name: string) =>
      isSensitiveName(name) ? `${lead}${name}=${REDACTED}` : match,
  );
}

/**
 * One recorded request, safe to write. Every field a caller reasons about —
 * method, status, resource type, timing, transfer size, skip reason — is
 * carried through untouched; only credential values change.
 */
export function redactRequest(request: RecordedRequest): RecordedRequest {
  return {
    ...request,
    url: redactUrl(request.url),
    requestHeaders: redactHeaders(request.requestHeaders),
    responseHeaders: redactHeaders(request.responseHeaders),
    body: request.body.kept
      ? { ...request.body, text: redactBodyText(request.body.text) }
      : request.body,
  };
}

/**
 * The whole recording, safe to write, with `redacted` set so a later reader
 * never has to guess whether it happened. Pure: the input is left intact, so a
 * host can keep the unredacted recording in memory for the current process
 * while only the redacted form reaches disk.
 *
 * `bodyBytes` is carried through rather than recomputed: it accounts for what
 * the caps were spent on, and redaction shortening a body does not give the
 * session budget back.
 */
export function redactRecording(recording: Recording): Recording {
  return {
    ...recording,
    redacted: true,
    requests: recording.requests.map(redactRequest),
  };
}
