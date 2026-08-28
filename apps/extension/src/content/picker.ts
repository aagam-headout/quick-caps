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
  bottom: '16px',
  transform: 'translateX(-50%)',
  zIndex: '2147483647',
  display: 'flex',
  gap: '8px',
  padding: '8px 10px',
  borderRadius: '8px',
  background: '#1f1f1f',
  color: '#e6e6e6',
  font: '13px/1.4 system-ui,sans-serif',
  alignItems: 'center',
};

function button(label: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  Object.assign(el.style, {
    cursor: 'pointer',
    border: 'none',
    borderRadius: '6px',
    padding: '5px 10px',
    background: '#333',
    color: '#e6e6e6',
    font: 'inherit',
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
  const captureButton = button('Capture');
  const pickAgainButton = button('Pick again');
  const cancelButton = button('Cancel');
  bar.append(label, captureButton, pickAgainButton, cancelButton);
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
    label.textContent = computeSelector(picked);
    bar.style.display = 'flex';
  }

  function pickAgain(): void {
    picked = null;
    bar.style.display = 'none';
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') cleanup();
  }

  function cleanup(): void {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
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
  document.body.appendChild(highlight);
  document.body.appendChild(bar);

  return cleanup;
}
