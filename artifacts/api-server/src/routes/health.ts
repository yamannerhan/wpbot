import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/setup/status", async (_req, res) => {
  let database = false;
  let databaseError: string | null = null;

  try {
    await pool.query("SELECT 1");
    database = true;
  } catch (err) {
    databaseError =
      err instanceof Error ? err.message : "Database connection failed";
  }

  res.json({
    ok: database,
    database,
    databaseError,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    nodeEnv: process.env.NODE_ENV || "development",
  });
});

export default router;
