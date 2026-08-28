import { chromium } from 'playwright';
import { assertFetchableUrl, type PageIR } from 'quickcaps-core';
import { collectViaPlaywright } from './collect-via-playwright.js';
import { CliError } from './errors.js';

export type InteractAction = {
  kind: 'button' | 'input';
  value?: string;
};

/**
 * Re-navigates to `url` fresh, relocates the target element by domPath —
 * the same body-relative child-index walk read.ts does against a
 * re-parsed html string, but here against the live page's real DOM (via
 * page.evaluateHandle), since the element must be interactable, not just
 * readable — performs the action, waits for any resulting navigation
 * (capped, since a same-page toggle triggers none), then collects the
 * resulting page.
 *
 * Known limitation, not fixed here: this is a fresh page load every call,
 * not a continuation of prior interaction state — multi-step flows that
 * depend on client-side state built up across several `do` calls (e.g.
 * "add to cart" then "checkout") don't work, because nothing about this
 * CLI keeps a browser process alive between invocations. A persistent
 * session would fix this and is explicitly out of scope (parent spec
 * §12.2: "no daemon"). Concretely: after a DOM-mutating `do`, `interact`
 * re-navigates to the pre-interaction page state, so a stored `domPath`
 * can resolve to a *different* element post-mutation (the DOM shifted
 * under it) and silently interact with the wrong one — not just "nothing
 * happens."
 */
export async function interact(
  url: string,
  domPath: number[],
  action: InteractAction,
): Promise<{ ir: PageIR; driver: 'playwright' }> {
  try {
    await assertFetchableUrl(url);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);

    const handle = await page.evaluateHandle((path: number[]) => {
      let el: Element | null = document.body;
      for (const index of path) el = el?.children[index] ?? null;
      return el;
    }, domPath);
    const element = handle.asElement();
    if (!element) {
      throw new CliError(
        `Could not relocate the target element on ${url} — the page may have changed since it was opened.`,
      );
    }

    if (action.kind === 'button') {
      await element.click();
    } else if (action.value === undefined) {
      await element.focus();
      await element.press('Enter');
    } else {
      // <input>, <select>, and <textarea> are all classified as 'input' by
      // ActionRef, but Playwright's .fill() throws on a <select> ("Element
      // is not an <input>, <textarea> or [contenteditable]") — it needs
      // .selectOption() instead. A <select> changing value doesn't submit
      // its form the way Enter in a text field does, so no follow-up
      // .press('Enter') here — the value change itself is the interaction.
      const tagName = await element.evaluate((el) => el.tagName.toLowerCase());
      if (tagName === 'select') {
        await element.selectOption(action.value);
      } else {
        await element.fill(action.value);
        await element.press('Enter');
      }
    }

    // A click/submit may or may not trigger navigation (a same-page toggle
    // vs. a form submit) — wait for whichever happens, capped, rather than
    // assuming either. No navigation is a valid outcome, not a failure.
    await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});

    const ir = await collectViaPlaywright(page);
    return { ir, driver: 'playwright' };
  } finally {
    await browser.close();
  }
}
