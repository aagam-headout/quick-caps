/**
 * Encodes bytes as a `data:` URL, for previewing the stitched full-page
 * screenshot in a new tab without going through the offscreen document's
 * blob-URL lifetime (which is scoped to that document staying open).
 *
 * Chunked rather than `String.fromCharCode(...bytes)` in one call - that
 * spreads the whole array onto the call stack, which throws
 * "Maximum call stack size exceeded" on a screenshot of any real size.
 */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE),
    );
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
