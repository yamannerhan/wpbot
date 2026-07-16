import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { whatsappMessagesTable, whatsappConfigTable } from "@workspace/db";
import {
  GetMessagesQueryParams,
  SaveSelectedGroupsBody,
  ConnectWhatsappBody,
} from "@workspace/api-zod";
import { eq, and, gte, inArray, ilike, sql, desc } from "drizzle-orm";
import { whatsappService } from "../lib/whatsapp.js";

const router: IRouter = Router();

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
    const result = await whatsappService.fetchHistory();
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

  const { groupId, search, limit = 100, offset = 0 } = params.data;

  const conditions = [];

  if (groupId) {
    conditions.push(eq(whatsappMessagesTable.groupId, groupId));
  }

  if (search) {
    conditions.push(ilike(whatsappMessagesTable.content, `%${search}%`));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [messages, countResult] = await Promise.all([
    db
      .select()
      .from(whatsappMessagesTable)
      .where(whereClause)
      .orderBy(desc(whatsappMessagesTable.timestamp))
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
    })),
    total: Number(countResult[0]?.count ?? 0),
  });
});

// DELETE /whatsapp/messages
router.delete("/whatsapp/messages", async (req, res): Promise<void> => {
  const result = await db
    .delete(whatsappMessagesTable)
    .returning({ id: whatsappMessagesTable.id });

  res.json({ deleted: result.length });
});

// GET /whatsapp/messages/stats
router.get("/whatsapp/messages/stats", async (req, res): Promise<void> => {
  const [totalResult, groupStats, selectedGroupIds] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(whatsappMessagesTable),
    db
      .select({
        groupId: whatsappMessagesTable.groupId,
        groupName: whatsappMessagesTable.groupName,
        count: sql<number>`count(*)`,
      })
      .from(whatsappMessagesTable)
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

export default router;
