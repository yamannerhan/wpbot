import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  type proto,
  type WASocket,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { toDataURL } from "qrcode";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { logger } from "./logger.js";
import { db } from "@workspace/db";
import { whatsappMessagesTable, whatsappConfigTable } from "@workspace/db";
import { eq, desc, asc, inArray, sql } from "drizzle-orm";
import pino from "pino";
import { isPrivateSecurityJobListing } from "./listing-filter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_SUFFIX = process.env.NODE_ENV === "development" ? "-dev" : "";
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR
  ? path.resolve(process.env.WHATSAPP_AUTH_DIR)
  : path.resolve(__dirname, `../../whatsapp-auth${AUTH_SUFFIX}`);

const baileysLogger = pino({ level: "error" });

export type WAState =
  | "disconnected"
  | "connecting"
  | "qr_ready"
  | "pairing_code_ready"
  | "connected";

interface WAStatus {
  connected: boolean;
  state: WAState;
  qrCode: string | null;
  pairingCode: string | null;
  phone: string | null;
  pushName: string | null;
}

interface GroupInfo {
  id: string;
  name: string;
  participantCount: number;
  type: "group" | "channel";
}

type CachedMsgKey = { key: WAMessageKey; tsSeconds: number };
type ConnectSource = "user" | "auto" | "reconnect";

class WhatsAppService {
  private sock: WASocket | null = null;
  private status: WAStatus = {
    connected: false,
    state: "disconnected",
    qrCode: null,
    pairingCode: null,
    phone: null,
    pushName: null,
  };
  private listeningInterval: NodeJS.Timeout | null = null;
  private lastFetchAt: Date | null = null;
  private nextFetchAt: Date | null = null;
  private lastMsgKeyByJid = new Map<string, CachedMsgKey>();
  private groupNameCache = new Map<string, string>();
  private connecting = false;
  private pendingPhone: string | undefined;
  private pairingRequested = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private historyBatchWaiters: Array<() => void> = [];

  getStatus(): WAStatus {
    return { ...this.status };
  }

  isListening(): boolean {
    return this.status.connected && this.listeningInterval !== null;
  }

  getLastFetchAt(): Date | null {
    return this.lastFetchAt;
  }

  getNextFetchAt(): Date | null {
    return this.nextFetchAt;
  }

  private async softEnd(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("creds.update");
        sock.ev.removeAllListeners("messages.upsert");
        sock.ev.removeAllListeners("messaging-history.set");
        sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
    this.connecting = false;
  }

  private async clearAuthDir(): Promise<void> {
    try {
      await fs.rm(AUTH_DIR, { recursive: true, force: true });
      await fs.mkdir(AUTH_DIR, { recursive: true });
      logger.info({ AUTH_DIR }, "Auth session cleared for fresh login");
    } catch (err) {
      logger.error({ err }, "Failed to clear auth dir");
    }
  }

  async connect(
    phoneNumber?: string,
    options?: { source?: ConnectSource },
  ): Promise<WAStatus> {
    const source: ConnectSource = options?.source ?? "user";

    if (this.status.state === "connected" && source !== "reconnect") {
      return this.getStatus();
    }

    await this.softEnd();
    this.stopListening();

    if (source === "user") {
      // Wipe partial/broken session so QR or pairing code always appears
      await this.clearAuthDir();
      this.pendingPhone = phoneNumber?.replace(/\D/g, "") || undefined;
    } else if (source === "auto") {
      this.pendingPhone = undefined;
    } else if (phoneNumber) {
      this.pendingPhone = phoneNumber.replace(/\D/g, "");
    }

    this.pairingRequested = false;
    this.connecting = true;
    this.status = {
      connected: false,
      state: "connecting",
      qrCode: null,
      pairingCode: null,
      phone: null,
      pushName: null,
    };

    try {
      await fs.mkdir(AUTH_DIR, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      // Ubuntu/Chrome required — custom browser names make WhatsApp reject pairing codes
      this.sock = makeWASocket({
        version,
        logger: baileysLogger,
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          const wantPairing =
            Boolean(this.pendingPhone) &&
            !this.pairingRequested &&
            !this.sock?.authState?.creds?.registered;

          if (wantPairing && this.sock && this.pendingPhone) {
            this.pairingRequested = true;
            try {
              await new Promise((r) => setTimeout(r, 1500));
              if (!this.sock) return;

              const code = await this.sock.requestPairingCode(this.pendingPhone);
              const raw = String(code).replace(/\D/g, "");
              const formatted =
                raw.length === 8
                  ? `${raw.slice(0, 4)}-${raw.slice(4)}`
                  : String(code);

              this.status = {
                ...this.status,
                state: "pairing_code_ready",
                pairingCode: formatted,
                qrCode: null,
              };
              this.connecting = false;
              logger.info({ code: formatted }, "Pairing code generated");
            } catch (err) {
              logger.error({ err }, "Pairing code failed — falling back to QR");
              this.pendingPhone = undefined;
              try {
                const qrDataUrl = await toDataURL(qr, { width: 280, margin: 2 });
                this.status = {
                  ...this.status,
                  state: "qr_ready",
                  qrCode: qrDataUrl,
                  pairingCode: null,
                };
                this.connecting = false;
              } catch (qrErr) {
                logger.error({ qrErr }, "QR generation also failed");
              }
            }
          } else if (!this.pendingPhone) {
            try {
              const qrDataUrl = await toDataURL(qr, { width: 280, margin: 2 });
              this.status = {
                ...this.status,
                state: "qr_ready",
                qrCode: qrDataUrl,
                pairingCode: null,
              };
              this.connecting = false;
              logger.info("QR code ready to scan");
            } catch (err) {
              logger.error({ err }, "Failed to generate QR code");
            }
          }
        }

        if (connection === "close") {
          this.connecting = false;
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const isReplaced = statusCode === 440;
          const isRestart =
            statusCode === DisconnectReason.restartRequired ||
            statusCode === 515;

          logger.info(
            { statusCode, isRestart, isLoggedOut, isReplaced },
            "Connection closed",
          );

          const wasConnected = this.status.state === "connected";

          this.status = {
            connected: false,
            state: "disconnected",
            qrCode: null,
            pairingCode: null,
            phone: null,
            pushName: null,
          };
          this.sock = null;
          this.stopListening();

          // After QR/code scan WA sends restartRequired — reconnect SAME auth (do not clear)
          if (
            !isLoggedOut &&
            !isReplaced &&
            (isRestart || wasConnected)
          ) {
            logger.info("Reconnecting with saved session...");
            this.reconnectTimer = setTimeout(() => {
              this.connect(this.pendingPhone, { source: "reconnect" });
            }, 1500);
          } else if (isReplaced) {
            logger.warn("Session replaced — staying disconnected.");
          }
        }

        if (connection === "open") {
          this.connecting = false;
          this.pendingPhone = undefined;
          this.pairingRequested = false;
          const user = this.sock?.user;
          this.status = {
            connected: true,
            state: "connected",
            qrCode: null,
            pairingCode: null,
            phone: user?.id?.split(":")[0] ?? null,
            pushName: user?.name ?? null,
          };
          logger.info({ phone: this.status.phone }, "WhatsApp connected");
          this.startListening();

          setTimeout(() => {
            this.fetchHistory().catch((err) =>
              logger.error({ err }, "Auto history fetch failed"),
            );
          }, 5000);
        }
      });

      this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
        this.cacheMessageKeys(messages);
        if (type === "notify" || type === "append" || type === "prepend") {
          await this.processMessages(messages, type !== "notify");
          if (type === "append" || type === "prepend") {
            this.notifyHistoryBatch();
          }
        }
      });

      this.sock.ev.on(
        "messaging-history.set",
        async ({ messages, syncType, isLatest }) => {
          logger.info(
            { msgCount: messages?.length ?? 0, syncType, isLatest },
            "messaging-history.set received",
          );
          this.cacheMessageKeys(messages ?? []);
          if (messages && messages.length > 0) {
            await this.processMessages(messages, true);
          }
          this.notifyHistoryBatch();
        },
      );
    } catch (err) {
      this.connecting = false;
      logger.error({ err }, "Failed to connect WhatsApp");
      this.status = {
        connected: false,
        state: "disconnected",
        qrCode: null,
        pairingCode: null,
        phone: null,
        pushName: null,
      };
    }

    return this.getStatus();
  }

  async disconnect(): Promise<WAStatus> {
    this.stopListening();
    this.connecting = false;
    this.pendingPhone = undefined;
    this.pairingRequested = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        try {
          this.sock.end(undefined);
        } catch {
          /* ignore */
        }
      }
      this.sock = null;
    }

    await this.clearAuthDir();

    this.status = {
      connected: false,
      state: "disconnected",
      qrCode: null,
      pairingCode: null,
      phone: null,
      pushName: null,
    };

    return this.getStatus();
  }

  async cancelLogin(): Promise<WAStatus> {
    if (this.status.state === "connected") {
      return this.getStatus();
    }
    await this.softEnd();
    this.pendingPhone = undefined;
    this.pairingRequested = false;
    await this.clearAuthDir();
    this.status = {
      connected: false,
      state: "disconnected",
      qrCode: null,
      pairingCode: null,
      phone: null,
      pushName: null,
    };
    return this.getStatus();
  }

  async getGroups(): Promise<GroupInfo[]> {
    if (!this.sock || !this.status.connected) {
      throw new Error("Not connected to WhatsApp");
    }

    const results: GroupInfo[] = [];

    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [id, meta] of Object.entries(groups)) {
        this.groupNameCache.set(id, meta.subject);
        results.push({
          id,
          name: meta.subject,
          participantCount: meta.participants?.length ?? 0,
          type: "group",
        });
      }
    } catch (err) {
      logger.error({ err }, "Failed to fetch groups");
    }

    try {
      const newsletters = await (this.sock as any).newsletterFetchSubscribed();
      if (Array.isArray(newsletters)) {
        for (const nl of newsletters) {
          results.push({
            id: nl.id,
            name: nl.name ?? nl.id,
            participantCount: nl.subscriberCount ?? 0,
            type: "channel",
          });
        }
      }
    } catch (err) {
      logger.debug({ err }, "Could not fetch newsletters");
    }

    if (results.length === 0) {
      throw new Error("Failed to fetch any groups or channels");
    }

    return results.sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }

  async autoConnect(): Promise<void> {
    try {
      const credsPath = path.join(AUTH_DIR, "creds.json");
      const raw = await fs.readFile(credsPath, "utf8");
      const creds = JSON.parse(raw);
      if (creds?.me?.id) {
        logger.info("Saved WhatsApp session found — reconnecting automatically");
        await this.connect(undefined, { source: "auto" });
      }
    } catch {
      /* first run */
    }
  }

  async getSelectedGroupIds(): Promise<string[]> {
    const config = await db
      .select()
      .from(whatsappConfigTable)
      .where(eq(whatsappConfigTable.id, 1))
      .limit(1);
    return config[0]?.selectedGroupIds ?? [];
  }

  async saveSelectedGroupIds(groupIds: string[]): Promise<void> {
    await db
      .insert(whatsappConfigTable)
      .values({ id: 1, selectedGroupIds: groupIds })
      .onConflictDoUpdate({
        target: whatsappConfigTable.id,
        set: { selectedGroupIds: groupIds },
      });

    // Immediately try to pull history for newly selected groups
    if (this.status.connected && groupIds.length > 0) {
      setTimeout(() => {
        this.fetchHistory().catch((err) =>
          logger.error({ err }, "History fetch after group select failed"),
        );
      }, 1000);
    }
  }

  /**
   * Wipe message pool only. Does NOT rescan — use fetchHistory separately.
   * After clear, the same listings can be collected again (content dedupe is empty).
   */
  async clearPoolOnly(): Promise<{ deleted: number; message: string }> {
    const snapshot = await db.select().from(whatsappMessagesTable);
    const deleted = snapshot.length;

    // Keep newest keys so "Geçmiş Tara" still works after wipe
    const newestByGroup = new Map<string, (typeof snapshot)[number]>();
    for (const row of snapshot) {
      const prev = newestByGroup.get(row.groupId);
      if (!prev || row.timestamp > prev.timestamp) {
        newestByGroup.set(row.groupId, row);
      }
    }
    for (const [jid, row] of newestByGroup) {
      this.lastMsgKeyByJid.set(jid, {
        key: {
          id: row.messageId,
          remoteJid: jid,
          fromMe: false,
        },
        tsSeconds: Math.floor(
          (row.timestamp instanceof Date
            ? row.timestamp
            : new Date(row.timestamp as unknown as string)
          ).getTime() / 1000,
        ),
      });
    }

    await db.delete(whatsappMessagesTable);
    logger.info({ deleted }, "Pool cleared (no auto-rescan)");

    return {
      deleted,
      message:
        deleted > 0
          ? `Havuz temizlendi (${deleted} ilan silindi). Yeniden tarama için "Geçmiş Tara"ya bas.`
          : "Havuz zaten boş.",
    };
  }

  private notifyHistoryBatch(): void {
    const waiters = this.historyBatchWaiters.splice(0);
    for (const w of waiters) w();
  }

  private waitForHistoryBatch(timeoutMs = 4500): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.historyBatchWaiters = this.historyBatchWaiters.filter(
          (w) => w !== onBatch,
        );
        resolve(false);
      }, timeoutMs);
      const onBatch = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.historyBatchWaiters.push(onBatch);
    });
  }

  private async countPoolMessages(): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable);
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Pull history for selected groups:
   * - Go back as far as WhatsApp allows, capped at 15 days
   * - If fewer messages exist, stop when WhatsApp has nothing older
   * Live listening continues separately via messages.upsert while connected.
   */
  async fetchHistory(): Promise<{ triggered: number; storedHint: string }> {
    if (!this.sock || !this.status.connected) {
      throw new Error("Not connected to WhatsApp");
    }

    const selectedGroupIds = await this.getSelectedGroupIds();
    if (selectedGroupIds.length === 0) {
      return {
        triggered: 0,
        storedHint: "Önce Gruplar sekmesinden grup seçin",
      };
    }

    const beforeCount = await this.countPoolMessages();
    const fifteenDaysAgoSec = Math.floor(
      (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000,
    );
    let triggered = 0;

    for (const jid of selectedGroupIds) {
      try {
        await this.sock.presenceSubscribe(jid).catch(() => undefined);

        // Paginate backwards until 15-day cap OR WhatsApp has no older msgs
        for (let round = 0; round < 25; round++) {
          const oldest = await this.resolveOldestMessageKey(jid);
          const newest = await this.resolveNewestMessageKey(jid);
          const keyInfo = oldest ?? newest;

          if (!keyInfo?.key?.id) {
            logger.warn(
              { jid, round },
              "No message key yet — live listener will catch new listings",
            );
            break;
          }

          // Hard stop: do not request older than 15 days
          if (oldest && oldest.tsSeconds <= fifteenDaysAgoSec) {
            logger.info({ jid }, "Reached max 15-day lookback");
            break;
          }

          const tsSeconds =
            keyInfo.tsSeconds > 1e12
              ? Math.floor(keyInfo.tsSeconds / 1000)
              : keyInfo.tsSeconds;

          logger.info(
            { jid, round, msgId: keyInfo.key.id, tsSeconds },
            "History page request",
          );

          const prevOldestTs = oldest?.tsSeconds ?? null;
          await this.sock.fetchMessageHistory(50, keyInfo.key, tsSeconds);
          triggered++;

          const gotBatch = await this.waitForHistoryBatch(5000);
          await new Promise((r) => setTimeout(r, 350));

          const nextOldest = await this.resolveOldestMessageKey(jid);
          // WhatsApp gave nothing older → stop (even if < 15 days)
          if (
            !gotBatch ||
            !nextOldest ||
            (prevOldestTs !== null && nextOldest.tsSeconds >= prevOldestTs)
          ) {
            logger.info(
              { jid, round },
              "No older messages available — stopping lookback for group",
            );
            break;
          }
        }
      } catch (err) {
        logger.error({ err, jid }, "Failed to fetch history for group");
      }
    }

    this.lastFetchAt = new Date();
    this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);

    await db
      .insert(whatsappConfigTable)
      .values({ id: 1, selectedGroupIds, lastFetchAt: this.lastFetchAt })
      .onConflictDoUpdate({
        target: whatsappConfigTable.id,
        set: { lastFetchAt: this.lastFetchAt },
      });

    await new Promise((r) => setTimeout(r, 3000));
    const afterCount = await this.countPoolMessages();
    const added = Math.max(0, afterCount - beforeCount);

    logger.info(
      { triggered, added, groups: selectedGroupIds.length },
      "History sync finished — live listening remains active",
    );

    if (triggered === 0 && added === 0) {
      return {
        triggered: 0,
        storedHint:
          "Geçmiş az geldi veya anahtar yok. Dinleme açık: yeni ilan gelince otomatik havuza düşer. Bir mesaj sonrası tekrar 'Geçmiş Çek' deneyebilirsin.",
      };
    }

    return {
      triggered,
      storedHint: `${selectedGroupIds.length} grup tarandı (max 15 gün) — ${added} yeni ilan eklendi. Dinleme açık, yeni gelenler otomatik alınır.`,
    };
  }

  private async resolveNewestMessageKey(
    jid: string,
  ): Promise<CachedMsgKey | null> {
    const cached = this.lastMsgKeyByJid.get(jid);
    if (cached?.key?.id) return cached;

    try {
      const rows = await db
        .select()
        .from(whatsappMessagesTable)
        .where(eq(whatsappMessagesTable.groupId, jid))
        .orderBy(desc(whatsappMessagesTable.timestamp))
        .limit(1);

      const latest = rows[0];
      if (latest?.messageId) {
        const info: CachedMsgKey = {
          key: {
            id: latest.messageId,
            remoteJid: jid,
            fromMe: false,
          },
          tsSeconds: Math.floor(latest.timestamp.getTime() / 1000),
        };
        this.lastMsgKeyByJid.set(jid, info);
        return info;
      }
    } catch (err) {
      logger.debug({ err, jid }, "DB newest key lookup failed");
    }

    return null;
  }

  private async resolveOldestMessageKey(
    jid: string,
  ): Promise<CachedMsgKey | null> {
    try {
      const rows = await db
        .select()
        .from(whatsappMessagesTable)
        .where(eq(whatsappMessagesTable.groupId, jid))
        .orderBy(asc(whatsappMessagesTable.timestamp))
        .limit(1);

      const oldest = rows[0];
      if (oldest?.messageId) {
        return {
          key: {
            id: oldest.messageId,
            remoteJid: jid,
            fromMe: false,
          },
          tsSeconds: Math.floor(oldest.timestamp.getTime() / 1000),
        };
      }
    } catch (err) {
      logger.debug({ err, jid }, "DB oldest key lookup failed");
    }
    return null;
  }

  private cacheMessageKeys(messages: proto.IWebMessageInfo[]): void {
    for (const msg of messages) {
      if (!msg.key?.remoteJid || !msg.key?.id) continue;
      const jid = msg.key.remoteJid;
      if (!jid.endsWith("@g.us") && !jid.endsWith("@newsletter")) continue;

      let ts = Number(msg.messageTimestamp ?? 0);
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      if (!ts) ts = Math.floor(Date.now() / 1000);

      this.lastMsgKeyByJid.set(jid, { key: msg.key, tsSeconds: ts });

      const alt = (msg.key as { remoteJidAlt?: string }).remoteJidAlt;
      if (alt) {
        this.lastMsgKeyByJid.set(alt, { key: msg.key, tsSeconds: ts });
      }
    }
  }

  private async processMessages(
    messages: proto.IWebMessageInfo[],
    isHistory = false,
  ): Promise<void> {
    const selectedGroupIds = await this.getSelectedGroupIds();
    if (selectedGroupIds.length === 0) return;

    const selectedSet = new Set(selectedGroupIds);
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

    const toInsert: Array<{
      messageId: string;
      groupId: string;
      groupName: string;
      content: string;
      sender: string;
      timestamp: Date;
    }> = [];

    // Skip only exact same listing text within this batch
    const batchContents = new Set<string>();
    let skippedNotListing = 0;
    let skippedExactDup = 0;

    for (const msg of messages) {
      if (!msg.key?.remoteJid || !msg.key?.id) continue;

      const jid = msg.key.remoteJid;
      const alt = (msg.key as { remoteJidAlt?: string }).remoteJidAlt;
      const isGroup = jid.endsWith("@g.us") || Boolean(alt?.endsWith("@g.us"));
      const isChannel =
        jid.endsWith("@newsletter") || Boolean(alt?.endsWith("@newsletter"));
      if (!isGroup && !isChannel) continue;

      const matchedJid = selectedSet.has(jid)
        ? jid
        : alt && selectedSet.has(alt)
          ? alt
          : null;
      if (!matchedJid) continue;

      const text = extractText(msg);
      if (!text) continue;
      const content = normalizeListingContent(text);
      if (!content) continue;

      // Only özel güvenlik job listings — skip normal chat
      if (!isPrivateSecurityJobListing(content)) {
        skippedNotListing++;
        continue;
      }

      // Exact same content only → duplicate (pool-wide / batch)
      if (batchContents.has(content)) {
        skippedExactDup++;
        continue;
      }
      batchContents.add(content);

      let tsSeconds = Number(msg.messageTimestamp ?? 0);
      if (tsSeconds > 1e12) tsSeconds = Math.floor(tsSeconds / 1000);
      const msgDate = tsSeconds ? new Date(tsSeconds * 1000) : new Date();

      // History lookback capped at 15 days. Live messages always accepted.
      if (isHistory && tsSeconds && msgDate < fifteenDaysAgo) continue;

      const sender = msg.key.fromMe
        ? (this.status.phone ?? "me")
        : ((msg as { participant?: string }).participant ??
          msg.key.participant ??
          msg.pushName ??
          "unknown");

      const groupName = await this.getGroupName(matchedJid);

      toInsert.push({
        messageId: msg.key.id,
        groupId: matchedJid,
        groupName,
        content,
        sender: String(sender),
        timestamp: msgDate,
      });
    }

    if (toInsert.length === 0) {
      if (skippedNotListing > 0 || skippedExactDup > 0) {
        logger.info(
          { skippedNotListing, skippedExactDup, isHistory },
          "No new listings to store after filters",
        );
      }
      return;
    }

    try {
      // Drop rows whose content already exists in the pool (exact match only)
      const contents = toInsert.map((r) => r.content);
      const existing = await db
        .select({ content: whatsappMessagesTable.content })
        .from(whatsappMessagesTable)
        .where(inArray(whatsappMessagesTable.content, contents));

      const existingSet = new Set(
        existing.map((e) => normalizeListingContent(e.content)),
      );
      const uniqueRows = toInsert.filter((r) => !existingSet.has(r.content));
      const dbExactDup = toInsert.length - uniqueRows.length;

      if (uniqueRows.length === 0) {
        logger.info(
          {
            skipped: toInsert.length,
            skippedNotListing,
            skippedExactDup,
            dbExactDup,
            isHistory,
          },
          "All candidate listings were exact duplicates — skipped",
        );
        return;
      }

      await db
        .insert(whatsappMessagesTable)
        .values(uniqueRows)
        .onConflictDoNothing();

      if (!isHistory) {
        this.lastFetchAt = new Date();
        this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
      }

      logger.info(
        {
          stored: uniqueRows.length,
          skippedNotListing,
          skippedExactDup,
          dbExactDup,
          isHistory,
        },
        "Listings stored",
      );
    } catch (err) {
      logger.error({ err }, "Failed to store messages");
    }
  }

  private async getGroupName(jid: string): Promise<string> {
    if (this.groupNameCache.has(jid)) {
      return this.groupNameCache.get(jid)!;
    }

    try {
      if (this.sock && jid.endsWith("@g.us")) {
        const meta = await this.sock.groupMetadata(jid);
        const name = meta.subject;
        this.groupNameCache.set(jid, name);
        return name;
      }
    } catch {
      /* ignore */
    }

    return jid;
  }

  private startListening(): void {
    this.stopListening();
    // Live listings are captured in real time via messages.upsert while connected.
    // Periodic fetch tops up anything WhatsApp exposes within the 15-day window.
    this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
    this.listeningInterval = setInterval(async () => {
      if (!this.status.connected || !this.sock) return;
      logger.info("Periodic sync — still listening, refreshing history window");
      this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
      try {
        await this.fetchHistory();
      } catch (err) {
        logger.error({ err }, "Scheduled history fetch failed");
      }
    }, 30 * 60 * 1000);
    logger.info("Continuous listening ON — new listings go to pool immediately");
  }

  private stopListening(): void {
    if (this.listeningInterval) {
      clearInterval(this.listeningInterval);
      this.listeningInterval = null;
    }
    this.nextFetchAt = null;
  }
}

/** Exact listing text only — tiny salary/phone/name differences stay as separate ads. */
function normalizeListingContent(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function extractText(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;

  // Unwrap common wrappers
  const inner =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message ||
    m.documentWithCaptionMessage?.message ||
    m.templateMessage?.hydratedFourRowTemplate ||
    m;

  const hydrated = (inner as typeof m)?.templateMessage?.hydratedTemplate;

  return (
    (inner as typeof m)?.conversation ||
    (inner as typeof m)?.extendedTextMessage?.text ||
    (inner as typeof m)?.imageMessage?.caption ||
    (inner as typeof m)?.videoMessage?.caption ||
    (inner as typeof m)?.documentMessage?.caption ||
    (inner as typeof m)?.buttonsMessage?.contentText ||
    (inner as typeof m)?.listMessage?.description ||
    hydrated?.hydratedContentText ||
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null
  );
}

export const whatsappService = new WhatsAppService();

whatsappService.autoConnect().catch(() => {
  /* silent */
});
