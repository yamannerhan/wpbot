import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type proto,
  type WASocket,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { toDataURL } from "qrcode";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { db } from "@workspace/db";
import { whatsappMessagesTable, whatsappConfigTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import pino from "pino";

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
  /** Last seen message key per chat — required for on-demand history */
  private lastMsgKeyByJid = new Map<string, CachedMsgKey>();
  private groupNameCache = new Map<string, string>();
  private connecting = false;

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

  async connect(phoneNumber?: string): Promise<WAStatus> {
    if (this.status.state === "connected") {
      return this.getStatus();
    }
    if (this.status.state === "pairing_code_ready") {
      return this.getStatus();
    }
    if (this.connecting) {
      return this.getStatus();
    }
    this.connecting = true;

    this.status = {
      connected: false,
      state: "connecting",
      qrCode: null,
      pairingCode: null,
      phone: null,
      pushName: null,
    };

    const normalizedPhone = phoneNumber?.replace(/\D/g, "") || undefined;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        logger: baileysLogger,
        printQRInTerminal: false,
        auth: state,
        browser: ["Ilan Toplayici Bot", "Chrome", "120.0.0"],
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (normalizedPhone && this.sock) {
            try {
              const code = await this.sock.requestPairingCode(normalizedPhone);
              const formatted =
                code.length === 8
                  ? `${code.slice(0, 4)}-${code.slice(4)}`
                  : code;
              this.status = {
                ...this.status,
                state: "pairing_code_ready",
                pairingCode: formatted,
                qrCode: null,
              };
              logger.info({ code: formatted }, "Pairing code generated");
            } catch (err) {
              logger.error({ err }, "Failed to request pairing code");
              try {
                const qrDataUrl = await toDataURL(qr, { width: 256, margin: 2 });
                this.status = {
                  ...this.status,
                  state: "qr_ready",
                  qrCode: qrDataUrl,
                };
              } catch {
                /* ignore */
              }
            }
          } else {
            try {
              const qrDataUrl = await toDataURL(qr, { width: 256, margin: 2 });
              this.status = {
                ...this.status,
                state: "qr_ready",
                qrCode: qrDataUrl,
              };
              logger.info("QR code ready to scan");
            } catch (err) {
              logger.error({ err }, "Failed to generate QR code");
            }
          }
        }

        if (connection === "close") {
          this.connecting = false;
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const isReplaced = statusCode === 440;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          logger.info({ statusCode, shouldReconnect, isReplaced }, "Connection closed");

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

          if (shouldReconnect && !isReplaced) {
            logger.info("Reconnecting in 3 seconds...");
            setTimeout(() => this.connect(), 3000);
          } else if (isReplaced) {
            logger.warn(
              "Session replaced by another instance — staying disconnected.",
            );
          }
        }

        if (connection === "open") {
          this.connecting = false;
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

          // After connect, try a delayed history pull for selected groups
          setTimeout(() => {
            this.fetchHistory().catch((err) =>
              logger.error({ err }, "Auto history fetch failed"),
            );
          }, 5000);
        }
      });

      // notify = live, append/prepend = history chunks
      this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
        this.cacheMessageKeys(messages);
        if (type === "notify" || type === "append" || type === "prepend") {
          await this.processMessages(messages, type !== "notify");
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

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        this.sock.end(undefined);
      }
      this.sock = null;
    }

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
      const fs = await import("node:fs/promises");
      const credsPath = path.join(AUTH_DIR, "creds.json");
      const raw = await fs.readFile(credsPath, "utf8");
      const creds = JSON.parse(raw);
      if (creds?.me?.id) {
        logger.info("Saved WhatsApp session found — reconnecting automatically");
        await this.connect();
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
   * Trigger on-demand history for selected groups.
   * Requires a real message key (from live traffic or DB). Timestamp must be SECONDS.
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

    let triggered = 0;

    for (const jid of selectedGroupIds) {
      try {
        const keyInfo = await this.resolveMessageKey(jid);
        if (!keyInfo) {
          logger.warn(
            { jid },
            "No message key yet for history sync — will capture new messages live",
          );
          // Nudge WhatsApp to sync this chat
          try {
            await this.sock.presenceSubscribe(jid);
          } catch {
            /* ignore */
          }
          continue;
        }

        const tsSeconds =
          keyInfo.tsSeconds > 1e12
            ? Math.floor(keyInfo.tsSeconds / 1000)
            : keyInfo.tsSeconds;

        logger.info(
          { jid, msgId: keyInfo.key.id, tsSeconds },
          "Triggering on-demand history sync",
        );

        await this.sock.fetchMessageHistory(100, keyInfo.key, tsSeconds);
        triggered++;
        await new Promise((r) => setTimeout(r, 600));
      } catch (err) {
        logger.error({ err, jid }, "Failed to trigger history sync");
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

    // Give history events a moment to land
    await new Promise((r) => setTimeout(r, 2500));

    logger.info(
      { triggered, total: selectedGroupIds.length },
      "History sync triggered",
    );

    if (triggered === 0) {
      return {
        triggered: 0,
        storedHint:
          "Henüz geçmiş anahtarı yok. Gruplarda yeni mesaj gelince otomatik kaydedilir; sonra tekrar 'Geçmiş Çek' deneyin.",
      };
    }

    return {
      triggered,
      storedHint: `${triggered} grup için geçmiş isteği gönderildi. Mesajlar birkaç saniye içinde havuza düşer.`,
    };
  }

  private async resolveMessageKey(jid: string): Promise<CachedMsgKey | null> {
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
      logger.debug({ err, jid }, "DB key lookup failed");
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
      if (!text || text.trim().length === 0) continue;

      let tsSeconds = Number(msg.messageTimestamp ?? 0);
      if (tsSeconds > 1e12) tsSeconds = Math.floor(tsSeconds / 1000);
      const msgDate = tsSeconds
        ? new Date(tsSeconds * 1000)
        : new Date();

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
        content: text.trim(),
        sender: String(sender),
        timestamp: msgDate,
      });
    }

    if (toInsert.length === 0) return;

    try {
      await db
        .insert(whatsappMessagesTable)
        .values(toInsert)
        .onConflictDoNothing();

      if (!isHistory) {
        this.lastFetchAt = new Date();
        this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
      }

      logger.info({ count: toInsert.length, isHistory }, "Messages stored");
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
    this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
    this.listeningInterval = setInterval(async () => {
      logger.info("30-minute sync — fetching history");
      this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
      try {
        await this.fetchHistory();
      } catch (err) {
        logger.error({ err }, "Scheduled history fetch failed");
      }
    }, 30 * 60 * 1000);
    logger.info("Started listening for new messages");
  }

  private stopListening(): void {
    if (this.listeningInterval) {
      clearInterval(this.listeningInterval);
      this.listeningInterval = null;
    }
    this.nextFetchAt = null;
  }
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
