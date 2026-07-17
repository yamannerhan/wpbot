import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import whatsappRouter from "./whatsapp.js";
import sahibindenRouter from "./sahibinden.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(whatsappRouter);
router.use(sahibindenRouter);

export default router;
