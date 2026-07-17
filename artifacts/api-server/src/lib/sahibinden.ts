import * as cheerio from "cheerio";
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
const GROUP_ID = "sahibinden:guvenlik";
const GROUP_NAME = "Sahibinden";

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
];

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
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(min = 1800, max = 4200) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

function pickUa() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]!;
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

class SahibindenService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private nextFetchAt: Date | null = null;
  private lastAdded = 0;
  private lastError: string | null = null;

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
    // First pull shortly after boot
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
    };
  }

  private async patchConfig(
    patch: Partial<{
      sahibindenUrl: string;
      sahibindenLastFetchAt: Date;
      sahibindenListening: boolean;
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
      })
      .where(eq(whatsappConfigTable.id, 1));
  }

  async setUrl(url: string): Promise<void> {
    const clean = url.trim() || DEFAULT_URL;
    await this.patchConfig({ sahibindenUrl: clean });
  }

  async getStatus(): Promise<Status> {
    const cfg = await this.getConfig();
    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(like(whatsappMessagesTable.groupId, "sahibinden:%"));
    return {
      listening: cfg.listening && this.timer !== null,
      url: cfg.url,
      lastFetchAt: cfg.lastFetchAt?.toISOString() ?? null,
      nextFetchAt: this.nextFetchAt?.toISOString() ?? null,
      total: Number(countRows[0]?.count ?? 0),
      lastAdded: this.lastAdded,
      lastError: this.lastError,
    };
  }

  async list(limit = 100, offset = 0, search?: string) {
    const rows = await db
      .select()
      .from(whatsappMessagesTable)
      .where(like(whatsappMessagesTable.groupId, "sahibinden:%"))
      .orderBy(sql`${whatsappMessagesTable.timestamp} desc`)
      .limit(limit)
      .offset(offset);

    let filtered = rows;
    if (search?.trim()) {
      const q = search.trim().toLocaleLowerCase("tr-TR");
      filtered = rows.filter(
        (r) =>
          r.content.toLocaleLowerCase("tr-TR").includes(q) ||
          r.sender.toLocaleLowerCase("tr-TR").includes(q),
      );
    }

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
      await db.insert(whatsappMessagesArchiveTable).values(existing).onConflictDoNothing();
    }
    await db
      .delete(whatsappMessagesTable)
      .where(like(whatsappMessagesTable.groupId, "sahibinden:%"));

    // After clear: deep rescan (max 15 days) then keep listening
    void this.scan({ deep: true }).catch((err) =>
      logger.error({ err }, "Sahibinden post-clear deep scan failed"),
    );
    await this.enableListen();

    return {
      deleted: existing.length,
      message: `Sahibinden havuzu temizlendi (${existing.length}). Son 15 gün yeniden taranıyor; dinleme açık.`,
    };
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
      const cfg = await this.getConfig();
      const urls = Array.from(
        new Set([cfg.url || DEFAULT_URL, GENERAL_URL]),
      );

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
          if (exists.length) continue; // already in pool — skip (clear → deep rescan fills empty)

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

  private async fetchHtml(url: string, referer?: string): Promise<string> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": pickUa(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const html = await res.text();
    if (
      /giriş yap|login|cloudflare|captcha|access denied|bot/i.test(html) &&
      html.length < 5000
    ) {
      throw new Error(
        "Sahibinden bot koruması / giriş engeli olabilir. Bir süre sonra tekrar denenecek.",
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
      if (page > 1) await humanDelay(2500, 5500);
      const html = await this.fetchHtml(url, "https://www.sahibinden.com/");
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
        },
      );

      // Fallback: any ilan links on page
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
        infoLines.find((l) => /il\s*\/\s*ilçe|il \/ ilce/i.test(l))?.replace(
          /.*?:\s*/i,
          "",
        ) || card.location;

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

// Auto-start listening when API boots
sahibindenService.start().catch((err) =>
  logger.error({ err }, "Sahibinden auto-start failed"),
);
