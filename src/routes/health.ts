import { Router, type IRouter } from "express";
import * as zod from "zod";

const HealthCheckResponse = zod.object({ status: zod.string() });

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
