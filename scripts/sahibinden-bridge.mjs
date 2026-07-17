/**
 * Sahibinden yerel köprü — bilgisayarındaki GERÇEK Chrome ile çeker,
 * Railway havuzuna yollar. (Node fetch TLS yüzünden 403 yer; Chrome geçmez.)
 *
 * PowerShell (yeni bot klasöründe):
 *   $env:SAHIBINDEN_API="https://SENIN-UYGULAMA.up.railway.app"
 *   pnpm sahibinden:bridge
 *
 * İlk seferde Chrome yüklü olmalı. Yoksa:
 *   npx playwright install chromium
 */
import { chromium } from "playwright";
import * as cheerio from "cheerio";

const DEFAULT_URL =
  "https://www.sahibinden.com/koruma-guvenlik-guvenlik-gorevlisi-is-ilanlari";
const GENERAL_URL =
  "https://www.sahibinden.com/koruma-guvenlik-is-ilanlari";
const HOME = "https://www.sahibinden.com/";

const API =
  process.env.SAHIBINDEN_API?.replace(/\/$/, "") ||
  process.env.API_URL?.replace(/\/$/, "") ||
  "";
const CATEGORY = process.env.SAHIBINDEN_URL || DEFAULT_URL;
const DEEP = process.env.SAHIBINDEN_DEEP === "1";
const MAX_PAGES = DEEP ? 8 : 3;
const HEADLESS = process.env.SAHIBINDEN_HEADLESS !== "0";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(min = 1600, max = 4200) {
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

async function launchBrowser() {
  const common = {
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launch({ ...common, channel: "chrome" });
  } catch {
    console.log("Sistem Chrome bulunamadı, Playwright Chromium deneniyor...");
    return await chromium.launch(common);
  }
}

async function main() {
  if (!API) {
    console.error(
      'SAHIBINDEN_API gerekli.\nÖrnek:\n  $env:SAHIBINDEN_API="https://xxx.up.railway.app"\n  pnpm sahibinden:bridge',
    );
    process.exit(1);
  }

  const browser = await launchBrowser();
  const context = await browser.newContext({
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();

  console.log("Anasayfa (gerçek Chrome)...");
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
  await humanDelay(2000, 4000);

  console.log("İş ilanları...");
  await page.goto("https://www.sahibinden.com/is-ilanlari", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await humanDelay(1500, 3500);

  const urls = [...new Set([CATEGORY, GENERAL_URL])];
  const cards = [];
  const seen = new Set();

  for (const listUrl of urls) {
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const url =
        pageNo === 1
          ? listUrl
          : `${listUrl}${listUrl.includes("?") ? "&" : "?"}pagingOffset=${(pageNo - 1) * 20}`;
      console.log(`Liste: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await humanDelay(1800, 4000);
      // soft scroll like a human
      await page.mouse.wheel(0, 800);
      await sleep(600);
      const html = await page.content();
      if (/HTTP 403|access denied|cloudflare/i.test(html) && html.length < 10000) {
        throw new Error(
          "Chrome ile de engel var. Bir kez elle Chrome'da sahibinden.com açıp doğrula, sonra tekrar dene (SAHIBINDEN_HEADLESS=0).",
        );
      }
      for (const c of parseCards(html)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        cards.push(c);
      }
      if (cards.length === 0 && pageNo === 1) break;
    }
  }

  console.log(`${cards.length} ilan bulundu, detay çekiliyor...`);
  const items = [];
  for (const card of cards.slice(0, DEEP ? 80 : 40)) {
    await humanDelay();
    try {
      await page.goto(card.url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await humanDelay(1200, 2800);
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
      console.log(`  + ${title.slice(0, 70)}`);
    } catch (err) {
      console.warn(`  ! ${card.id}: ${err.message}`);
    }
  }

  await browser.close();

  const res = await fetch(`${API}/api/sahibinden/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Ingest hata:", data);
    process.exit(1);
  }
  console.log(`Tamam: ${data.message || JSON.stringify(data)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
