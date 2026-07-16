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
