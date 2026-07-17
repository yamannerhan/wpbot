import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { whatsappMessagesTable, whatsappConfigTable } from "@workspace/db";
import {
  GetMessagesQueryParams,
  SaveSelectedGroupsBody,
  ConnectWhatsappBody,
} from "@workspace/api-zod";
import { eq, and, gte, inArray, ilike, sql, desc, not, like, isNull } from "drizzle-orm";
import { whatsappService } from "../lib/whatsapp.js";

const router: IRouter = Router();

const notSahibinden = not(like(whatsappMessagesTable.groupId, "sahibinden:%"));

// GET /whatsapp/status
router.get("/whatsapp/status", async (req, res): Promise<void> => {
  const status = whatsappService.getStatus();
  res.json(status);
});

// POST /whatsapp/connect
router.post("/whatsapp/connect", async (req, res): Promise<void> => {
  const parsed = ConnectWhatsappBody.safeParse(req.body ?? {});
  const phoneNumber = parsed.success ? parsed.data.phoneNumber : undefined;
  const status = await whatsappService.connect(phoneNumber);
  res.json(status);
});

// POST /whatsapp/disconnect
router.post("/whatsapp/disconnect", async (req, res): Promise<void> => {
  const status = await whatsappService.disconnect();
  res.json(status);
});

// POST /whatsapp/cancel — cancel QR/code wait
router.post("/whatsapp/cancel", async (_req, res): Promise<void> => {
  const status = await whatsappService.cancelLogin();
  res.json(status);
});

// GET /whatsapp/groups
router.get("/whatsapp/groups", async (req, res): Promise<void> => {
  const status = whatsappService.getStatus();
  if (!status.connected) {
    res.status(400).json({ error: "WhatsApp is not connected" });
    return;
  }

  try {
    const groups = await whatsappService.getGroups();
    res.json(groups);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch groups");
    res.status(500).json({ error: "Failed to fetch groups" });
  }
});

// GET /whatsapp/groups/selected
router.get("/whatsapp/groups/selected", async (req, res): Promise<void> => {
  const groupIds = await whatsappService.getSelectedGroupIds();

  // Try to enrich with group names if connected
  let groups: Array<{ id: string; name: string; participantCount: number }> =
    [];
  if (whatsappService.getStatus().connected) {
    try {
      const allGroups = await whatsappService.getGroups();
      groups = allGroups.filter((g) => groupIds.includes(g.id));
    } catch {
      // ignore
    }
  }

  res.json({ groupIds, groups });
});

// POST /whatsapp/groups/selected
router.post("/whatsapp/groups/selected", async (req, res): Promise<void> => {
  const parsed = SaveSelectedGroupsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await whatsappService.saveSelectedGroupIds(parsed.data.groupIds);

  const groupIds = parsed.data.groupIds;
  let groups: Array<{ id: string; name: string; participantCount: number }> =
    [];
  if (whatsappService.getStatus().connected) {
    try {
      const allGroups = await whatsappService.getGroups();
      groups = allGroups.filter((g) => groupIds.includes(g.id));
    } catch {
      // ignore
    }
  }

  res.json({ groupIds, groups });
});

// POST /whatsapp/messages/fetch
router.post("/whatsapp/messages/fetch", async (req, res): Promise<void> => {
  const status = whatsappService.getStatus();
  if (!status.connected) {
    res.status(400).json({ error: "WhatsApp is not connected" });
    return;
  }

  const groupIds = await whatsappService.getSelectedGroupIds();
  if (groupIds.length === 0) {
    res.status(400).json({ error: "No groups selected" });
    return;
  }

  try {
    const result = await whatsappService.fetchHistory({ mode: "deep" });
    res.json({
      status: "ok",
      message: result.storedHint,
      count: result.triggered,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch history");
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// GET /whatsapp/messages
router.get("/whatsapp/messages", async (req, res): Promise<void> => {
  const params = GetMessagesQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { groupId, search, limit = 100, offset = 0, pool = "all" } = params.data;

  const conditions = [notSahibinden];

  // Medya havuzu: içeriği "Medya" ile başlayanlar; mesaj havuzu: diğerleri
  if (pool === "media") {
    conditions.push(sql`${whatsappMessagesTable.content} ~* '^Medya(\\n|$)'`);
  } else if (pool === "text") {
    conditions.push(sql`${whatsappMessagesTable.content} !~* '^Medya(\\n|$)'`);
  }

  if (groupId) {
    conditions.push(eq(whatsappMessagesTable.groupId, groupId));
  }

  if (search) {
    conditions.push(ilike(whatsappMessagesTable.content, `%${search}%`));
  }

  const whereClause = and(...conditions);

  const [messages, countResult] = await Promise.all([
    db
      .select()
      .from(whatsappMessagesTable)
      .where(whereClause)
      .orderBy(desc(whatsappMessagesTable.fetchedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(whereClause),
  ]);

  res.json({
    messages: messages.map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
      fetchedAt: m.fetchedAt.toISOString(),
      publishedAt: m.publishedAt ? m.publishedAt.toISOString() : null,
    })),
    total: Number(countResult[0]?.count ?? 0),
  });
});

/** Çeken bot: kaldığı yerden sırayla al (id ASC). ?pool=text|media|all */
router.get("/whatsapp/messages/pending", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const afterId = Number(req.query.afterId) || 0;
  const poolRaw = String(req.query.pool || "all");
  const pool =
    poolRaw === "media" || poolRaw === "text" || poolRaw === "all"
      ? poolRaw
      : "all";
  const {
    listPendingForPublish,
    countPending,
  } = await import("../lib/publish-notify.js");
  const [messages, pendingTotal] = await Promise.all([
    listPendingForPublish(limit, afterId, pool),
    countPending(pool),
  ]);
  res.json({
    messages: messages.map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
      fetchedAt: m.fetchedAt.toISOString(),
      publishedAt: null,
    })),
    pendingTotal,
    afterId,
    pool,
  });
});

/** Bot için kısa medya havuzu linki (= messages?pool=media) */
router.get("/whatsapp/media", async (req, res): Promise<void> => {
  const params = GetMessagesQueryParams.safeParse({ ...req.query, pool: "media" });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { groupId, search, limit = 100, offset = 0 } = params.data;
  const conditions = [
    notSahibinden,
    sql`${whatsappMessagesTable.content} ~* '^Medya(\\n|$)'`,
  ];
  if (groupId) conditions.push(eq(whatsappMessagesTable.groupId, groupId));
  if (search) {
    conditions.push(ilike(whatsappMessagesTable.content, `%${search}%`));
  }
  const whereClause = and(...conditions);
  const [messages, countResult] = await Promise.all([
    db
      .select()
      .from(whatsappMessagesTable)
      .where(whereClause)
      .orderBy(desc(whatsappMessagesTable.fetchedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(whereClause),
  ]);
  res.json({
    pool: "media",
    messages: messages.map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
      fetchedAt: m.fetchedAt.toISOString(),
      publishedAt: m.publishedAt ? m.publishedAt.toISOString() : null,
    })),
    total: Number(countResult[0]?.count ?? 0),
  });
});

/** Bot: sadece medya pending */
router.get("/whatsapp/media/pending", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const afterId = Number(req.query.afterId) || 0;
  const { listPendingForPublish, countPending } = await import(
    "../lib/publish-notify.js"
  );
  const [messages, pendingTotal] = await Promise.all([
    listPendingForPublish(limit, afterId, "media"),
    countPending("media"),
  ]);
  res.json({
    pool: "media",
    messages: messages.map((m) => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
      fetchedAt: m.fetchedAt.toISOString(),
      publishedAt: null,
    })),
    pendingTotal,
    afterId,
  });
});

/** Çeken bot: yayınladıktan sonra işaretle. */
router.post("/whatsapp/messages/published", async (req, res): Promise<void> => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((x: unknown) => Number(x)).filter((n: number) => n > 0)
    : [];
  if (!ids.length) {
    res.status(400).json({ error: "ids required" });
    return;
  }
  const { markPublishedByIds, countPending } = await import(
    "../lib/publish-notify.js"
  );
  await markPublishedByIds(ids);
  res.json({ ok: true, marked: ids.length, pendingTotal: await countPending() });
});

// DELETE /whatsapp/messages — only wipe the pool (no auto-rescan)
router.delete("/whatsapp/messages", async (req, res): Promise<void> => {
  try {
    const result = await whatsappService.clearPoolOnly();
    res.json({
      deleted: result.deleted,
      message: result.message,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to clear message pool");
    res.status(500).json({ error: "Failed to clear message pool" });
  }
});

// GET /whatsapp/messages/stats
router.get("/whatsapp/messages/stats", async (req, res): Promise<void> => {
  const mediaCond = sql`${whatsappMessagesTable.content} ~* '^Medya(\\n|$)'`;
  const textCond = sql`${whatsappMessagesTable.content} !~* '^Medya(\\n|$)'`;

  const [totalResult, textResult, mediaResult, pendingResult, publishedResult, groupStats, selectedGroupIds] =
    await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(notSahibinden),
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(and(notSahibinden, textCond)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(and(notSahibinden, mediaCond)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(and(notSahibinden, isNull(whatsappMessagesTable.publishedAt))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable)
      .where(
        and(notSahibinden, sql`${whatsappMessagesTable.publishedAt} IS NOT NULL`),
      ),
    db
      .select({
        groupId: whatsappMessagesTable.groupId,
        groupName: whatsappMessagesTable.groupName,
        count: sql<number>`count(*)`,
      })
      .from(whatsappMessagesTable)
      .where(notSahibinden)
      .groupBy(
        whatsappMessagesTable.groupId,
        whatsappMessagesTable.groupName
      ),
    whatsappService.getSelectedGroupIds(),
  ]);

  const config = await db
    .select()
    .from(whatsappConfigTable)
    .where(eq(whatsappConfigTable.id, 1))
    .limit(1);

  const lastFetchAt = config[0]?.lastFetchAt ?? whatsappService.getLastFetchAt();
  const nextFetchAt = whatsappService.getNextFetchAt();

  res.json({
    total: Number(totalResult[0]?.count ?? 0),
    textTotal: Number(textResult[0]?.count ?? 0),
    mediaTotal: Number(mediaResult[0]?.count ?? 0),
    pending: Number(pendingResult[0]?.count ?? 0),
    published: Number(publishedResult[0]?.count ?? 0),
    selectedGroupCount: selectedGroupIds.length,
    groups: groupStats.map((g) => ({
      groupId: g.groupId,
      groupName: g.groupName,
      count: Number(g.count),
    })),
    listening: whatsappService.isListening(),
    lastFetchAt: lastFetchAt?.toISOString() ?? null,
    nextFetchAt: nextFetchAt?.toISOString() ?? null,
  });
});

/** Bekleyen kuyruğu çeken bota tekrar bildir (havuz arttı ama yayın durduysa). */
router.post("/whatsapp/messages/wake", async (_req, res): Promise<void> => {
  const { listPendingForPublish, notifyPublisherForNewRows, countPending } =
    await import("../lib/publish-notify.js");
  const pending = await listPendingForPublish(50, 0);
  const result = await notifyPublisherForNewRows(
    pending.map((m) => ({
      messageId: m.messageId,
      groupId: m.groupId,
      groupName: m.groupName,
      content: m.content,
      sender: m.sender,
      timestamp: m.timestamp,
    })),
  );
  res.json({
    ok: true,
    ...result,
    pendingTotal: await countPending(),
  });
});

export default router;
