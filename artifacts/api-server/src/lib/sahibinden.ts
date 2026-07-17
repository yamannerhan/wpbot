import * as cheerio from "cheerio";
import { chromium, type Browser, type Page } from "playwright";
import { db } from "@workspace/db";
import {
  whatsappMessagesTable,
  whatsappMessagesArchiveTable,
  whatsappConfigTable,
} from "@workspace/db";
import { eq, and, like, sql } from "drizzle-orm";
import { logger } from "./logger.js";

const DEFAULT_URL =
  "https://www.sahibinden.com/koruma-guvenlik-guvenlik-gorevlisi-is-ilanlari";
const GENERAL_URL =
  "https://www.sahibinden.com/koruma-guvenlik-is-ilanlari";
const LOOKBACK_MS = 15 * 24 * 60 * 60 * 1000;
const POLL_MS = 30 * 60 * 1000;
const LOGIN_URL =
  "https://secure.sahibinden.com/giris?return_url=https%3A%2F%2Fwww.sahibinden.com%2Fkoruma-guvenlik-guvenlik-gorevlisi-is-ilanlari";
const GROUP_ID = "sahibinden:guvenlik";
const GROUP_NAME = "Sahibinden";

type ListingCard = {
  id: string;
  title: string;
  url: string;
  dateText: string;
  date: Date | null;
  location: string;
};

type Status = {
  listening: boolean;
  url: string;
  lastFetchAt: string | null;
  nextFetchAt: string | null;
  total: number;
  lastAdded: number;
  lastError: string | null;
  mode: "chromium";
  loggedIn: boolean;
  loginUrl: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(min = 1200, max = 2800) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

const TR_MONTHS: Record<string, number> = {
  ocak: 0,
  subat: 1,
  şubat: 1,
  mart: 2,
  nisan: 3,
  mayis: 4,
  mayıs: 4,
  haziran: 5,
  temmuz: 6,
  agustos: 7,
  ağustos: 7,
  eylul: 8,
  eylül: 8,
  ekim: 9,
  kasim: 10,
  kasım: 10,
  aralik: 11,
  aralık: 11,
};

function parseTrDate(text: string): Date | null {
  const t = text.trim().toLocaleLowerCase("tr-TR");
  if (!t) return null;
  if (t.includes("bugün") || t === "bugun") {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    return d;
  }
  if (t.includes("dün") || t === "dun") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(12, 0, 0, 0);
    return d;
  }
  const m = t.match(/(\d{1,2})\s+([a-zçğıöşü]+)\s+(\d{4})/i);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = TR_MONTHS[m[2]!];
  const year = Number(m[3]);
  if (mon == null || !day || !year) return null;
  return new Date(year, mon, day, 12, 0, 0, 0);
}

function extractPhone(text: string): string | null {
  const m = text.match(
    /(?:\+?90|0)?\s*\(?5\d{2}\)?[\s.\-]*\d{3}[\s.\-]*\d{2}[\s.\-]*\d{2}/,
  );
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

function parseCards(html: string): ListingCard[] {
  const $ = cheerio.load(html);
  const out: ListingCard[] = [];
  const seen = new Set<string>();

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
    const idMatch = full.match(/-(\d+)(?:\/|$)/) || full.match(/\/(\d{6,})/);
    const id =
      row.attr("data-id") ||
      idMatch?.[1] ||
      full.replace(/\W/g, "").slice(-12);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const title = a.text().replace(/\s+/g, " ").trim();
    const dateText = row
      .find(".searchResultsDateValue, td.searchResultsDateValue")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const location = row
      .find(".searchResultsLocationValue, td.searchResultsLocationValue")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    out.push({
      id: String(id),
      title,
      url: full.split("?")[0]!,
      dateText,
      date: parseTrDate(dateText),
      location,
    });
  });

  if (out.length === 0) {
    $('a[href*="/ilan/"]').each((_, el) => {
      const href = $(el).attr("href") || "";
      if (!/is-ilanlari|guvenlik|ilan/i.test(href)) return;
      const full = href.startsWith("http")
        ? href
        : `https://www.sahibinden.com${href}`;
      const idMatch = full.match(/-(\d+)(?:\/|$)/);
      const id = idMatch?.[1];
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({
        id,
        title: $(el).text().replace(/\s+/g, " ").trim() || `İlan ${id}`,
        url: full.split("?")[0]!,
        dateText: "",
        date: new Date(),
        location: "",
      });
    });
  }

  return out;
}

function isLoginUrl(url: string) {
  return /\/giris|secure\.sahibinden\.com\/giris/i.test(url);
}

function isLoginHtml(html: string, url: string) {
  if (isLoginUrl(url)) return true;
  return (
    /giriş yapmanız gerekmektedir|e-posta ile giriş|qr ile giriş/i.test(
      html.slice(0, 8000),
    ) && !/searchResultsItem|classifiedTitle/i.test(html)
  );
}

function isChallenge(title: string, html: string) {
  const t = `${title} ${html.slice(0, 4000)}`.toLowerCase();
  return (
    t.includes("bir dakika") ||
    t.includes("just a moment") ||
    t.includes("cf-challenge") ||
    t.includes("challenge-platform") ||
    t.includes("turnstile")
  );
}

class SahibindenService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private nextFetchAt: Date | null = null;
  private lastAdded = 0;
  private lastError: string | null = null;
  private browser: Browser | null = null;

  async start(): Promise<void> {
    const cfg = await this.getConfig();
    if (!cfg.listening) return;
    this.stopTimerOnly();
    this.nextFetchAt = new Date(Date.now() + POLL_MS);
    this.timer = setInterval(() => {
      this.scan({ deep: false }).catch((err) =>
        logger.error({ err }, "Sahibinden scheduled scan failed"),
      );
    }, POLL_MS);
    logger.info("Sahibinden Chromium listening ON — every 30 minutes");
    setTimeout(() => {
      this.scan({ deep: false }).catch(() => undefined);
    }, 12000);
  }

  private stopTimerOnly() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async stop(): Promise<void> {
    this.stopTimerOnly();
    this.nextFetchAt = null;
    await this.closeBrowser();
    await this.patchConfig({ sahibindenListening: false });
  }

  async enableListen(): Promise<void> {
    await this.patchConfig({ sahibindenListening: true });
    await this.start();
  }

  private async closeBrowser() {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1366,768",
      ],
    });
    return this.browser;
  }

  async getConfig(): Promise<{
    url: string;
    listening: boolean;
    lastFetchAt: Date | null;
    cookies: string;
  }> {
    const rows = await db
      .select()
      .from(whatsappConfigTable)
      .where(eq(whatsappConfigTable.id, 1))
      .limit(1);
    const row = rows[0];
    return {
      url: row?.sahibindenUrl || DEFAULT_URL,
      listening: row?.sahibindenListening ?? true,
      lastFetchAt: row?.sahibindenLastFetchAt ?? null,
      cookies:
        row?.sahibindenCookies?.trim() ||
        process.env.SAHIBINDEN_COOKIES?.trim() ||
        "",
    };
  }

  async getStatus(): Promise<Status> {
    const cfg = await this.getConfig();
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(like(whatsappMessagesTable.groupId, "sahibinden:%"));
    return {
      url: cfg.url,
      listening: cfg.listening,
      lastFetchAt: cfg.lastFetchAt?.toISOString() ?? null,
      nextFetchAt: this.nextFetchAt?.toISOString() ?? null,
      total: Number(count || 0),
      lastAdded: this.lastAdded,
      lastError: this.lastError,
      mode: "chromium",
      loggedIn: Boolean(cfg.cookies && cfg.cookies.length > 20),
      loginUrl: LOGIN_URL,
    };
  }

  private async patchConfig(
    patch: Partial<{
      sahibindenUrl: string;
      sahibindenLastFetchAt: Date;
      sahibindenListening: boolean;
      sahibindenCookies: string;
    }>,
  ) {
    const rows = await db
      .select()
      .from(whatsappConfigTable)
      .where(eq(whatsappConfigTable.id, 1))
      .limit(1);

    if (!rows[0]) {
      await db.insert(whatsappConfigTable).values({
        id: 1,
        selectedGroupIds: [],
        sahibindenUrl: patch.sahibindenUrl ?? DEFAULT_URL,
        sahibindenLastFetchAt: patch.sahibindenLastFetchAt,
        sahibindenListening: patch.sahibindenListening ?? true,
        sahibindenCookies: patch.sahibindenCookies,
      });
      return;
    }

    await db
      .update(whatsappConfigTable)
      .set({
        ...(patch.sahibindenUrl != null
          ? { sahibindenUrl: patch.sahibindenUrl }
          : {}),
        ...(patch.sahibindenLastFetchAt != null
          ? { sahibindenLastFetchAt: patch.sahibindenLastFetchAt }
          : {}),
        ...(patch.sahibindenListening != null
          ? { sahibindenListening: patch.sahibindenListening }
          : {}),
        ...(patch.sahibindenCookies != null
          ? { sahibindenCookies: patch.sahibindenCookies }
          : {}),
      })
      .where(eq(whatsappConfigTable.id, 1));
  }

  async setUrl(url: string) {
    await this.patchConfig({ sahibindenUrl: url.trim() });
  }

  async setCookies(
    cookies: string,
    cookieList?: Array<{
      name: string;
      value: string;
      domain?: string;
      path?: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "Strict" | "Lax" | "None";
    }>,
  ) {
    let header = cookies.trim();
    if (!header && cookieList?.length) {
      header = cookieList.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    // Playwright cookie listesini JSON olarak sakla (daha iyi inject)
    const stored =
      cookieList && cookieList.length
        ? JSON.stringify({ header, list: cookieList })
        : header;
    await this.patchConfig({ sahibindenCookies: stored });
    this.lastError = null;
    logger.info(
      { cookieCount: cookieList?.length || header.split(";").length },
      "Sahibinden session cookies saved",
    );
  }

  /** Config'ten cookie header + opsiyonel Playwright list */
  private parseStoredCookies(raw: string): {
    header: string;
    list: Array<{
      name: string;
      value: string;
      domain?: string;
      path?: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "Strict" | "Lax" | "None";
    }>;
  } {
    if (!raw?.trim()) return { header: "", list: [] };
    try {
      const parsed = JSON.parse(raw) as {
        header?: string;
        list?: Array<{
          name: string;
          value: string;
          domain?: string;
          path?: string;
          expires?: number;
          httpOnly?: boolean;
          secure?: boolean;
          sameSite?: "Strict" | "Lax" | "None";
        }>;
      };
      if (parsed && (parsed.header || parsed.list)) {
        return {
          header: parsed.header || "",
          list: parsed.list || [],
        };
      }
    } catch {
      /* plain header string */
    }
    return { header: raw, list: [] };
  }

  async list(limit: number, offset: number, search?: string) {
    const rows = await db
      .select()
      .from(whatsappMessagesTable)
      .where(like(whatsappMessagesTable.groupId, "sahibinden:%"))
      .orderBy(sql`${whatsappMessagesTable.timestamp} desc`)
      .limit(limit)
      .offset(offset);

    const filtered = search
      ? rows.filter((r) =>
          r.content.toLowerCase().includes(search.toLowerCase()),
        )
      : rows;

    return {
      messages: filtered.map((m) => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
        fetchedAt: m.fetchedAt.toISOString(),
      })),
      total: filtered.length,
    };
  }

  async clearPool(): Promise<{ deleted: number; message: string }> {
    const existing = await db
      .select()
      .from(whatsappMessagesTable)
      .where(like(whatsappMessagesTable.groupId, "sahibinden:%"));
    if (existing.length) {
      await db
        .insert(whatsappMessagesArchiveTable)
        .values(existing)
        .onConflictDoNothing();
    }
    await db
      .delete(whatsappMessagesTable)
      .where(like(whatsappMessagesTable.groupId, "sahibinden:%"));

    void this.scan({ deep: true }).catch((err) =>
      logger.error({ err }, "Sahibinden post-clear deep scan failed"),
    );
    await this.enableListen();

    return {
      deleted: existing.length,
      message: `Sahibinden havuzu temizlendi (${existing.length}). Chromium ile son 15 gün taranıyor.`,
    };
  }

  async ingestListings(
    items: Array<{
      id: string;
      title: string;
      url: string;
      content: string;
      sender?: string;
      phone?: string | null;
      location?: string;
      timestamp?: string;
    }>,
  ): Promise<{ added: number }> {
    let added = 0;
    for (const item of items) {
      const content = [
        "Sahibinden",
        "",
        item.title,
        item.location ? `Konum: ${item.location}` : "",
        item.phone ? `Telefon: ${item.phone}` : "",
        item.url,
        "",
        item.content,
      ]
        .filter(Boolean)
        .join("\n");

      const ts = item.timestamp ? new Date(item.timestamp) : new Date();
      const row = {
        messageId: String(item.id),
        groupId: GROUP_ID,
        groupName: GROUP_NAME,
        content,
        sender: item.sender || "Sahibinden",
        timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
      };

      const before = await db
        .select({ id: whatsappMessagesTable.id })
        .from(whatsappMessagesTable)
        .where(
          and(
            eq(whatsappMessagesTable.messageId, row.messageId),
            eq(whatsappMessagesTable.groupId, GROUP_ID),
          ),
        )
        .limit(1);
      if (before.length) continue;

      await db.insert(whatsappMessagesTable).values(row).onConflictDoNothing();
      await db
        .insert(whatsappMessagesArchiveTable)
        .values(row)
        .onConflictDoNothing();
      added++;
    }
    this.lastAdded = added;
    this.lastError = null;
    await this.patchConfig({ sahibindenLastFetchAt: new Date() });
    return { added };
  }

  private async applyCookies(page: Page, rawStored: string) {
    const { header, list } = this.parseStoredCookies(rawStored);
    if (list.length) {
      const normalized = list.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || ".sahibinden.com",
        path: c.path || "/",
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure ?? true,
        sameSite: c.sameSite || ("Lax" as const),
      }));
      await page.context().addCookies(normalized);
      return;
    }
    if (!header.trim()) return;
    const cookies = header
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf("=");
        if (i <= 0) return null;
        return {
          name: part.slice(0, i).trim(),
          value: part.slice(i + 1).trim(),
          domain: ".sahibinden.com",
          path: "/",
        };
      })
      .filter(Boolean) as Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
    }>;
    if (cookies.length) {
      await page.context().addCookies(cookies);
    }
  }

  private async clickCloudflare(page: Page) {
    const frames = [
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="turnstile"]',
      'iframe[id*="cf-chl-widget"]',
    ];
    for (const sel of frames) {
      try {
        const box = page
          .frameLocator(sel)
          .locator('input[type="checkbox"], .cb-i, label.cb-lb')
          .first();
        if ((await box.count()) > 0) {
          await box.click({ timeout: 4000, force: true });
          await sleep(2000);
          return true;
        }
      } catch {
        /* next */
      }
    }
    try {
      const stage = page.locator("#challenge-stage, .cf-turnstile").first();
      if ((await stage.count()) > 0) {
        const b = await stage.boundingBox();
        if (b) {
          await page.mouse.click(b.x + 28, b.y + b.height / 2);
          await sleep(2000);
          return true;
        }
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /** Doğrudan ilan listesine git — giriş sayfasına düşerse tekrar dene, login yapma. */
  private async openListingPage(page: Page, listUrl: string): Promise<string> {
    const attempts = [
      listUrl,
      // Google referer ile tekrar (giriş duvarını azaltır)
      listUrl,
      listUrl.includes("?")
        ? `${listUrl}&pagingOffset=0`
        : `${listUrl}?pagingOffset=0`,
    ];

    for (let i = 0; i < attempts.length; i++) {
      const target = attempts[i]!;
      await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
        referer:
          i === 0
            ? undefined
            : "https://www.google.com/",
      });
      await humanDelay();

      // CF
      for (let w = 0; w < 20; w++) {
        const title = await page.title().catch(() => "");
        const html = await page.content().catch(() => "");
        if (!isChallenge(title, html)) break;
        await this.clickCloudflare(page);
        await sleep(2000);
      }

      let url = page.url();
      let html = await page.content();

      // Giriş ekranı geldiyse — login YAPMA, doğrudan kategoriye zorla
      if (isLoginHtml(html, url)) {
        logger.warn({ url }, "Sahibinden giriş sayfasına düştü — tekrar kategori");
        await page.goto(listUrl, {
          waitUntil: "domcontentloaded",
          timeout: 90000,
          referer: "https://www.google.com/search?q=sahibinden+guvenlik+gorevlisi",
        });
        await humanDelay(2000, 3500);
        url = page.url();
        html = await page.content();
        if (isLoginHtml(html, url)) {
          continue; // next attempt
        }
      }

      if (parseCards(html).length > 0) return html;
      // Boş büyük sayfa = soft block / yanlış içerik — başarı sayma
      const title = await page.title().catch(() => "");
      logger.warn(
        { url, title, htmlLen: html.length, cards: 0 },
        "Sahibinden liste boş döndü",
      );
    }

    throw new Error(
      "İlan listesi boş (Railway IP engelli olabilir). Bilgisayarında Sahibinden-Giris.cmd ile Google giriş yapıp Enter'a bas — çekim ev IP ile yapılır.",
    );
  }

  private async fetchListingCards(
    page: Page,
    listUrl: string,
    maxPages: number,
  ): Promise<ListingCard[]> {
    const out: ListingCard[] = [];
    const seen = new Set<string>();

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const url =
        pageNo === 1
          ? listUrl
          : `${listUrl}${listUrl.includes("?") ? "&" : "?"}pagingOffset=${(pageNo - 1) * 20}`;
      const html =
        pageNo === 1
          ? await this.openListingPage(page, url)
          : await (async () => {
              await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 90000,
                referer: listUrl,
              });
              await humanDelay();
              if (isLoginHtml(await page.content(), page.url())) {
                return "";
              }
              return page.content();
            })();

      if (!html) break;
      for (const c of parseCards(html)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
      if (out.length === 0 && pageNo === 1) break;
    }
    return out;
  }

  private async fetchDetail(
    page: Page,
    card: ListingCard,
  ): Promise<{
    title: string;
    body: string;
    phone: string | null;
    seller: string;
    location: string;
    date: Date | null;
    url: string;
  } | null> {
    try {
      await page.goto(card.url, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
        referer: DEFAULT_URL,
      });
      await humanDelay(800, 1800);
      const html = await page.content();
      if (isLoginHtml(html, page.url())) {
        // Detay için login istemesin — kart bilgisini kullan
        return {
          title: card.title,
          body: "",
          phone: null,
          seller: "Sahibinden",
          location: card.location,
          date: card.date,
          url: card.url,
        };
      }
      const $ = cheerio.load(html);
      const title =
        $("h1").first().text().replace(/\s+/g, " ").trim() || card.title;
      const infoLines: string[] = [];
      $(".classifiedInfoList li, ul.classifiedInfoList li").each((_, el) => {
        const t = $(el).text().replace(/\s+/g, " ").trim();
        if (t) infoLines.push(t);
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
      const dateFromInfo =
        infoLines.find((l) => /ilan tarihi/i.test(l)) || card.dateText;
      const date =
        parseTrDate(dateFromInfo.replace(/ilan tarihi[:\s]*/i, "")) ||
        card.date;
      const location =
        infoLines
          .find((l) => /il\s*\/\s*ilçe|il \/ ilce/i.test(l))
          ?.replace(/.*?:\s*/i, "") || card.location;
      return {
        title,
        body: [infoLines.join("\n"), "", desc].filter(Boolean).join("\n"),
        phone,
        seller,
        location,
        date,
        url: card.url,
      };
    } catch (err) {
      logger.warn({ err, url: card.url }, "Sahibinden detail failed");
      return {
        title: card.title,
        body: "",
        phone: null,
        seller: "Sahibinden",
        location: card.location,
        date: card.date,
        url: card.url,
      };
    }
  }

  async scan(opts?: { deep?: boolean }): Promise<{
    added: number;
    scanned: number;
    message: string;
  }> {
    if (this.running) {
      return {
        added: 0,
        scanned: 0,
        message: "Tarama zaten sürüyor, lütfen bekleyin.",
      };
    }
    this.running = true;
    this.lastError = null;
    const deep = Boolean(opts?.deep);
    const since = new Date(Date.now() - LOOKBACK_MS);
    let added = 0;
    let scanned = 0;
    let context = null as Awaited<
      ReturnType<Browser["newContext"]>
    > | null;

    try {
      const cfg = await this.getConfig();
      const browser = await this.getBrowser();
      context = await browser.newContext({
        locale: "tr-TR",
        timezoneId: "Europe/Istanbul",
        viewport: { width: 1366, height: 768 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        extraHTTPHeaders: {
          "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      const page = await context.newPage();
      await this.applyCookies(page, cfg.cookies);

      const urls = Array.from(new Set([cfg.url || DEFAULT_URL, GENERAL_URL]));

      for (const listUrl of urls) {
        const cards = await this.fetchListingCards(
          page,
          listUrl,
          deep ? 8 : 3,
        );
        for (const card of cards) {
          scanned++;
          if (card.date && card.date < since) continue;
          const exists = await db
            .select({ id: whatsappMessagesTable.id })
            .from(whatsappMessagesTable)
            .where(
              and(
                eq(whatsappMessagesTable.messageId, card.id),
                eq(whatsappMessagesTable.groupId, GROUP_ID),
              ),
            )
            .limit(1);
          if (exists.length) continue;

          await humanDelay(900, 2000);
          const detail = await this.fetchDetail(page, card);
          if (!detail) continue;
          if (detail.date && detail.date < since) continue;

          const content = [
            "Sahibinden",
            "",
            detail.title,
            detail.location ? `Konum: ${detail.location}` : "",
            detail.phone ? `Telefon: ${detail.phone}` : "",
            detail.url,
            "",
            detail.body,
          ]
            .filter(Boolean)
            .join("\n");

          await db
            .insert(whatsappMessagesTable)
            .values({
              messageId: card.id,
              groupId: GROUP_ID,
              groupName: GROUP_NAME,
              content,
              sender: detail.seller || "Sahibinden",
              timestamp: detail.date || card.date || new Date(),
            })
            .onConflictDoNothing();

          await db
            .insert(whatsappMessagesArchiveTable)
            .values({
              messageId: card.id,
              groupId: GROUP_ID,
              groupName: GROUP_NAME,
              content,
              sender: detail.seller || "Sahibinden",
              timestamp: detail.date || card.date || new Date(),
            })
            .onConflictDoNothing();

          added++;
        }
      }

      await this.patchConfig({ sahibindenLastFetchAt: new Date() });
      this.nextFetchAt = new Date(Date.now() + POLL_MS);
      this.lastAdded = added;

      const msg = deep
        ? `Chromium tarama: ${scanned} bakıldı, ${added} eklendi (max 15 gün).`
        : `Chromium: ${scanned} bakıldı, ${added} yeni. 30 dk dinlemede.`;

      logger.info({ added, scanned, deep }, "Sahibinden Chromium scan done");
      return { added, scanned, message: msg };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Sahibinden Chromium scan failed");
      return {
        added,
        scanned,
        message: `Sahibinden tarama hatası: ${this.lastError}`,
      };
    } finally {
      await context?.close().catch(() => undefined);
      this.running = false;
    }
  }
}

export const sahibindenService = new SahibindenService();

sahibindenService.start().catch((err) =>
  logger.error({ err }, "Sahibinden auto-start failed"),
);
