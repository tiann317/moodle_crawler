const { firefox } = require("playwright");
const path = require("path");
const archiver = require("archiver");

const MAX_PAGES = 300;
const MIN_TEXT = 300;
const NAV_TIMEOUT = 60000;

function safeName(name) {
  return decodeURIComponent(name || "file")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function filenameFromUrl(url) {
  const last = new URL(url).pathname.split("/").pop();
  return safeName(last || "download.bin");
}

function filenameFromHeaders(headers, fallback) {
  const cd = headers["content-disposition"] || "";
  const match =
    cd.match(/filename\*=UTF-8''([^;]+)/i) ||
    cd.match(/filename="?([^"]+)"?/i);
  return match ? safeName(match[1]) : fallback;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const p of ["lang", "sesskey", "notifyeditingon", "section"]) {
      u.searchParams.delete(p);
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url;
  }
}

function isMoodlePage(url) {
  return (
    url.includes("/course/view.php") ||
    url.includes("/mod/folder/view.php") ||
    url.includes("/mod/resource/view.php") ||
    url.includes("/mod/page/view.php") ||
    url.includes("/mod/book/view.php") ||
    url.includes("/mod/url/view.php")
  );
}

function isDownload(url) {
  return url.includes("/pluginfile.php/");
}

function googleDriveDownload(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("drive.google.com")) return null;
    const m = u.pathname.match(/\/file\/d\/([^/]+)/);
    const id = m ? m[1] : u.searchParams.get("id");
    if (id) {
      return {
        url: `https://drive.google.com/uc?export=download&id=${id}`,
        name: `drive_${id}`,
      };
    }
  } catch { }
  return null;
}

function reserveName(usedNames, name) {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}${ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
}

async function download(ctx, archive, url, usedNames, fallbackName, log, emit) {
  const response = await ctx.request.get(url, { maxRedirects: 10, timeout: NAV_TIMEOUT });

  if (!response.ok()) {
    log(`DOWNLOAD FAILED ${response.status()}: ${url}`);
    return false;
  }

  const fallback = fallbackName || filenameFromUrl(response.url());
  const filename = reserveName(usedNames, filenameFromHeaders(response.headers(), fallback));

  archive.append(await response.body(), { name: filename });
  log(`DOWNLOADED: ${filename}`);
  emit({ type: "file", name: filename });
  return true;
}

function collectLinks(page) {
  return page.$$eval("a[href]", links => [...new Set(links.map(a => a.href))]);
}

async function login(page, origin, username, password, log, emit) {
  log("Logging in...");
  emit({ type: "status", text: "Logging in…" });
  await page.goto(`${origin}/login/index.php`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.click("#loginbtn");

  try {
    await page.waitForSelector('a[href*="logout"], .loginerrors, #loginerrormessage', {
      state: "attached",
      timeout: NAV_TIMEOUT,
    });
  } catch {
    throw new Error("Login timed out — Moodle did not respond.");
  }

  if (!(await page.$('a[href*="logout"]'))) {
    throw new Error("Login failed — check username/password.");
  }
  log("Login OK.");
}

async function scrapeCourse({ courseUrl, username, password, onLog, onEvent }) {
  const log = onLog || (() => { });
  const emit = onEvent || (() => { });
  const origin = new URL(courseUrl).origin;

  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks = [];
  archive.on("data", c => chunks.push(c));
  const zipDone = new Promise((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });

  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  let courseName = "";

  try {
    await login(page, origin, username, password, log, emit);
    emit({ type: "status", text: "Crawling course…" });

    const start = normalizeUrl(courseUrl);
    const queue = [start];
    const queued = new Set([start]);
    const visited = new Set();
    const seenDownloads = new Set();
    const usedNames = new Set();

    let pageNum = 0;
    let downloadCount = 0;

    const pending = [];
    function queueDownload(url, fallbackName) {
      if (seenDownloads.has(url)) return;
      seenDownloads.add(url);
      pending.push(
        download(ctx, archive, url, usedNames, fallbackName, log, emit)
          .then(ok => { if (ok) downloadCount++; })
          .catch(e => log(`DOWNLOAD ERROR: ${url}\n${e.message}`))
      );
    }

    while (queue.length && visited.size < MAX_PAGES) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      pageNum++;
      log(`PAGE ${pageNum}: ${url}`);
      emit({ type: "progress", processed: visited.size, total: visited.size + queue.length });

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        const finalUrl = normalizeUrl(page.url());

        if (!courseName) courseName = safeName(await page.title());

        if (isDownload(finalUrl)) {
          queueDownload(finalUrl);
          await Promise.all(pending.splice(0));
          continue;
        }

        const drive = googleDriveDownload(finalUrl);
        if (drive) {
          queueDownload(drive.url, drive.name);
          await Promise.all(pending.splice(0));
          continue;
        }

        if (finalUrl !== url && visited.has(finalUrl)) {
          log(`SKIP (redirect to seen): ${finalUrl}`);
          continue;
        }
        visited.add(finalUrl);

        const mainText = await page.evaluate(() => {
          const region = document.querySelector("[role='main'], #region-main");
          return ((region || document.body).innerText || "").replace(/\s+/g, " ").trim();
        });

        if (mainText.length >= MIN_TEXT) {
          const title = safeName(await page.title()) || `page_${pageNum}`;
          const name = `${String(pageNum).padStart(3, "0")}_${title}.html`;
          archive.append(await page.content(), { name });
        } else {
          log(`SKIP (no content, ${mainText.length} chars): ${finalUrl}`);
        }

        for (const link of await collectLinks(page)) {
          const drive = googleDriveDownload(link);
          if (drive) {
            queueDownload(drive.url, drive.name);
            continue;
          }
          if (!link.startsWith(origin)) continue;

          if (isDownload(link)) {
            queueDownload(link);
          } else if (isMoodlePage(link)) {
            const norm = normalizeUrl(link);
            if (!queued.has(norm)) {
              queued.add(norm);
              queue.push(norm);
            }
          }
        }

        await Promise.all(pending.splice(0));
      } catch (e) {
        log(`FAILED PAGE: ${url}\n${e.message}`);
      }
    }

    await Promise.all(pending.splice(0));
    log(`Done. Visited ${visited.size} pages, downloaded ${downloadCount} files.`);
    emit({ type: "done", pages: visited.size, files: downloadCount });
  } finally {
    await ctx.close();
    await browser.close();
  }

  await archive.finalize();
  await zipDone;
  return { zip: Buffer.concat(chunks), name: courseName || "moodle-course" };
}

module.exports = { scrapeCourse };
