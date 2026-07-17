import { Router, type IRouter } from "express";
import { sahibindenService } from "../lib/sahibinden.js";

const router: IRouter = Router();

router.get("/sahibinden/status", async (_req, res): Promise<void> => {
  res.json(await sahibindenService.getStatus());
});

router.post("/sahibinden/url", async (req, res): Promise<void> => {
  const url = String(req.body?.url || "").trim();
  if (!url) {
    res.status(400).json({ error: "url required" });
    return;
  }
  await sahibindenService.setUrl(url);
  res.json({ ok: true, ...(await sahibindenService.getStatus()) });
});

router.post("/sahibinden/cookies", async (req, res): Promise<void> => {
  const cookies = String(req.body?.cookies || "");
  await sahibindenService.setCookies(cookies);
  res.json({ ok: true, ...(await sahibindenService.getStatus()) });
});

router.post("/sahibinden/scan", async (req, res): Promise<void> => {
  const deep = Boolean(req.body?.deep);
  const result = await sahibindenService.scan({ deep });
  res.json(result);
});

router.post("/sahibinden/listen", async (_req, res): Promise<void> => {
  await sahibindenService.enableListen();
  res.json(await sahibindenService.getStatus());
});

router.delete("/sahibinden/messages", async (_req, res): Promise<void> => {
  const result = await sahibindenService.clearPool();
  res.json(result);
});

router.get("/sahibinden/messages", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const offset = Number(req.query.offset) || 0;
  const search = req.query.search ? String(req.query.search) : undefined;
  res.json(await sahibindenService.list(limit, offset, search));
});

/** Local PC bridge pushes scraped listings here (home residential IP). */
router.post("/sahibinden/ingest", async (req, res): Promise<void> => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  const result = await sahibindenService.ingestListings(items);
  res.json({
    ok: true,
    ...result,
    message: `${result.added} ilan köprüden eklendi`,
  });
});

export default router;
