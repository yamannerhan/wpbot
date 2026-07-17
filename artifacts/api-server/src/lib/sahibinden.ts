import * as cheerio from "cheerio";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
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
const HOME_URL = "https://www.sahibinden.com/";
const LOOKBACK_MS = 15 * 24 * 60 * 60 * 1000;
const POLL_MS = 30 * 60 * 1000;
const GROUP_ID = "sahibinden:guvenlik";
const GROUP_NAME = "Sahibinden";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
  hasProxy: boolean;
  hasCookies: boolean;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(min = 2200, max = 5200) {
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

function parseCookieHeader(raw: string): Map<string, string> {
  const jar = new Map<string, string>();
  if (!raw?.trim()) return jar;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name || name.toLowerCase() === "path" || name.toLowerCase() === "domain")
      continue;
    if (/expires|max-age|secure|httponly|samesite/i.test(name)) continue;
    jar.set(name, value);
  }
  return jar;
}

function mergeSetCookies(jar: Map<string, string>, headers: Headers) {
  const raw =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [];
  for (const line of raw) {
    const first = line.split(";")[0] || "";
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
  }
}

function chromeHeaders(referer?: string, cookieHeader?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": CHROME_UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua":
      '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    Connection: "keep-alive",
  };
  if (referer) h.Referer = referer;
  if (cookieHeader) h.Cookie = cookieHeader;
  return h;
}

class SahibindenService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private nextFetchAt: Date | null = null;
  private lastAdded = 0;
  private lastError: string | null = null;
  private cookieJar = new Map<string, string>();
  private warmedUp = false;
  private dispatcher: Dispatcher | undefined;

  constructor() {
    const proxy =
      process.env.SAHIBINDEN_PROXY?.trim() ||
      process.env.HTTPS_PROXY?.trim() ||
      process.env.HTTP_PROXY?.trim();
    if (proxy) {
      this.dispatcher = new ProxyAgent(proxy);
      logger.info("Sahibinden proxy enabled");
    }
  }

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
    logger.info("Sahibinden listening ON — every 30 minutes");
    setTimeout(() => {
      this.scan({ deep: false }).catch(() => undefined);
    }, 8000);
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
    await this.patchConfig({ sahibindenListening: false });
  }

  async enableListen(): Promise<void> {
    await this.patchConfig({ sahibindenListening: true });
    await this.start();
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
      hasProxy: Boolean(this.dispatcher),
      hasCookies: Boolean(cfg.cookies || this.cookieJar.size),
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
    const clean = url.trim();
    await this.patchConfig({ sahibindenUrl: clean });
    this.warmedUp = false;
  }

  async setCookies(cookies: string) {
    await this.patchConfig({ sahibindenCookies: cookies.trim() });
    this.cookieJar = parseCookieHeader(cookies);
    this.warmedUp = false;
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
      message: `Sahibinden havuzu temizlendi (${existing.length}). Son 15 gün yeniden taranıyor; dinleme açık.`,
    };
  }

  /** Ingest listings scraped from a home-PC bridge (residential IP). */
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

    try {
      await this.ensureSession();
      const cfg = await this.getConfig();
      const urls = Array.from(new Set([cfg.url || DEFAULT_URL, GENERAL_URL]));

      for (const listUrl of urls) {
        const cards = await this.fetchListingCards(listUrl, deep ? 8 : 3);
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

          await humanDelay();
          const detail = await this.fetchDetail(card);
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

      const now = new Date();
      await this.patchConfig({ sahibindenLastFetchAt: now });
      this.nextFetchAt = new Date(Date.now() + POLL_MS);
      this.lastAdded = added;

      const msg = deep
        ? `Sahibinden derin tarama: ${scanned} ilan bakıldı, ${added} eklendi (max 15 gün). Dinleme açık.`
        : `Sahibinden: ${scanned} ilan bakıldı, ${added} yeni eklendi. 30 dk'da bir dinleniyor.`;

      logger.info({ added, scanned, deep }, "Sahibinden scan done");
      return { added, scanned, message: msg };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Sahibinden scan failed");
      return {
        added,
        scanned,
        message: `Sahibinden tarama hatası: ${this.lastError}`,
      };
    } finally {
      this.running = false;
    }
  }

  private cookieHeader(): string {
    return Array.from(this.cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  private async ensureSession() {
    const cfg = await this.getConfig();
    if (cfg.cookies && this.cookieJar.size === 0) {
      this.cookieJar = parseCookieHeader(cfg.cookies);
    }
    if (this.warmedUp && this.cookieJar.size > 0) return;

    // Human path: open homepage first, wait, then continue
    await this.fetchHtml(HOME_URL, undefined, { allowSoftFail: true });
    await humanDelay(1500, 3200);
    await this.fetchHtml(
      "https://www.sahibinden.com/is-ilanlari",
      HOME_URL,
      { allowSoftFail: true },
    );
    await humanDelay(1200, 2800);
    this.warmedUp = true;
  }

  private blockHint(status: number): string {
    const hasProxy = Boolean(this.dispatcher);
    if (status === 403 || status === 429 || status === 503) {
      if (!hasProxy) {
        return (
          `Sahibinden sunucu IP'sini engelledi (HTTP ${status}). ` +
          `Railway veri merkezi IP'si bot sanılıyor. Çözüm: Railway'e Türk ev/residential proxy ekle ` +
          `(SAHIBINDEN_PROXY) veya bilgisayarında yerel köprü çalıştır: pnpm sahibinden:bridge`
        );
      }
      return `Sahibinden HTTP ${status} — proxy/cookie geçersiz veya banlı olabilir. Cookie yenile veya başka proxy dene.`;
    }
    return `HTTP ${status}`;
  }

  private async fetchHtml(
    url: string,
    referer?: string,
    opts?: { allowSoftFail?: boolean },
  ): Promise<string> {
    const cookie = this.cookieHeader();
    const res = await undiciFetch(url, {
      method: "GET",
      headers: chromeHeaders(referer, cookie || undefined),
      redirect: "follow",
      dispatcher: this.dispatcher,
    });

    mergeSetCookies(this.cookieJar, res.headers as unknown as Headers);

    if (!res.ok) {
      const hint = this.blockHint(res.status);
      if (opts?.allowSoftFail) {
        logger.warn({ url, status: res.status }, "Sahibinden soft-fail fetch");
        return "";
      }
      throw new Error(`${hint} — ${url}`);
    }

    const html = await res.text();
    if (
      /cloudflare|captcha|access denied|just a moment/i.test(html) &&
      html.length < 8000
    ) {
      throw new Error(
        this.blockHint(403) + " (Cloudflare/captcha sayfası döndü)",
      );
    }
    if (/sahibinden\.com\/giris/i.test(res.url) || /\/giris\b/i.test(html.slice(0, 2000))) {
      throw new Error(
        "Sahibinden giriş sayfasına yönlendirdi. Chrome'dan cookie yapıştırın veya residential proxy kullanın.",
      );
    }
    return html;
  }

  private async fetchListingCards(
    listUrl: string,
    maxPages: number,
  ): Promise<ListingCard[]> {
    const out: ListingCard[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      const url =
        page === 1
          ? listUrl
          : `${listUrl}${listUrl.includes("?") ? "&" : "?"}pagingOffset=${(page - 1) * 20}`;
      if (page > 1) await humanDelay(2800, 6000);
      const html = await this.fetchHtml(
        url,
        page === 1 ? "https://www.sahibinden.com/is-ilanlari" : listUrl,
      );
      if (!html) break;
      const $ = cheerio.load(html);

      $("tr.searchResultsItem, tr[data-id], .searchResultsItem").each(
        (_, el) => {
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
          const idMatch =
            full.match(/-(\d+)(?:\/|$)/) || full.match(/\/(\d{6,})/);
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
            .find(
              ".searchResultsLocationValue, td.searchResultsLocationValue",
            )
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
        },
      );

      if (out.length === 0) {
        $('a[href*="/ilan/"]').each((_, el) => {
          const href = $(el).attr("href") || "";
          if (!href.includes("is-ilanlari") && !href.includes("guvenlik")) {
            if (!href.includes("/ilan/is-ilanlari")) return;
          }
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

      if (out.length === 0 && page === 1) break;
      if (out.length === 0) break;
    }

    return out;
  }

  private async fetchDetail(card: ListingCard): Promise<{
    title: string;
    body: string;
    phone: string | null;
    seller: string;
    location: string;
    date: Date | null;
    url: string;
  } | null> {
    try {
      const html = await this.fetchHtml(card.url, DEFAULT_URL);
      const $ = cheerio.load(html);
      const title =
        $("h1").first().text().replace(/\s+/g, " ").trim() || card.title;

      const infoLines: string[] = [];
      $(".classifiedInfoList li, ul.classifiedInfoList li").each((_, el) => {
        const t = $(el).text().replace(/\s+/g, " ").trim();
        if (t) infoLines.push(t);
      });

      const desc =
        $("#classifiedDescription, .classifiedDescription, .uiBox.container")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim() ||
        $("[itemprop=description]").text().replace(/\s+/g, " ").trim();

      const seller =
        $(".username-info-area h5, .user-info h5, .storeInfo h3")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim() || "Sahibinden";

      let phone =
        $(".pretty-phone-part, #phoneInfo span, .userContactInfo .phone")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim() || null;
      if (!phone) phone = extractPhone(html);
      if (!phone) phone = extractPhone(desc);

      const dateFromInfo =
        infoLines.find((l) => /ilan tarihi/i.test(l)) || card.dateText;
      const date =
        parseTrDate(dateFromInfo.replace(/ilan tarihi[:\s]*/i, "")) ||
        card.date;

      const location =
        infoLines
          .find((l) => /il\s*\/\s*ilçe|il \/ ilce/i.test(l))
          ?.replace(/.*?:\s*/i, "") || card.location;

      const body = [infoLines.join("\n"), "", desc].filter(Boolean).join("\n");

      return {
        title,
        body,
        phone,
        seller,
        location,
        date,
        url: card.url,
      };
    } catch (err) {
      logger.warn({ err, url: card.url }, "Sahibinden detail fetch failed");
      return null;
    }
  }
}

export const sahibindenService = new SahibindenService();

sahibindenService.start().catch((err) =>
  logger.error({ err }, "Sahibinden auto-start failed"),
);
