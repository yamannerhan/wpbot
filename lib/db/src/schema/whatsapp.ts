import { pgTable, text, serial, timestamp, integer, unique, index, bigint, boolean } from "drizzle-orm/pg-core";

export const whatsappMessagesTable = pgTable(
  "whatsapp_messages",
  {
    id: serial("id").primaryKey(),
    messageId: text("message_id").notNull(),
    groupId: text("group_id").notNull(),
    groupName: text("group_name").notNull(),
    content: text("content").notNull(),
    sender: text("sender").notNull(),
    timestamp: timestamp("timestamp").notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    /** null = çeken bot henüz yayınlamadı / sırada */
    publishedAt: timestamp("published_at"),
  },
  (table) => [
    unique("wa_msg_group_uniq").on(table.messageId, table.groupId),
    index("wa_msg_group_ts_idx").on(table.groupId, table.timestamp),
    index("wa_msg_published_idx").on(table.publishedAt),
    index("wa_msg_fetched_idx").on(table.fetchedAt),
  ],
);

/** Survives "Havuzu Temizle" so Yeniden Tara can refill the pool. */
export const whatsappMessagesArchiveTable = pgTable(
  "whatsapp_messages_archive",
  {
    id: serial("id").primaryKey(),
    messageId: text("message_id").notNull(),
    groupId: text("group_id").notNull(),
    groupName: text("group_name").notNull(),
    content: text("content").notNull(),
    sender: text("sender").notNull(),
    timestamp: timestamp("timestamp").notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
  },
  (table) => [
    unique("wa_arch_msg_group_uniq").on(table.messageId, table.groupId),
    index("wa_arch_group_ts_idx").on(table.groupId, table.timestamp),
  ],
);

/** WA history cursor per chat — survives redeploy and pool clear. */
export const whatsappChatCursorsTable = pgTable("whatsapp_chat_cursors", {
  groupId: text("group_id").primaryKey(),
  newestMessageId: text("newest_message_id"),
  newestTs: bigint("newest_ts", { mode: "number" }),
  newestParticipant: text("newest_participant"),
  oldestMessageId: text("oldest_message_id"),
  oldestTs: bigint("oldest_ts", { mode: "number" }),
  oldestParticipant: text("oldest_participant"),
  /** Channel pagination cursor (server_id). */
  channelServerId: text("channel_server_id"),
  /** true = cannot go further back (or hit 15-day cap). */
  lookbackComplete: boolean("lookback_complete").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const whatsappConfigTable = pgTable("whatsapp_config", {
  id: integer("id").primaryKey().notNull(),
  selectedGroupIds: text("selected_group_ids").array().notNull().default([]),
  lastFetchAt: timestamp("last_fetch_at"),
  /** Sahibinden category URL to poll */
  sahibindenUrl: text("sahibinden_url"),
  sahibindenLastFetchAt: timestamp("sahibinden_last_fetch_at"),
  sahibindenListening: boolean("sahibinden_listening").notNull().default(true),
  /** Optional browser Cookie header from a real Chrome session */
  sahibindenCookies: text("sahibinden_cookies"),
});

export type WhatsappMessage = typeof whatsappMessagesTable.$inferSelect;
export type WhatsappConfig = typeof whatsappConfigTable.$inferSelect;
