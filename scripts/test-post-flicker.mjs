import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "vite";
import { chromium } from "playwright-core";

// issue #165 回归：吃瓜详情的线路/代理事件不得清空已显示内容。
//   契约 1：hg:line-changed / hg:proxy-changed 后正文与滚动位置保留、不出现整页 Loader、
//           播放器不重建、播放不中断；后台确实重新请求了 api_post 与 api_post_playback。
//   契约 2：换帖子 id 仍然整页重置（清空重置只属于换帖子/换账号）。
//   契约 3：短暂 HLS 缓冲（<300ms）不闪播放区转圈；持续缓冲仍显示。
// 真实 PostDetail + AppProvider + Player，mock Tauri IPC；HLS 用本地 ffmpeg fixture，
// 不访问上游网络。需要 ffmpeg，归入播放诊断（pnpm test:playback --scenarios post-flicker），
// 不进 smoke。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "post-flicker", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Real PostDetail/AppProvider/Player in Chromium; mocked Tauri IPC; local HLS fixture; not native verification", passed: [], external: [] };
let vite, browser, page, media;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 本地 VOD HLS：60s testsrc2，2s 分片。
const mediaDir = await mkdtemp(join(tmpdir(), "hghubx-post-flicker-"));
execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-an", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", join(mediaDir, "seg%03d.ts"), join(mediaDir, "list.m3u8")], { timeout: 60000, stdio: "pipe" });
const manifest = await readFile(join(mediaDir, "list.m3u8"), "utf8");
let segDelayMs = 0;
media = createHttpServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    let body, kind;
    if (url.pathname === "/hls") {
      body = Buffer.from(manifest.split("\n").map(line => !line || line.startsWith("#") ? line :
        `http://hg.localhost/seg?u=${encodeURIComponent(`https://media.fixture.invalid/${line.trim()}`)}`).join("\n"));
      kind = "application/vnd.apple.mpegurl";
    } else if (url.pathname === "/seg") {
      const name = new URL(url.searchParams.get("u")).pathname.split("/").pop();
      if (segDelayMs) await sleep(segDelayMs);
      body = await readFile(join(mediaDir, name)); kind = "video/mp2t";
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": kind, "Content-Length": body.length, "Access-Control-Allow-Origin": "*" });
    res.end(body);
  } catch { res.writeHead(404); res.end("fixture error"); }
});
await new Promise((done, reject) => { media.once("error", reject); media.listen(0, "127.0.0.1", done); });
const mediaOrigin = `http://127.0.0.1:${media.address().port}`;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const raw = route.request().url();
    const url = new URL(raw);
    if (url.origin === new URL(origin).origin) return route.continue();
    // hls.js 直接请求本机媒体代理地址；映射到本地 fixture server。
    if (url.origin === "http://hg.localhost" || url.origin === "http://127.0.0.1:17650") {
      return route.fetch({ url: `${mediaOrigin}${url.pathname}${url.search}` }).then(response => route.fulfill({ response }));
    }
    if (url.origin === mediaOrigin) return route.continue();
    report.external.push(raw);
    return route.abort();
  });
  await page.goto(`${origin}tests/post-flicker.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.postFlickerFixture && document.querySelector("[data-post-scroll] h1"));
  await page.waitForFunction(() => document.querySelector("video") && document.querySelector("video").currentTime > 1 && !document.querySelector("video").paused, null, { timeout: 30000 });

  const state = () => page.evaluate(() => {
    const sc = document.querySelector("[data-post-scroll]");
    const v = document.querySelector("video");
    return {
      title: sc?.querySelector("h1")?.textContent || null,
      article: !!document.querySelector(".article-body"),
      scrollTop: sc ? Math.round(sc.scrollTop) : -1,
      fullLoader: !!sc && !sc.querySelector("h1") && !!sc.querySelector(".spinner"),
      playerSpinner: !!document.querySelector(".post-player .spinner"),
      video: v ? { time: v.currentTime, paused: v.paused, rs: v.readyState } : null,
    };
  });
  const events = () => page.evaluate(() => window.postFlickerFixture.events);
  const history = () => page.evaluate(() => window.postFlickerFixture.history);
  const mark = () => page.evaluate(() => window.postFlickerFixture.events.length);

  // 滚到正文中部，模拟阅读位置。
  await page.evaluate(() => { const sc = document.querySelector("[data-post-scroll]"); sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5); });
  await sleep(200);
  const before = await state();
  assert(before.article && before.scrollTop > 100, `前置：应处于正文中部 ${JSON.stringify(before)}`);
  await page.evaluate(() => { window.__postVideo = document.querySelector("video"); });

  // ---- 契约 1：两种线路事件各来一次，内容/位置/播放器必须原样 ----
  for (const eventName of ["hg:line-changed", "hg:proxy-changed"]) {
    const at = await mark();
    const histBefore = (await history()).length;
    await page.evaluate(name => window.dispatchEvent(new Event(name)), eventName);
    // 后台刷新必须真的发生（两个接口各至少一次）。
    await page.waitForFunction(n => window.postFlickerFixture.history.length >= n + 2, histBefore, { timeout: 10000 });
    await sleep(700); // 覆盖旧代码「清空→重拉→重建」的完整窗口
    const after = await state();
    const fresh = (await events()).slice(at);
    assert.equal(after.title, before.title, `${eventName} 后标题必须保留`);
    assert(after.article, `${eventName} 后正文必须保留`);
    assert(Math.abs(after.scrollTop - before.scrollTop) <= 2, `${eventName} 后滚动位置必须保留：${before.scrollTop} → ${after.scrollTop}`);
    assert(!after.fullLoader, `${eventName} 后不得出现整页 Loader`);
    assert(!fresh.some(e => e.type === "page.del" || e.type === "player.del"), `${eventName} 不得卸载页面/播放器：${JSON.stringify(fresh)}`);
    assert(!fresh.some(e => e.type === "spinner.add"), `${eventName} 不得出现任何转圈：${JSON.stringify(fresh)}`);
    const same = await page.evaluate(() => document.querySelector("video") === window.__postVideo);
    assert(same, `${eventName} 后必须是同一个 video 元素`);
    assert(after.video && !after.video.paused && after.video.time > before.video.time, `${eventName} 后播放必须继续：${JSON.stringify(after.video)}`);
    const cmds = (await history()).slice(histBefore).map(h => h.cmd);
    assert(cmds.includes("api_post") && cmds.includes("api_post_playback"), `${eventName} 必须后台刷新两个接口：${cmds}`);
    report.passed.push(`line-event-keeps-content:${eventName}`);
  }

  // ---- 契约 1b：后台刷新失败也不打断阅读 ----
  await page.evaluate(() => { window.postFlickerFixture.postResult = "fail"; window.postFlickerFixture.playbackResult = "fail"; });
  const atFail = await mark();
  const histFail = (await history()).length;
  await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
  await page.waitForFunction(n => window.postFlickerFixture.history.length >= n + 2, histFail, { timeout: 10000 });
  await sleep(700);
  const afterFail = await state();
  assert(afterFail.article && afterFail.title === before.title, "后台刷新失败必须保留正文");
  assert(!afterFail.fullLoader, "后台刷新失败不得回整页错误/Loader");
  assert(!(await events()).slice(atFail).some(e => e.type === "page.del"), "后台刷新失败不得卸载页面");
  assert(afterFail.video && !afterFail.video.paused, "后台刷新失败不得打断播放");
  await page.evaluate(() => { window.postFlickerFixture.postResult = "ok"; window.postFlickerFixture.playbackResult = "ok"; });
  report.passed.push("background-refresh-failure-keeps-content");

  // ---- 契约 2：换帖子 id 仍然整页重置 ----
  const atSwitch = await mark();
  await page.evaluate(() => window.postFlickerSetId(2));
  await page.waitForFunction(() => document.querySelector("[data-post-scroll] h1")?.textContent === "示例帖子 2", null, { timeout: 10000 });
  const switched = (await events()).slice(atSwitch);
  assert(switched.some(e => e.type === "page.del" || e.type === "spinner.add"), `换帖子必须走整页重置：${JSON.stringify(switched)}`);
  const afterSwitch = await state();
  assert.equal(afterSwitch.scrollTop, 0, "换帖子后滚动位置必须归零");
  report.passed.push("post-switch-still-resets");

  // ---- 契约 3：短暂缓冲不闪转圈，持续缓冲仍显示 ----
  await page.waitForFunction(() => document.querySelector("video") && document.querySelector("video").currentTime > 1 && !document.querySelector("video").paused, null, { timeout: 30000 });
  // 缓冲契约只对媒体 waiting 生效；用户 seek 立即显示转圈是另一条既有行为。
  // 用原生 currentTime 赋值模拟「播放中跳到未缓冲区」，只走媒体 waiting 路径。
  const jumpTo = async seconds => page.evaluate(t => { document.querySelector("video").currentTime = t; }, seconds);
  const playing = () => page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && !v.paused && !v.seeking && v.readyState >= 3;
  }, null, { timeout: 30000 });
  // 3a：分片延迟 120ms（<300ms 去抖窗）→ 媒体 waiting 不应闪播放区转圈。
  // 先跳到 20s 让 hls.js 清掉 backBuffer 之外的缓冲，再跳回 10s：
  // 此时 10s 处必然无缓冲，触发一次真实的媒体 waiting（约 120ms）。
  segDelayMs = 120;
  await jumpTo(20);
  await playing();
  await sleep(400); // 让 20s 附近的缓冲建立、远端缓冲被清除
  // 在页面内挂一个 waiting 计数探针，证明「确实发生过短缓冲」而不是没触发。
  await page.evaluate(() => {
    window.__waitCount = 0;
    document.querySelector("video").addEventListener("waiting", () => { window.__waitCount += 1; });
  });
  await jumpTo(10);
  const atShort = await mark();
  await playing();
  await sleep(400);
  const waitCount = await page.evaluate(() => window.__waitCount);
  assert(waitCount >= 1, `短缓冲场景必须真实触发媒体 waiting（count=${waitCount}）`);
  const shortEvents = (await events()).slice(atShort).filter(e => e.type === "spinner.add");
  assert.equal(shortEvents.length, 0, `短暂缓冲不得闪转圈：${JSON.stringify(shortEvents)}`);
  report.passed.push("brief-buffering-no-spinner");
  // 3b：分片延迟 1200ms（>300ms）→ 必须出现转圈，恢复后消失。
  segDelayMs = 1200;
  await jumpTo(40);
  await page.waitForFunction(() => document.querySelector("video").currentTime >= 39.5, null, { timeout: 20000 });
  const atLong = await mark();
  // 300ms 去抖窗内不得出现；持续缓冲超过窗口后必须出现。
  await sleep(150);
  assert(!(await page.evaluate(() => !!document.querySelector(".post-player .spinner"))), "去抖窗内不得提前显示转圈");
  await page.waitForFunction(() => !!document.querySelector(".post-player .spinner"), null, { timeout: 15000 });
  segDelayMs = 0;
  await playing();
  await page.waitForFunction(() => !document.querySelector(".post-player .spinner"), null, { timeout: 15000 });
  assert((await events()).slice(atLong).some(e => e.type === "spinner.add"), "持续缓冲必须显示转圈");
  report.passed.push("sustained-buffering-shows-spinner");

  assert.equal(errors.length, 0, `页面脚本错误：${errors.join(" | ")}`);
  assert.equal(report.external.length, 0, `不得访问上游网络：${report.external.join(", ")}`);
  await page.screenshot({ path: join(output, "final.png") });
  await writeFile(join(output, "report.json"), JSON.stringify({ ...report, events: await events() }, null, 2));
  console.log(`post-flicker: ${report.passed.length}/${report.passed.length} passed`);
  for (const name of report.passed) console.log(`PASS ${name}`);
} catch (error) {
  await writeFile(join(output, "report.json"), JSON.stringify({ ...report, failed: String(error?.stack || error) }, null, 2)).catch(() => {});
  if (page) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  console.error(`FAIL post-flicker: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await new Promise(done => media?.close(done));
}
