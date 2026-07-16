import { pgTable, text, serial, timestamp, integer, unique, index, bigint } from "drizzle-orm/pg-core";

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
  },
  (table) => [
    unique("wa_msg_group_uniq").on(table.messageId, table.groupId),
    index("wa_msg_group_ts_idx").on(table.groupId, table.timestamp),
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
  oldestMessageId: text("oldest_message_id"),
  oldestTs: bigint("oldest_ts", { mode: "number" }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const whatsappConfigTable = pgTable("whatsapp_config", {
  id: integer("id").primaryKey().notNull(),
  selectedGroupIds: text("selected_group_ids").array().notNull().default([]),
  lastFetchAt: timestamp("last_fetch_at"),
});

export type WhatsappMessage = typeof whatsappMessagesTable.$inferSelect;
export type WhatsappConfig = typeof whatsappConfigTable.$inferSelect;
