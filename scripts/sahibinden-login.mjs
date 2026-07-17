/**
 * Sahibinden: bir kez Google girişi (sen) + hemen ilan çekimi (ev IP).
 * Sonra Windows görevi 30 dk'da bir aynı oturumla çeker → Railway havuza yazar.
 *
 *   pnpm sahibinden:login
 *   veya Sahibinden-Giris.cmd
 */
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "sahibinden.config.json");
const PROFILE_DIR = path.join(__dirname, ".sahibinden-login-profile");

const LOGIN_URL =
  "https://secure.sahibinden.com/giris?return_url=https%3A%2F%2Fwww.sahibinden.com%2Fkoruma-guvenlik-guvenlik-gorevlisi-is-ilanlari";
const LISTINGS_URL =
  "https://www.sahibinden.com/koruma-guvenlik-guvenlik-gorevlisi-is-ilanlari";
const GENERAL_URL =
  "https://www.sahibinden.com/koruma-guvenlik-is-ilanlari";

function loadApi() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* ignore */
  }
  return (
    process.env.SAHIBINDEN_API?.replace(/\/$/, "") ||
    file.api?.replace(/\/$/, "") ||
    "https://wpbot-production-cf99.up.railway.app"
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(min = 1200, max = 2800) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

function askEnter(msg) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(msg, () => {
      rl.close();
      resolve();
    });
  });
}

function isLoginUrl(url) {
  return /\/giris|secure\.sahibinden\.com\/giris/i.test(url || "");
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

function extractPhone(text) {
  const m = String(text || "").match(
    /(?:\+?90|0)?\s*\(?5\d{2}\)?[\s.\-]*\d{3}[\s.\-]*\d{2}[\s.\-]*\d{2}/,
  );
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

async function openContext(headless) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
  ];
  if (headless) args.push("--window-position=-32000,-32000");
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1366, height: 900 },
      args,
    });
  } catch {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      viewport: { width: 1366, height: 900 },
      args,
    });
  }
}

async function scrapeAndIngest(page, api, deep) {
  const urls = [...new Set([LISTINGS_URL, GENERAL_URL])];
  const cards = [];
  const seen = new Set();
  const maxPages = deep ? 6 : 3;

  for (const listUrl of urls) {
    for (let p = 1; p <= maxPages; p++) {
      const url =
        p === 1
          ? listUrl
          : `${listUrl}${listUrl.includes("?") ? "&" : "?"}pagingOffset=${(p - 1) * 20}`;
      console.log(`Liste: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await humanDelay(1500, 3000);
      if (isLoginUrl(page.url())) {
        throw new Error("Hâlâ giriş sayfasındasın — Google ile giriş yapıp Enter'a bas.");
      }
      const html = await page.content();
      for (const c of parseCards(html)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        cards.push(c);
      }
      if (cards.length === 0 && p === 1) break;
    }
  }

  console.log(`${cards.length} ilan bulundu, detay çekiliyor...`);
  if (!cards.length) {
    throw new Error(
      "İlan listesi boş. Google ile gerçekten giriş yapıp güvenlik görevlisi ilanlarını görene kadar bekle, sonra Enter.",
    );
  }

  const items = [];
  const limit = deep ? 60 : 30;
  for (const card of cards.slice(0, limit)) {
    await humanDelay(900, 2200);
    try {
      await page.goto(card.url, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await humanDelay(800, 1600);
      const html = await page.content();
      if (isLoginUrl(page.url())) continue;
      const $ = cheerio.load(html);
      const title =
        $("h1").first().text().replace(/\s+/g, " ").trim() || card.title;
      const info = [];
      $(".classifiedInfoList li").each((_, el) => {
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

  const res = await fetch(`${api}/api/sahibinden/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Ingest hata: ${JSON.stringify(data)}`);
  console.log(data.message || JSON.stringify(data));
  return { added: data.added || 0, scraped: items.length };
}

async function saveCookies(context, api) {
  const all = await context.cookies();
  const shb = all.filter((c) => c.domain.includes("sahibinden.com"));
  const header = shb.map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(`${api}/api/sahibinden/cookies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookies: header, cookieList: shb }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cookie kayıt hatası: ${JSON.stringify(data)}`);
  console.log(`Oturum kaydedildi (${shb.length} cookie).`);
  return data;
}

async function main() {
  const api = loadApi();
  const autoOnly =
    process.argv.includes("--auto") || process.env.SAHIBINDEN_AUTO === "1";

  console.log("");
  console.log(autoOnly ? "=== Sahibinden otomatik çekim ===" : "=== Sahibinden Google Giriş + Çekim ===");
  console.log(`API: ${api}`);
  console.log("");

  const context = await openContext(autoOnly);
  const page = context.pages()[0] || (await context.newPage());

  try {
    if (!autoOnly) {
      await page.goto(LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      console.log("");
      console.log(">>> Chrome'da Google ile SAHIBINDEN'e giriş yap.");
      console.log(">>> Güvenlik görevlisi ilan listesini GÖRÜNCE buraya dön.");
      console.log("");
      await askEnter("İlan listesini gördün mü? Enter'a bas... ");
    }

    await page.goto(LISTINGS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await humanDelay(2000, 3500);

    if (isLoginUrl(page.url())) {
      throw new Error(
        "Hâlâ giriş sayfası. Google ile giriş yapıp ilanları gördükten sonra Enter'a bas.",
      );
    }

    let html = await page.content();
    let cards = parseCards(html);
    if (!cards.length) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await humanDelay(2000, 3000);
      html = await page.content();
      cards = parseCards(html);
    }
    if (!cards.length) {
      throw new Error(
        `İlan bulunamadı (url=${page.url()}, title=${await page.title()}). Giriş eksik veya yanlış sayfa.`,
      );
    }
    console.log(`Doğrulandı: ${cards.length} ilan listede görünüyor.`);

    if (!autoOnly) {
      await saveCookies(context, api);
    }

    const result = await scrapeAndIngest(page, api, !autoOnly);
    console.log("");
    console.log(`Tamam: ${result.scraped} çekildi, ${result.added} yeni eklendi.`);
    if (!autoOnly) {
      console.log("Bundan sonra her 30 dk otomatik çekilecek (PC açıkken).");
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("HATA:", err.message || err);
  process.exit(1);
});
