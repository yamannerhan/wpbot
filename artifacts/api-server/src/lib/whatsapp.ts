import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type proto,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { toDataURL } from "qrcode";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { db } from "@workspace/db";
import { whatsappMessagesTable, whatsappConfigTable } from "@workspace/db";
import { eq, inArray, and, gte, sql } from "drizzle-orm";
import pino from "pino";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Dev and production must use separate auth dirs to avoid "conflict/replaced" loops
const AUTH_SUFFIX = process.env.NODE_ENV === "development" ? "-dev" : "";
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR
  ? path.resolve(process.env.WHATSAPP_AUTH_DIR)
  : path.resolve(__dirname, `../../whatsapp-auth${AUTH_SUFFIX}`);

// Silent logger for Baileys
const baileysLogger = pino({ level: "error" });

export type WAState = "disconnected" | "connecting" | "qr_ready" | "pairing_code_ready" | "connected";

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

    // If already connecting with pairing code pending, just return current status
    if (this.status.state === "pairing_code_ready") {
      return this.getStatus();
    }

    this.status = {
      connected: false,
      state: "connecting",
      qrCode: null,
      pairingCode: null,
      phone: null,
      pushName: null,
    };

    // Normalize phone: digits only, no spaces/dashes/+
    const normalizedPhone = phoneNumber?.replace(/\D/g, "") || undefined;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        logger: baileysLogger,
        printQRInTerminal: false,
        auth: state,
        browser: ["İlan Toplayıcı Bot", "Chrome", "1.0.0"],
        syncFullHistory: true,
        markOnlineOnConnect: false,
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (normalizedPhone && this.sock) {
            // Use pairing code instead of QR
            try {
              const code = await this.sock.requestPairingCode(normalizedPhone);
              // Format as XXXX-XXXX for readability
              const formatted = code.length === 8
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
              // Fall back to QR
              try {
                const qrDataUrl = await toDataURL(qr, { width: 256, margin: 2 });
                this.status = { ...this.status, state: "qr_ready", qrCode: qrDataUrl };
              } catch {}
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
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          // 440 = conflict/replaced — another instance took the session; do NOT fight back
          // 401 = logged out — do not reconnect
          const isReplaced = statusCode === 440;
          // Always reconnect unless explicitly logged out (401)
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

          if (shouldReconnect) {
            logger.info("Reconnecting in 3 seconds...");
            setTimeout(() => this.connect(), 3000);
          } else if (isReplaced) {
            logger.warn(
              "Session replaced by another instance — staying disconnected. " +
              "Click 'Bağlan' to reconnect this instance."
            );
          }
        }

        if (connection === "open") {
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
        }
      });

      // Listen for new incoming messages
      this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        await this.processMessages(messages);
      });

      // Listen for history sync (fires on connect AND after fetchMessageHistory calls)
      this.sock.ev.on("messaging-history.set", async ({ messages, syncType, isLatest }) => {
        logger.info(
          { msgCount: messages?.length ?? 0, syncType, isLatest },
          "messaging-history.set received"
        );
        if (messages && messages.length > 0) {
          await this.processMessages(messages, true);
        }
      });
    } catch (err) {
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

    // Fetch regular groups (@g.us)
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [id, meta] of Object.entries(groups)) {
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

    // Fetch subscribed newsletter channels (@newsletter)
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
      // newsletters API may not be available on all Baileys versions — not fatal
      logger.debug({ err }, "Could not fetch newsletters (may not be supported)");
    }

    if (results.length === 0) {
      // Re-throw only if BOTH fetches yielded nothing AND groups also threw
      throw new Error("Failed to fetch any groups or channels");
    }

    return results.sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }

  /** Called once at startup — reconnects silently if saved credentials exist. */
  async autoConnect(): Promise<void> {
    try {
      const fs = await import("node:fs/promises");
      const credsPath = path.join(AUTH_DIR, "creds.json");
      const raw = await fs.readFile(credsPath, "utf8");
      const creds = JSON.parse(raw);
      // Only auto-connect if a device identity is already registered
      if (creds?.me?.id) {
        logger.info("Saved WhatsApp session found — reconnecting automatically");
        await this.connect();
      }
    } catch {
      // No creds file or parse error — first run, do nothing
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
  }

  /**
   * Triggers on-demand WhatsApp history sync for every selected group.
   * Messages arrive asynchronously via the 'messaging-history.set' event
   * and are stored by processMessages().  Returns the number of groups
   * for which a sync was successfully triggered.
   */
  async fetchHistory(): Promise<number> {
    if (!this.sock || !this.status.connected) {
      throw new Error("Not connected to WhatsApp");
    }

    const selectedGroupIds = await this.getSelectedGroupIds();
    if (selectedGroupIds.length === 0) return 0;

    let triggered = 0;

    for (const jid of selectedGroupIds) {
      try {
        logger.info({ jid }, "Triggering on-demand history sync");
        // fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestampMs)
        // By passing Date.now() we request the most recent `count` messages for this chat.
        await (this.sock as any).fetchMessageHistory(
          500,
          { id: "FETCH_" + Date.now(), fromMe: false, remoteJid: jid },
          Date.now()
        );
        triggered++;
        // Small delay to avoid hitting WhatsApp rate limits
        await new Promise((r) => setTimeout(r, 400));
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

    logger.info({ triggered, total: selectedGroupIds.length }, "History sync triggered");
    return triggered;
  }

  private async processMessages(
    messages: proto.IWebMessageInfo[],
    isHistory = false
  ): Promise<void> {
    const selectedGroupIds = await this.getSelectedGroupIds();
    if (selectedGroupIds.length === 0) return;

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
      // Only process group chats and newsletter channels
      const isGroup = jid.endsWith("@g.us");
      const isChannel = jid.endsWith("@newsletter");
      if (!isGroup && !isChannel) continue;

      // Only process selected groups/channels
      if (!selectedGroupIds.includes(jid)) continue;

      // Extract text content
      const text = extractText(msg);
      if (!text || text.trim().length === 0) continue;

      // Check timestamp
      const tsSeconds = Number(msg.messageTimestamp ?? 0);
      const msgDate = new Date(tsSeconds * 1000);

      if (isHistory && msgDate < fifteenDaysAgo) continue;

      // Get sender
      const sender = msg.key.fromMe
        ? (this.status.phone ?? "me")
        : (msg.key.participant ?? msg.pushName ?? "unknown");

      // Get group name from metadata if possible
      const groupName = await this.getGroupName(jid);

      toInsert.push({
        messageId: msg.key.id,
        groupId: jid,
        groupName,
        content: text.trim(),
        sender,
        timestamp: msgDate,
      });
    }

    if (toInsert.length > 0) {
      try {
        await db
          .insert(whatsappMessagesTable)
          .values(toInsert)
          .onConflictDoNothing();

        if (!isHistory) {
          this.lastFetchAt = new Date();
          this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
        }

        logger.info(
          { count: toInsert.length, isHistory },
          "Messages stored"
        );
      } catch (err) {
        logger.error({ err }, "Failed to store messages");
      }
    }
  }

  private groupNameCache = new Map<string, string>();

  private async getGroupName(jid: string): Promise<string> {
    if (this.groupNameCache.has(jid)) {
      return this.groupNameCache.get(jid)!;
    }

    try {
      if (this.sock) {
        const meta = await this.sock.groupMetadata(jid);
        const name = meta.subject;
        this.groupNameCache.set(jid, name);
        return name;
      }
    } catch {
      // ignore
    }

    return jid;
  }

  private startListening(): void {
    this.stopListening();
    this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
    this.listeningInterval = setInterval(async () => {
      logger.info("30-minute sync check");
      this.nextFetchAt = new Date(Date.now() + 30 * 60 * 1000);
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

  // Check common message types for text content
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsMessage?.contentText ||
    m.listMessage?.description ||
    m.templateMessage?.hydratedTemplate?.hydratedContentText ||
    null
  );
}

// Singleton
export const whatsappService = new WhatsAppService();

// Auto-reconnect on server start if saved session exists
whatsappService.autoConnect().catch(() => {/* silent */});
