/**
 * Sahibinden otomatik köprü
 * - Patchright (stealth Chrome) + Cloudflare Turnstile otomatik tıklama
 * - Windows görev zamanlayıcı her 30 dk çalıştırır
 */
import { chromium } from "patchright";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "sahibinden.config.json");
const LOG_PATH = path.join(__dirname, "sahibinden-bridge.log");
const PROFILE_DIR = path.join(__dirname, ".sahibinden-chrome-profile");

const DEFAULT_URL =
  "https://www.sahibinden.com/koruma-guvenlik-guvenlik-gorevlisi-is-ilanlari";
const GENERAL_URL =
  "https://www.sahibinden.com/koruma-guvenlik-is-ilanlari";
const HOME = "https://www.sahibinden.com/";
const POLL_MS = 30 * 60 * 1000;

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* no file */
  }
  return {
    api:
      process.env.SAHIBINDEN_API?.replace(/\/$/, "") ||
      file.api?.replace(/\/$/, "") ||
      "https://wpbot-production-cf99.up.railway.app",
    url: process.env.SAHIBINDEN_URL || file.url || DEFAULT_URL,
    deep: process.env.SAHIBINDEN_DEEP === "1" || Boolean(file.deep),
  };
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {
    /* ignore */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(min = 1800, max = 4800) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

function extractPhone(text) {
  const m = String(text || "").match(
    /(?:\+?90|0)?\s*\(?5\d{2}\)?[\s.\-]*\d{3}[\s.\-]*\d{2}[\s.\-]*\d{2}/,
  );
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();

  $("tr.searchResultsItem, tr[data-id], .searchResultsItem").each((_, el) => {
    const row = $(el);
    const a =
      row.find("a.classifiedTitle").first().length > 0
        ? row.find("a.classifiedTitle").first()
        : row.find("a[href*='/ilan/']").first();
    const href = a.attr("href") || "";
    if (!href.includes("/ilan/")) return;
    const full = href.startsWith("http")
      ? href
      : `https://www.sahibinden.com${href}`;
    const idMatch = full.match(/-(\d+)(?:\/|$)/);
    const id = row.attr("data-id") || idMatch?.[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id: String(id),
      title: a.text().replace(/\s+/g, " ").trim(),
      url: full.split("?")[0],
      location: row
        .find(".searchResultsLocationValue, td.searchResultsLocationValue")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim(),
    });
  });
  return out;
}

function looksLikeChallenge(title, html) {
  const t = `${title} ${html.slice(0, 5000)}`.toLowerCase();
  return (
    t.includes("bir dakika") ||
    t.includes("just a moment") ||
    t.includes("cf-browser-verification") ||
    t.includes("cf-challenge") ||
    t.includes("challenge-platform") ||
    t.includes("turnstile") ||
    t.includes("attention required") ||
    (t.includes("cloudflare") && parseCards(html).length === 0 && html.length < 40000)
  );
}

async function realClick(page, x, y) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await sleep(80 + Math.random() * 120);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sleep(40 + Math.random() * 60);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Cloudflare Turnstile / interstitial checkbox'ını otomatik tıkla */
async function autoClickCloudflare(page) {
  // 1) frameLocator ile klasik turnstile
  const frameSelectors = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'iframe[id*="cf-chl-widget"]',
    'iframe[title*="Widget containing"]',
  ];

  for (const sel of frameSelectors) {
    try {
      const fl = page.frameLocator(sel).first();
      const box = fl.locator(
        'input[type="checkbox"], #challenge-stage input, .cb-i, label.cb-lb, span.mark',
      );
      if ((await box.count().catch(() => 0)) > 0) {
        log("  Cloudflare kutusu bulundu — tıklanıyor...");
        await box.first().click({ timeout: 5000, force: true });
        await sleep(2000);
        return true;
      }
    } catch {
      /* try next */
    }
  }

  // 2) Tüm framelerde checkbox ara
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!/cloudflare|turnstile|challenge/i.test(url) && frame !== page.mainFrame()) {
      continue;
    }
    try {
      const el = frame.locator(
        'input[type="checkbox"], #challenge-stage, .cb-i, label.cb-lb',
      );
      if ((await el.count()) > 0) {
        const handle = await el.first().elementHandle();
        if (handle) {
          const box = await handle.boundingBox();
          if (box) {
            log("  Cloudflare frame checkbox — tıklanıyor...");
            await realClick(
              page,
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
            await sleep(2000);
            return true;
          }
        }
        await el.first().click({ timeout: 4000, force: true });
        await sleep(2000);
        return true;
      }
    } catch {
      /* next frame */
    }
  }

  // 3) CDP ile closed shadow DOM / iframe koordinatı (pierce)
  try {
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });

    const search = async (node, depth = 0) => {
      if (!node || depth > 40) return null;
      const name = `${node.nodeName || ""} ${node.localName || ""}`.toLowerCase();
      const attrs = {};
      if (Array.isArray(node.attributes)) {
        for (let i = 0; i < node.attributes.length; i += 2) {
          attrs[String(node.attributes[i]).toLowerCase()] = String(
            node.attributes[i + 1] || "",
          );
        }
      }
      const src = attrs.src || "";
      const id = attrs.id || "";
      const title = attrs.title || "";
      if (
        name.includes("iframe") &&
        (/cloudflare|turnstile|challenge/i.test(src + id + title) ||
          /cf-chl/i.test(id))
      ) {
        return node;
      }
      if (node.children) {
        for (const child of node.children) {
          const found = await search(child, depth + 1);
          if (found) return found;
        }
      }
      if (node.shadowRoots) {
        for (const sr of node.shadowRoots) {
          const found = await search(sr, depth + 1);
          if (found) return found;
        }
      }
      if (node.contentDocument) {
        const found = await search(node.contentDocument, depth + 1);
        if (found) return found;
      }
      return null;
    };

    const iframeNode = await search(root);
    if (iframeNode?.backendNodeId) {
      const { model } = await cdp.send("DOM.getBoxModel", {
        backendNodeId: iframeNode.backendNodeId,
      });
      if (model?.content) {
        // Checkbox genelde sol tarafta — iframe sol-orta
        const [x1, y1, , , x2, y2] = model.content;
        const x = x1 + Math.min(30, (x2 - x1) * 0.12);
        const y = y1 + (y2 - y1) / 2;
        log(`  Cloudflare iframe CDP tık (${Math.round(x)},${Math.round(y)})`);
        await cdp.detach().catch(() => undefined);
        await realClick(page, x, y);
        await sleep(2500);
        return true;
      }
    }
    await cdp.detach().catch(() => undefined);
  } catch (err) {
    log(`  CDP tık denemesi: ${err.message}`);
  }

  // 4) Sayfa ortasına / bilinen challenge alanına tık
  try {
    const widget = page.locator("#challenge-stage, .cf-turnstile, [data-sitekey]").first();
    if ((await widget.count()) > 0) {
      const box = await widget.boundingBox();
      if (box) {
        log("  Challenge alanı tıklanıyor...");
        await realClick(page, box.x + 28, box.y + box.height / 2);
        await sleep(2000);
        return true;
      }
    }
  } catch {
    /* ignore */
  }

  return false;
}

async function waitOutChallenge(page, label) {
  const deadline = Date.now() + 120000;
  let clicked = false;

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("Sayfa kapandı");

    const title = await page.title().catch(() => "");
    const html = await page.content().catch(() => "");

    if (!looksLikeChallenge(title, html)) {
      const cards = parseCards(html);
      if (
        cards.length > 0 ||
        /sahibinden/i.test(title) ||
        (html.length > 25000 && !looksLikeChallenge(title, html))
      ) {
        log(`  Cloudflare geçildi (${label})`);
        return;
      }
    }

    log(`  Cloudflare kontrol (${label})... title=${title || "?"}`);

    // ASLA reload etme — challenge sıfırlanır. Sadece tıkla ve bekle.
    if (!clicked || Math.random() > 0.55) {
      clicked = (await autoClickCloudflare(page)) || clicked;
    }

    await page.mouse.move(
      180 + Math.random() * 500,
      160 + Math.random() * 280,
    );
    await sleep(2200 + Math.random() * 1800);
  }

  const title = await page.title().catch(() => "");
  throw new Error(`Cloudflare aşılmadı (${label}): ${title}`);
}

async function gotoHuman(page, url, label) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await humanDelay(1500, 2800);
  await waitOutChallenge(page, label);
  await page.mouse.wheel(0, 400 + Math.floor(Math.random() * 400));
  await sleep(500 + Math.random() * 700);
}

async function openContext() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "--window-position=40,40",
  ];

  // Görünür pencere: CF checkbox tıklanabilsin (minimize engeller)
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
      args,
    });
  } catch (err) {
    log(`Chrome channel başarısız (${err.message}), Chromium...`);
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1280, height: 900 },
      args,
    });
  }
}

async function scrapeOnce(cfg) {
  const maxPages = cfg.deep ? 8 : 3;
  const context = await openContext();
  const page = context.pages()[0] || (await context.newPage());

  try {
    // Pencereyi öne getir (CF için)
    await page.bringToFront().catch(() => undefined);

    log("Anasayfa açılıyor (CF otomatik tık)...");
    await gotoHuman(page, HOME, "anasayfa");

    log("İş ilanları...");
    await gotoHuman(page, "https://www.sahibinden.com/is-ilanlari", "is-ilanlari");

    const urls = [...new Set([cfg.url, GENERAL_URL])];
    const cards = [];
    const seen = new Set();

    for (const listUrl of urls) {
      for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
        const url =
          pageNo === 1
            ? listUrl
            : `${listUrl}${listUrl.includes("?") ? "&" : "?"}pagingOffset=${(pageNo - 1) * 20}`;
        log(`Liste: ${url}`);
        await gotoHuman(page, url, `liste-${pageNo}`);
        const html = await page.content();
        for (const c of parseCards(html)) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          cards.push(c);
        }
        if (cards.length === 0 && pageNo === 1) break;
      }
    }

    log(`${cards.length} ilan bulundu`);
    const items = [];
    const limit = cfg.deep ? 80 : 35;
    for (const card of cards.slice(0, limit)) {
      await humanDelay(1500, 3600);
      try {
        await gotoHuman(page, card.url, `ilan-${card.id}`);
        const html = await page.content();
        const $ = cheerio.load(html);
        const title =
          $("h1").first().text().replace(/\s+/g, " ").trim() || card.title;
        const info = [];
        $(".classifiedInfoList li, ul.classifiedInfoList li").each((_, el) => {
          const t = $(el).text().replace(/\s+/g, " ").trim();
          if (t) info.push(t);
        });
        const desc =
          $("#classifiedDescription, .classifiedDescription")
            .first()
            .text()
            .replace(/\s+/g, " ")
            .trim() || "";
        const seller =
          $(".username-info-area h5, .user-info h5")
            .first()
            .text()
            .replace(/\s+/g, " ")
            .trim() || "Sahibinden";
        let phone =
          $(".pretty-phone-part, #phoneInfo span")
            .first()
            .text()
            .replace(/\s+/g, " ")
            .trim() || null;
        if (!phone) phone = extractPhone(html) || extractPhone(desc);
        items.push({
          id: card.id,
          title,
          url: card.url,
          location: card.location,
          phone,
          sender: seller,
          content: [info.join("\n"), "", desc].filter(Boolean).join("\n"),
          timestamp: new Date().toISOString(),
        });
        log(`  + ${title.slice(0, 70)}`);
      } catch (err) {
        log(`  ! ${card.id}: ${err.message}`);
      }
    }

    if (!items.length) {
      log("İlan yok — ingest atlandı");
      return { added: 0, scraped: 0 };
    }

    const res = await fetch(`${cfg.api}/api/sahibinden/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Ingest HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    log(`Railway'e gönderildi: ${data.message || JSON.stringify(data)}`);
    return { added: data.added || 0, scraped: items.length };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function main() {
  const cfg = loadConfig();
  const loop =
    process.env.SAHIBINDEN_LOOP === "1" || process.argv.includes("--loop");

  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        api: cfg.api,
        url: cfg.url,
        deep: false,
        pollMinutes: 30,
      },
      null,
      2,
    ),
  );

  log(`API=${cfg.api}`);
  log(loop ? "Otomatik döngü: 30 dk" : "Tek seferlik tarama (CF auto-click)");

  for (;;) {
    try {
      await scrapeOnce(cfg);
    } catch (err) {
      log(`HATA: ${err.message || err}`);
    }
    if (!loop) break;
    log(`Sonraki tarama ~30 dk sonra...`);
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  log(`FATAL: ${err.message || err}`);
  process.exit(1);
});
