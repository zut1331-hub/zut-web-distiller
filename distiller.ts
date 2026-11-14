/**
 * The actual "distillation" - turns a live web page into a compact,
 * agent-friendly text block, entirely on the user's own machine.
 *
 * Nothing in this file ever talks to zutonline.com. It only talks to
 * the page the agent asked for.
 */
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chromium, type Browser } from "playwright";

export interface InteractiveElement {
  ref: string; // short id the agent can refer back to, e.g. "b3", "i1"
  kind: "button" | "link" | "input" | "select" | "textarea";
  label: string; // visible text, aria-label, placeholder or value - whichever exists
  href?: string; // only for links, and only if it's not absurdly long
}

export interface DistillResult {
  url: string;
  title: string;
  direction: "ltr" | "rtl";
  textContent: string; // the cleaned main content, word-capped
  interactiveElements: InteractiveElement[];
  truncated: boolean;
  approxTokensSaved: string; // a rough, honestly-labelled estimate, not a measured figure
}

const MAX_WORDS = 1500; // keeps the output small; raise via the tool's maxWords arg if needed

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

function shortLabel(s: string | null | undefined, max = 60): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "\u2026" : t;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

export async function distillPage(
  url: string,
  opts: { maxWords?: number; timeoutMs?: number } = {},
): Promise<DistillResult> {
  const parsed = new URL(url); // throws on a malformed URL - let the caller see that error
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only http/https URLs are supported, got: ${parsed.protocol}`);
  }

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: opts.timeoutMs ?? 20_000,
    });

    // Collect interactive elements from the LIVE, rendered page (so we
    // catch things added by JavaScript) before we throw the DOM into
    // Readability for content extraction.
    const rawElements = await page.evaluate(() => {
      const out: { kind: string; label: string; href?: string }[] = [];
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      document.querySelectorAll("a[href]").forEach((el) => {
        if (!visible(el)) return;
        out.push({
          kind: "link",
          label: (el.textContent || el.getAttribute("aria-label") || "").trim(),
          href: (el as HTMLAnchorElement).href,
        });
      });
      document.querySelectorAll("button, [role=button]").forEach((el) => {
        if (!visible(el)) return;
        out.push({
          kind: "button",
          label: (el.textContent || el.getAttribute("aria-label") || "").trim(),
        });
      });
      document.querySelectorAll("input, textarea").forEach((el) => {
        if (!visible(el)) return;
        const input = el as HTMLInputElement;
        if (input.type === "hidden") return;
        out.push({
          kind: el.tagName.toLowerCase() === "textarea" ? "textarea" : "input",
          label:
            input.placeholder ||
            input.getAttribute("aria-label") ||
            input.name ||
            input.value ||
            "",
        });
      });
      document.querySelectorAll("select").forEach((el) => {
        if (!visible(el)) return;
        out.push({
          kind: "select",
          label: el.getAttribute("aria-label") || (el as HTMLSelectElement).name || "",
        });
      });
      return out;
    });

    const html = await page.content();
    const dir = await page.evaluate(() => document.documentElement.dir || "ltr");

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    const fullText = (article?.textContent || "").replace(/\s+/g, " ").trim();
    const words = fullText.split(" ");
    const cap = opts.maxWords ?? MAX_WORDS;
    const truncated = words.length > cap;
    const textContent = truncated ? words.slice(0, cap).join(" ") + " \u2026" : fullText;

    const seenCounts: Record<string, number> = {};
    const prefix: Record<string, string> = {
      link: "l",
      button: "b",
      input: "i",
      textarea: "t",
      select: "s",
    };
    const interactiveElements: InteractiveElement[] = rawElements
      .filter((e) => e.label) // unlabelled controls aren't useful to an agent anyway
      .slice(0, 80) // cap, so a huge page doesn't blow the budget back up
      .map((e) => {
        const p = prefix[e.kind] ?? "x";
        seenCounts[p] = (seenCounts[p] ?? 0) + 1;
        return {
          ref: `${p}${seenCounts[p]}`,
          kind: e.kind as InteractiveElement["kind"],
          label: shortLabel(e.label),
          href: e.href && e.href.length < 300 ? e.href : undefined,
        };
      });

    // A rough, honestly-labelled estimate only - we do not claim to
    // have measured actual tokenization of the stripped HTML.
    const rawHtmlWords = html.split(/\s+/).length;
    const savedPct = rawHtmlWords > 0
      ? Math.max(0, Math.round((1 - (textContent.split(" ").length + interactiveElements.length * 6) / rawHtmlWords) * 100))
      : 0;

    return {
      url,
      title: article?.title || (await page.title()) || url,
      direction: dir === "rtl" ? "rtl" : "ltr",
      textContent,
      interactiveElements,
      truncated,
      approxTokensSaved: `~${savedPct}% smaller than the raw page HTML (rough estimate, not a measured token count)`,
    };
  } finally {
    await page.close();
  }
}
