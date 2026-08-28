/**
 * The click-to-pick element tool: injected on demand (see picker-entry.ts)
 * when the user clicks "Pick element" in the popup. Lets them hover to
 * highlight an element on the page, click to select it, then confirm a
 * one-element capture — no CSS knowledge required.
 */

/**
 * A selector that finds `el` again via `document.querySelector`, independent
 * of the page's own ids/classes.
 *
 * An id short-circuits the climb since ids are meant to be unique. Otherwise
 * builds a `tag:nth-child(n)` path from `el` up to (but not including)
 * `<body>` — unique for any DOM regardless of what the page itself names
 * things.
 */
export function computeSelector(el: Element): string {
  if (el.id) {
    const escaped =
      typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
    return `#${escaped}`;
  }

  const steps: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && node.parentElement) {
    const parent: Element = node.parentElement;
    const index = Array.from(parent.children).indexOf(node) + 1;
    steps.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
    node = parent;
  }
  return steps.length > 0 ? steps.join(' > ') : el.tagName.toLowerCase();
}

/**
 * A short, human-readable label for the confirm bar — the full
 * `computeSelector` path is exact but unreadable at a glance
 * (`div:nth-child(6) > div:nth-child(1) > ...`). Shown to the user; the
 * precise selector still does the actual work and rides along as a tooltip.
 */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const firstClass =
    typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return firstClass ? `${tag}.${firstClass}` : tag;
}

const HIGHLIGHT_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  pointerEvents: 'none',
  zIndex: '2147483647',
  border: '2px solid #4f8cff',
  background: 'rgba(79,140,255,0.15)',
  boxSizing: 'border-box',
};

const BAR_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  left: '50%',
  bottom: '20px',
  transform: 'translateX(-50%)',
  zIndex: '2147483647',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  maxWidth: 'min(92vw, 420px)',
  padding: '8px 8px 8px 14px',
  borderRadius: '999px',
  background: '#1e1e1ef2',
  color: '#f2f2f2',
  font: '13px/1.4 -apple-system,system-ui,sans-serif',
  boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
  border: '1px solid rgba(255,255,255,0.08)',
};

const LABEL_STYLE: Partial<CSSStyleDeclaration> = {
  flex: '1 1 auto',
  minWidth: '0',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '12px',
  color: '#c9c9c9',
};

function button(
  label: string,
  variant: 'primary' | 'secondary',
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  Object.assign(el.style, {
    cursor: 'pointer',
    border: 'none',
    borderRadius: '999px',
    padding: '6px 12px',
    background: variant === 'primary' ? '#4f8cff' : 'rgba(255,255,255,0.1)',
    color: variant === 'primary' ? '#fff' : '#f2f2f2',
    font: 'inherit',
    fontWeight: variant === 'primary' ? '600' : '500',
    whiteSpace: 'nowrap',
    flexShrink: '0',
  } satisfies Partial<CSSStyleDeclaration>);
  return el;
}

export type PickerDeps = {
  onCapture: (selector: string) => void;
};

/**
 * Wires up the hover-highlight-and-click flow. Returns a teardown function;
 * also tears itself down on Escape or after a capture is confirmed.
 */
export function installPicker(deps: PickerDeps): () => void {
  const highlight = document.createElement('div');
  Object.assign(highlight.style, HIGHLIGHT_STYLE);

  const bar = document.createElement('div');
  Object.assign(bar.style, BAR_STYLE);
  const label = document.createElement('span');
  Object.assign(label.style, LABEL_STYLE);
  const captureButton = button('Capture', 'primary');
  const pickAgainButton = button('Retry', 'secondary');
  const cancelButton = button('Cancel', 'secondary');
  const actions = document.createElement('div');
  Object.assign(actions.style, {
    display: 'flex',
    gap: '6px',
    flexShrink: '0',
  } satisfies Partial<CSSStyleDeclaration>);
  actions.append(captureButton, pickAgainButton, cancelButton);
  bar.append(label, actions);
  bar.style.display = 'none';

  let hovered: Element | null = null;
  let picked: Element | null = null;

  function place(target: Element): void {
    const rect = target.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function onMove(event: MouseEvent): void {
    if (picked) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target === highlight || bar.contains(target)) return;
    hovered = target;
    place(target);
  }

  function onClick(event: MouseEvent): void {
    if (picked) return;
    if (bar.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!hovered) return;
    picked = hovered;
    place(picked);
    label.textContent = describeElement(picked);
    label.title = computeSelector(picked);
    bar.style.display = 'flex';
  }

  function pickAgain(): void {
    picked = null;
    bar.style.display = 'none';
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') cleanup();
  }

  /**
   * `place` reads viewport-relative coordinates, which only stay correct
   * until the next scroll — highlight and target drift apart otherwise,
   * scroll-only, no mouse movement, until the mouse moves again. Re-running
   * it on every scroll (capture phase, so a scroll inside a nested
   * container is caught too, not just window/document scrolling) keeps the
   * box glued to whichever element is current.
   */
  function onScroll(): void {
    const target = picked ?? hovered;
    if (target) place(target);
  }

  function cleanup(): void {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    highlight.remove();
    bar.remove();
  }

  captureButton.addEventListener('click', () => {
    if (!picked) return;
    deps.onCapture(computeSelector(picked));
    cleanup();
  });
  pickAgainButton.addEventListener('click', pickAgain);
  cancelButton.addEventListener('click', cleanup);

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onScroll);
  document.body.appendChild(highlight);
  document.body.appendChild(bar);

  return cleanup;
}
