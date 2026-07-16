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
import { eq, desc, inArray, sql } from "drizzle-orm";
import pino from "pino";
import { isPrivateSecurityJobListing } from "./listing-filter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_SUFFIX = process.env.NODE_ENV === "development" ? "-dev" : "";
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR
  ? path.resolve(process.env.WHATSAPP_AUTH_DIR)
  : path.resolve(__dirname, `../../whatsapp-auth${AUTH_SUFFIX}`);

const baileysLogger = pino({ level: "error" });

/** Periodic top-up while connected (live upserts still instant). */
const LISTEN_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_LOOKBACK_MS = 15 * 24 * 60 * 60 * 1000;
const HISTORY_PAGE_SIZE = 80;
const HISTORY_MAX_ROUNDS = 60;
const HISTORY_BATCH_WAIT_MS = 12_000;

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
  /** Newest WA message key per chat (any message, not only listings). */
  private newestMsgKeyByJid = new Map<string, CachedMsgKey>();
  /** Oldest WA message key per chat — drives 15-day pagination cursor. */
  private oldestMsgKeyByJid = new Map<string, CachedMsgKey>();
  private groupNameCache = new Map<string, string>();
  /** Channels discovered from WA sync / newsletter APIs (survive list refresh). */
  private knownChannels = new Map<string, GroupInfo>();
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
        sock.ev.removeAllListeners("chats.upsert");
        sock.ev.removeAllListeners("chats.set");
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
        this.rememberChatsFromMessages(messages);
        if (type === "notify" || type === "append" || type === "prepend") {
          await this.processMessages(messages, type !== "notify");
          if (type === "append" || type === "prepend") {
            this.notifyHistoryBatch();
          }
        }
      });

      this.sock.ev.on(
        "messaging-history.set",
        async ({ messages, chats, syncType, isLatest }) => {
          logger.info(
            {
              msgCount: messages?.length ?? 0,
              chatCount: chats?.length ?? 0,
              syncType,
              isLatest,
            },
            "messaging-history.set received",
          );
          this.cacheMessageKeys(messages ?? []);
          this.rememberChatsFromMessages(messages ?? []);
          this.rememberChatsFromChatList(chats ?? []);
          if (messages && messages.length > 0) {
            await this.processMessages(messages, true);
          }
          this.notifyHistoryBatch();
        },
      );

      this.sock.ev.on("chats.upsert", (chats) => {
        this.rememberChatsFromChatList(chats ?? []);
      });

      this.sock.ev.on("chats.set", ({ chats }) => {
        this.rememberChatsFromChatList(chats ?? []);
      });
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

    const byId = new Map<string, GroupInfo>();

    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [id, meta] of Object.entries(groups)) {
        this.groupNameCache.set(id, meta.subject);
        byId.set(id, {
          id,
          name: meta.subject,
          participantCount: meta.participants?.length ?? 0,
          type: "group",
        });
      }
    } catch (err) {
      logger.error({ err }, "Failed to fetch groups");
    }

    // Subscribed WhatsApp Channels (newsletters)
    await this.refreshSubscribedChannels();
    for (const [id, ch] of this.knownChannels) {
      if (!byId.has(id)) byId.set(id, ch);
    }

    const results = Array.from(byId.values());
    if (results.length === 0) {
      throw new Error("Failed to fetch any groups or channels");
    }

    logger.info(
      {
        groups: results.filter((r) => r.type === "group").length,
        channels: results.filter((r) => r.type === "channel").length,
      },
      "Listed groups and channels",
    );

    return results.sort((a, b) => {
      if (a.type !== b.type) return a.type === "group" ? -1 : 1;
      return a.name.localeCompare(b.name, "tr");
    });
  }

  private async refreshSubscribedChannels(): Promise<void> {
    if (!this.sock) return;
    const sock = this.sock as any;

    const tryParseList = (raw: unknown): void => {
      const list = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object"
          ? Array.isArray((raw as { newsletters?: unknown }).newsletters)
            ? (raw as { newsletters: unknown[] }).newsletters
            : Array.isArray((raw as { data?: unknown }).data)
              ? (raw as { data: unknown[] }).data
              : Object.values(raw as Record<string, unknown>)
          : [];

      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const nl = item as Record<string, unknown>;
        const id = String(
          nl.id ?? nl.jid ?? nl.newsletterJid ?? nl.newsletter_id ?? "",
        );
        if (!id.includes("@newsletter")) continue;
        const name = String(
          nl.name ??
            nl.subject ??
            nl.title ??
            nl.notify ??
            this.groupNameCache.get(id) ??
            id,
        );
        const participantCount = Number(
          nl.subscribersCount ??
            nl.subscriberCount ??
            nl.subscribers_count ??
            nl.subscribers ??
            0,
        );
        this.registerChannel(id, name, participantCount);
      }
    };

    for (const fnName of [
      "newsletterFetchSubscribed",
      "newsletterFetchAllSubscribed",
      "fetchSubscribedNewsletters",
    ]) {
      try {
        if (typeof sock[fnName] !== "function") continue;
        const raw = await sock[fnName]();
        tryParseList(raw);
      } catch (err) {
        logger.debug({ err, fnName }, "Channel list API failed");
      }
    }
  }

  private registerChannel(
    id: string,
    name?: string,
    participantCount = 0,
  ): void {
    if (!id?.endsWith("@newsletter")) return;
    const display =
      (name && name !== id ? name : null) ||
      this.groupNameCache.get(id) ||
      id;
    this.groupNameCache.set(id, display);
    const prev = this.knownChannels.get(id);
    this.knownChannels.set(id, {
      id,
      name: display,
      participantCount: participantCount || prev?.participantCount || 0,
      type: "channel",
    });
  }

  private rememberChatsFromChatList(chats: unknown[]): void {
    for (const chat of chats ?? []) {
      if (!chat || typeof chat !== "object") continue;
      const c = chat as Record<string, unknown>;
      const id = String(c.id ?? "");
      if (!id.endsWith("@newsletter")) continue;
      const name = String(
        c.name ?? c.subject ?? c.verifiedName ?? c.notify ?? id,
      );
      this.registerChannel(id, name);
    }
  }

  private rememberChatsFromMessages(messages: proto.IWebMessageInfo[]): void {
    for (const msg of messages ?? []) {
      const jid = msg.key?.remoteJid;
      const alt = (msg.key as { remoteJidAlt?: string } | null)?.remoteJidAlt;
      for (const id of [jid, alt]) {
        if (id?.endsWith("@newsletter")) {
          const push =
            (msg as { pushName?: string }).pushName ||
            this.groupNameCache.get(id);
          this.registerChannel(id, push);
        }
      }
    }
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
   * Keeps in-memory WA cursors so "Yeniden Tara" can still walk history.
   * Duplicate check is exact content only; after clear, same texts can return.
   */
  async clearPoolOnly(): Promise<{ deleted: number; message: string }> {
    const snapshot = await db.select().from(whatsappMessagesTable);
    const deleted = snapshot.length;

    // Preserve cursors from wiped rows (fallback if live cache is empty)
    for (const row of snapshot) {
      const tsSeconds = Math.floor(
        (row.timestamp instanceof Date
          ? row.timestamp
          : new Date(row.timestamp as unknown as string)
        ).getTime() / 1000,
      );
      const info: CachedMsgKey = {
        key: {
          id: row.messageId,
          remoteJid: row.groupId,
          fromMe: false,
        },
        tsSeconds,
      };
      this.rememberMsgKey(row.groupId, info);
    }

    await db.delete(whatsappMessagesTable);
    logger.info({ deleted }, "Pool cleared (no auto-rescan)");

    return {
      deleted,
      message:
        deleted > 0
          ? `Havuz temizlendi (${deleted} ilan silindi). Yeniden tarama için "Yeniden Tara"ya bas.`
          : "Havuz zaten boş.",
    };
  }

  private notifyHistoryBatch(): void {
    const waiters = this.historyBatchWaiters.splice(0);
    for (const w of waiters) w();
  }

  private waitForHistoryBatch(timeoutMs = HISTORY_BATCH_WAIT_MS): Promise<boolean> {
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
   * - Paginate using ALL WhatsApp message keys (not only stored listings)
   * - Cap at 15 days; stop when WA has nothing older
   * Live listening continues via messages.upsert.
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
      (Date.now() - HISTORY_LOOKBACK_MS) / 1000,
    );
    let triggered = 0;

    for (const jid of selectedGroupIds) {
      try {
        await this.sock.presenceSubscribe(jid).catch(() => undefined);

        for (let round = 0; round < HISTORY_MAX_ROUNDS; round++) {
          const cursor =
            this.oldestMsgKeyByJid.get(jid) ??
            this.newestMsgKeyByJid.get(jid) ??
            (await this.resolveNewestMessageKeyFromDb(jid));

          if (!cursor?.key?.id) {
            logger.warn(
              { jid, round },
              "No message key yet — live listener will catch new listings",
            );
            break;
          }

          if (cursor.tsSeconds <= fifteenDaysAgoSec) {
            logger.info({ jid }, "Reached max 15-day lookback");
            break;
          }

          const prevOldestTs =
            this.oldestMsgKeyByJid.get(jid)?.tsSeconds ?? cursor.tsSeconds;

          logger.info(
            {
              jid,
              round,
              msgId: cursor.key.id,
              tsSeconds: cursor.tsSeconds,
            },
            "History page request",
          );

          await this.sock.fetchMessageHistory(
            HISTORY_PAGE_SIZE,
            cursor.key,
            cursor.tsSeconds > 1e12
              ? Math.floor(cursor.tsSeconds / 1000)
              : cursor.tsSeconds,
          );
          triggered++;

          const gotBatch = await this.waitForHistoryBatch(HISTORY_BATCH_WAIT_MS);
          await new Promise((r) => setTimeout(r, 400));

          const nextOldest = this.oldestMsgKeyByJid.get(jid);
          const advanced =
            nextOldest != null && nextOldest.tsSeconds < prevOldestTs;

          if (!advanced) {
            logger.info(
              { jid, round, gotBatch, prevOldestTs, nextTs: nextOldest?.tsSeconds },
              "No older messages available — stopping lookback for group",
            );
            break;
          }

          if (nextOldest.tsSeconds <= fifteenDaysAgoSec) {
            logger.info({ jid }, "Reached max 15-day lookback");
            break;
          }
        }
      } catch (err) {
        logger.error({ err, jid }, "Failed to fetch history for group");
      }
    }

    this.lastFetchAt = new Date();
    this.nextFetchAt = new Date(Date.now() + LISTEN_INTERVAL_MS);

    await db
      .insert(whatsappConfigTable)
      .values({ id: 1, selectedGroupIds, lastFetchAt: this.lastFetchAt })
      .onConflictDoUpdate({
        target: whatsappConfigTable.id,
        set: { lastFetchAt: this.lastFetchAt },
      });

    await new Promise((r) => setTimeout(r, 2500));
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
          "Geçmiş az geldi veya anahtar yok. Dinleme açık: yeni ilan gelince otomatik havuza düşer. Bir mesaj sonrası tekrar 'Yeniden Tara' deneyebilirsin.",
      };
    }

    return {
      triggered,
      storedHint: `${selectedGroupIds.length} kaynak tarandı (grup+kanal, max 15 gün) — ${added} yeni ilan eklendi. Dinleme açık, yeni gelenler otomatik alınır.`,
    };
  }

  private async resolveNewestMessageKeyFromDb(
    jid: string,
  ): Promise<CachedMsgKey | null> {
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
        this.rememberMsgKey(jid, info);
        return info;
      }
    } catch (err) {
      logger.debug({ err, jid }, "DB newest key lookup failed");
    }
    return null;
  }

  private rememberMsgKey(jid: string, info: CachedMsgKey): void {
    if (!jid || !info.key?.id || !info.tsSeconds) return;

    const newest = this.newestMsgKeyByJid.get(jid);
    if (!newest || info.tsSeconds >= newest.tsSeconds) {
      this.newestMsgKeyByJid.set(jid, info);
    }

    const oldest = this.oldestMsgKeyByJid.get(jid);
    if (!oldest || info.tsSeconds <= oldest.tsSeconds) {
      this.oldestMsgKeyByJid.set(jid, info);
    }
  }

  private cacheMessageKeys(messages: proto.IWebMessageInfo[]): void {
    for (const msg of messages) {
      if (!msg.key?.remoteJid || !msg.key?.id) continue;
      const jid = msg.key.remoteJid;
      const alt = (msg.key as { remoteJidAlt?: string }).remoteJidAlt;
      const isGroup =
        jid.endsWith("@g.us") || Boolean(alt?.endsWith("@g.us"));
      const isChannel =
        jid.endsWith("@newsletter") || Boolean(alt?.endsWith("@newsletter"));
      if (!isGroup && !isChannel) continue;

      let ts = Number(msg.messageTimestamp ?? 0);
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      if (!ts) ts = Math.floor(Date.now() / 1000);

      const info: CachedMsgKey = { key: msg.key, tsSeconds: ts };
      this.rememberMsgKey(jid, info);
      if (alt) this.rememberMsgKey(alt, info);
    }
  }

  private async processMessages(
    messages: proto.IWebMessageInfo[],
    isHistory = false,
  ): Promise<void> {
    const selectedGroupIds = await this.getSelectedGroupIds();
    if (selectedGroupIds.length === 0) return;

    const selectedSet = new Set(selectedGroupIds);
    const fifteenDaysAgo = new Date(Date.now() - HISTORY_LOOKBACK_MS);

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
        this.nextFetchAt = new Date(Date.now() + LISTEN_INTERVAL_MS);
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
      if (this.sock && jid.endsWith("@newsletter")) {
        const cached = this.knownChannels.get(jid);
        if (cached?.name) {
          this.groupNameCache.set(jid, cached.name);
          return cached.name;
        }
        try {
          const meta = await (this.sock as any).newsletterMetadata?.(
            "jid",
            jid,
          );
          const name = String(meta?.name ?? meta?.subject ?? jid);
          this.registerChannel(jid, name, Number(meta?.subscribersCount ?? 0));
          return name;
        } catch {
          /* ignore */
        }
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
    this.nextFetchAt = new Date(Date.now() + LISTEN_INTERVAL_MS);
    this.listeningInterval = setInterval(async () => {
      if (!this.status.connected || !this.sock) return;
      logger.info("Periodic sync (5 dk) — refreshing history window");
      this.nextFetchAt = new Date(Date.now() + LISTEN_INTERVAL_MS);
      try {
        await this.fetchHistory();
      } catch (err) {
        logger.error({ err }, "Scheduled history fetch failed");
      }
    }, LISTEN_INTERVAL_MS);
    logger.info("Continuous listening ON — sync every 5 minutes");
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
