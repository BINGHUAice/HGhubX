// Shared browser-fixture harness for new tests.
//
// It starts one Vite server, launches Chromium through playwright-core, blocks
// every request outside the Vite origin, records page errors, and writes a
// JSON report under test-results/<name>/<timestamp>/. Existing scripts keep
// their own setup; migrate them here one at a time.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function openFixture({
  name,
  rootDir = defaultRoot,
  viewport = { width: 1100, height: 1200 },
  userAgent,
  browserExecutable = process.env.BROWSER_EXECUTABLE,
} = {}) {
  if (!name) throw new Error("harness: name is required");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = join(rootDir, "test-results", name, stamp);
  await mkdir(output, { recursive: true });

  const report = {
    name,
    started: new Date().toISOString(),
    transport: "local browser fixture; caller mocks Tauri IPC",
    external: [],
    pageErrors: [],
    passed: [],
  };
  let vite;
  let browser;
  let context;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const resource of [context, browser, vite]) {
      try {
        await resource?.close?.();
      } catch {
        // A failed close must not hide the test's own error.
      }
    }
  };

  try {
    vite = await createServer({ root: rootDir, server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await vite.listen();
    const origin = vite.resolvedUrls.local[0];
    browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable || undefined,
    });
    context = await browser.newContext({ viewport, userAgent });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (!/^https?:/i.test(url)) return route.continue();
      if (new URL(url).origin === new URL(origin).origin) return route.continue();
      report.external.push(url);
      return route.abort();
    });

    const writeReport = async (extra = {}) => {
      await writeFile(
        join(output, "report.json"),
        `${JSON.stringify({ ...report, ...extra, finished: new Date().toISOString() }, null, 2)}\n`,
      );
    };

    return { root: rootDir, origin, output, report, page, context, browser, vite, close, writeReport };
  } catch (error) {
    await close();
    throw error;
  }
}

export function assertNoExternal(report) {
  if (report.external.length) {
    throw new Error(`external requests: ${report.external.join(", ")}`);
  }
}

export function assertNoPageErrors(report) {
  if (report.pageErrors.length) {
    throw new Error(`page errors: ${report.pageErrors.join(" | ")}`);
  }
}
