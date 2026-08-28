import { beforeEach, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

type Entry = typeof import('../src/content/picker.js');

function installPage(html: string): void {
  const { window, document } = parseHTML(html);
  Object.assign(globalThis, { window, document });
}

async function loadEntry(): Promise<Entry> {
  return (await import('../src/content/picker.js')) as Entry;
}

beforeEach(() => {
  // computeSelector is pure and side-effect free, so no vi.resetModules
  // dance is needed between tests here.
});

describe('computeSelector', () => {
  it('uses the id when the element has one', async () => {
    installPage('<html><body><div id="card">Card</div></body></html>');
    const { computeSelector } = await loadEntry();
    expect(computeSelector(document.getElementById('card')!)).toBe('#card');
  });

  it('builds an nth-child path up to (not including) body when there is no id', async () => {
    installPage(
      '<html><body><main><section><p>One</p><p>Two</p></section></main></body></html>',
    );
    const { computeSelector } = await loadEntry();
    const paragraphs = document.querySelectorAll('p');
    expect(computeSelector(paragraphs[1]!)).toBe(
      'main:nth-child(1) > section:nth-child(1) > p:nth-child(2)',
    );
  });

  it('resolves back to the same element via querySelector', async () => {
    installPage(
      '<html><body><ul><li>a</li><li>b</li><li>c</li></ul></body></html>',
    );
    const { computeSelector } = await loadEntry();
    const target = document.querySelectorAll('li')[2]!;
    const selector = computeSelector(target);
    expect(document.querySelector(selector)).toBe(target);
  });

  it('is stable across siblings with the same tag', async () => {
    installPage(
      '<html><body><div class="a">A</div><div class="b">B</div></body></html>',
    );
    const { computeSelector } = await loadEntry();
    const divs = document.querySelectorAll('div');
    expect(computeSelector(divs[0]!)).not.toBe(computeSelector(divs[1]!));
  });
});

describe('describeElement', () => {
  it('prefers the id', async () => {
    installPage('<html><body><div id="card">Card</div></body></html>');
    const { describeElement } = await loadEntry();
    expect(describeElement(document.getElementById('card')!)).toBe('div#card');
  });

  it('falls back to the tag and first class when there is no id', async () => {
    installPage(
      '<html><body><section class="card highlighted">Card</section></body></html>',
    );
    const { describeElement } = await loadEntry();
    expect(describeElement(document.querySelector('section')!)).toBe(
      'section.card',
    );
  });

  it('falls back to just the tag when there is neither an id nor a class', async () => {
    installPage('<html><body><article>Post</article></body></html>');
    const { describeElement } = await loadEntry();
    expect(describeElement(document.querySelector('article')!)).toBe('article');
  });
});
