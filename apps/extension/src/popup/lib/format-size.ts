/** KB below 1 MB, MB above - shared by the Recent list and the just-finished
 * capture panel so a size reads the same way everywhere in the popup. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
