// The ONLY browser-touching module in jiffyapp-bot. Deliberately thin and NOT unit-tested
// locally (Task 15 brief) — it is exercised by the Phase-2 live reference checks against the
// real Browser Rendering binding, not by anything `pnpm test` runs in this repo. Everything
// that can be expressed as pure policy lives in assertPlan.ts; this module is adapter-only,
// mapping `PageDriver` 1:1 onto `@cloudflare/playwright` locators.
//
// Selector policy: every testid resolves to `[data-testid="<testid>"]`; an explicit `nth`
// picks `.nth(n)`, the (undefined) default picks `.first()`.

// @cloudflare/playwright's own `.d.ts` files use extension-less relative specifiers
// (`from './types/types'`) that this workspace's `moduleResolution: NodeNext` can't follow,
// so its `Browser`/`Page` interfaces aren't resolvable as named imports here (they come back
// as "no exported member"). Derive the same types structurally off `launch`'s return type
// instead of importing them by name — this is the one adaptation this file needs to live
// with that package's types; nothing else in the repo is affected.
import { launch } from '@cloudflare/playwright';
import type { PageDriver } from './assertPlan.js';

type PlaywrightBrowser = Awaited<ReturnType<typeof launch>>;
type PlaywrightPage = Awaited<ReturnType<PlaywrightBrowser['newPage']>>;

/** Structural view of the memoized-per-job browser handle `createPlaywrightPageFactory`
 *  needs — the `BrowserLauncher` shape from the Task 15 brief. Kept narrow (`newPage()` just
 *  returns `unknown`) so tests elsewhere can hand in a fake without depending on this file. */
export interface BrowserLauncher {
  launch(): Promise<{ newPage(): Promise<unknown>; close(): Promise<void> }>;
}

/** Wraps `@cloudflare/playwright`'s `launch(binding)` — the BROWSER env binding IS the
 *  Cloudflare Browser Rendering session; `launch()` opens one browser per call. */
export function createPlaywrightLauncher(browserBinding: Fetcher): BrowserLauncher {
  return {
    async launch() {
      const browser: PlaywrightBrowser = await launch(browserBinding);
      return {
        newPage: () => browser.newPage(),
        close: () => browser.close(),
      };
    },
  };
}

function selectorFor(testid: string): string {
  return `[data-testid="${testid}"]`;
}

/** Wraps a live Playwright `Page` as the `PageDriver` the assertion-plan executor
 *  (assertPlan.ts) expects. */
function wrapPage(page: PlaywrightPage): PageDriver {
  function locatorFor(testid: string, nth?: number) {
    const loc = page.locator(selectorFor(testid));
    return nth === undefined ? loc.first() : loc.nth(nth);
  }

  return {
    async goto(url) {
      await page.goto(url);
    },

    async fill(testid, value, nth) {
      const loc = locatorFor(testid, nth);
      // Compiled goldens emit a `select` step for <select> elements, but buyer-shorthand
      // goldens can't always tell the difference — Playwright's fill() throws on a
      // <select>, so the driver absorbs the shorthand by checking the tag first.
      const tagName = await loc.evaluate((el: HTMLElement) => el.tagName);
      if (tagName === 'SELECT') {
        await loc.selectOption(value);
      } else {
        await loc.fill(value);
      }
    },

    async setChecked(testid, checked, nth) {
      await locatorFor(testid, nth).setChecked(checked);
    },

    async selectOption(testid, value, nth) {
      await locatorFor(testid, nth).selectOption(value);
    },

    async click(testid, nth) {
      await locatorFor(testid, nth).click();
    },

    async uploadFile(testid, name, content) {
      const mimeType = name.endsWith('.csv') ? 'text/csv' : 'text/plain';
      await locatorFor(testid).setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
    },

    async textContent(testid, nth) {
      const loc = locatorFor(testid, nth);
      // <textarea>/<input>/<select> report their value through `.value`, not
      // `.textContent` — goldens assert the rendered VALUE, so read whichever applies.
      return loc.evaluate((el: Element) => {
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
        ) {
          return el.value;
        }
        return el.textContent ?? '';
      });
    },

    async getAttribute(testid, attr, nth) {
      return locatorFor(testid, nth).getAttribute(attr);
    },

    async count(testid) {
      return page.locator(selectorFor(testid)).count();
    },

    async isVisible(testid, nth) {
      // Playwright's isVisible() honors the `hidden` attribute natively.
      return locatorFor(testid, nth).isVisible();
    },

    async title() {
      return page.title();
    },

    async metaContent(property) {
      return page.locator(`meta[property="${property}"]`).first().getAttribute('content');
    },

    async screenshot() {
      const buffer = await page.screenshot();
      return new Uint8Array(buffer);
    },

    async close() {
      // A timed-out golden leaves an abandoned in-flight operation on the page (Task 9
      // handoff note) — closing must tolerate that rather than throw and skip cleanup.
      try {
        await page.close();
      } catch {
        // best-effort; a close failure doesn't change any assertion outcome
      }
    },
  };
}

/** One browser per factory instance (memoized `launch()`), a fresh `Page` per `openPage()`
 *  call. `closeAll()` tears the browser down at job end and tolerates a hung page inside it
 *  (same rationale as `close()` above). */
export function createPlaywrightPageFactory(launcher: BrowserLauncher): {
  openPage: () => Promise<PageDriver>;
  closeAll: () => Promise<void>;
} {
  let browserPromise: ReturnType<BrowserLauncher['launch']> | undefined;

  function getBrowser(): ReturnType<BrowserLauncher['launch']> {
    if (!browserPromise) browserPromise = launcher.launch();
    return browserPromise;
  }

  return {
    async openPage() {
      const browser = await getBrowser();
      // `BrowserLauncher.launch()` returns the narrow `{ newPage(): Promise<unknown> }`
      // shape so callers can supply a fake in tests; the real launcher (this file) always
      // hands back a genuine Playwright Page here.
      const page = (await browser.newPage()) as PlaywrightPage;
      return wrapPage(page);
    },

    async closeAll() {
      if (!browserPromise) return;
      try {
        const browser = await browserPromise;
        await browser.close();
      } catch {
        // best-effort — a hung page inside this browser must not prevent job cleanup
      }
    },
  };
}
