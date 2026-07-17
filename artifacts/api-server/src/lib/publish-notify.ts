import { db } from "@workspace/db";
import { whatsappMessagesTable } from "@workspace/db";
import { and, eq, isNull, sql, asc, not, like, inArray, gt } from "drizzle-orm";
import { logger } from "./logger.js";

function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/** %100 aynı metin başka satırda var mı? (çift ilan) */
export async function hasExactContentElsewhere(
  content: string,
  messageId: string,
  groupId: string,
): Promise<boolean> {
  const normalized = normalizeContent(content);
  if (!normalized) return true;
  const rows = await db
    .select({
      messageId: whatsappMessagesTable.messageId,
      groupId: whatsappMessagesTable.groupId,
    })
    .from(whatsappMessagesTable)
    .where(eq(whatsappMessagesTable.content, normalized))
    .limit(20);

  return rows.some(
    (r) => !(r.messageId === messageId && r.groupId === groupId),
  );
}

export async function markPublishedByIds(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const now = new Date();
  await db
    .update(whatsappMessagesTable)
    .set({ publishedAt: now })
    .where(
      and(
        inArray(whatsappMessagesTable.id, ids),
        isNull(whatsappMessagesTable.publishedAt),
      ),
    );
  return ids.length;
}

export async function markPublishedByMessageKeys(
  keys: Array<{ messageId: string; groupId: string }>,
): Promise<void> {
  const now = new Date();
  for (const k of keys) {
    await db
      .update(whatsappMessagesTable)
      .set({ publishedAt: now })
      .where(
        and(
          eq(whatsappMessagesTable.messageId, k.messageId),
          eq(whatsappMessagesTable.groupId, k.groupId),
          isNull(whatsappMessagesTable.publishedAt),
        ),
      );
  }
}

export async function listPendingForPublish(limit = 50, afterId = 0) {
  const conditions = [
    isNull(whatsappMessagesTable.publishedAt),
    not(like(whatsappMessagesTable.groupId, "sahibinden:%")),
  ];
  if (afterId > 0) {
    conditions.push(gt(whatsappMessagesTable.id, afterId));
  }
  return db
    .select()
    .from(whatsappMessagesTable)
    .where(and(...conditions))
    .orderBy(asc(whatsappMessagesTable.id))
    .limit(Math.min(limit, 200));
}

export async function countPending(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(whatsappMessagesTable)
    .where(
      and(
        isNull(whatsappMessagesTable.publishedAt),
        not(like(whatsappMessagesTable.groupId, "sahibinden:%")),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Canlı yeni ilanları çeken bota bildir (webhook).
 * Çift ilan ayıklaması çağıran tarafta yapılmış olmalı.
 */
export async function notifyPublisherForNewRows(
  rows: Array<{
    messageId: string;
    groupId: string;
    groupName: string;
    content: string;
    sender: string;
    timestamp: Date;
  }>,
): Promise<{ notified: number; skippedExactDup: number }> {
  if (!rows.length) return { notified: 0, skippedExactDup: 0 };

  const pendingTotal = await countPending();
  const webhook =
    process.env.CEKEN_WEBHOOK_URL?.trim() ||
    process.env.PUBLISH_WEBHOOK_URL?.trim() ||
    "";

  const payload = {
    event: "whatsapp.pool.new",
    at: new Date().toISOString(),
    count: rows.length,
    pendingTotal,
    messages: rows.map((r) => ({
      messageId: r.messageId,
      groupId: r.groupId,
      groupName: r.groupName,
      content: r.content,
      sender: r.sender,
      timestamp: r.timestamp.toISOString(),
    })),
  };

  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      logger.info(
        { status: res.status, count: rows.length, pendingTotal },
        "Publisher webhook called",
      );
    } catch (err) {
      logger.warn({ err, webhook }, "Publisher webhook failed");
    }
  } else {
    logger.info(
      { count: rows.length, pendingTotal },
      "New pool messages ready (set CEKEN_WEBHOOK_URL to wake publisher)",
    );
  }

  return { notified: rows.length, skippedExactDup: 0 };
}
