import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${rawPort}"`);

app.listen(port, (err) => {
  if (err) { logger.error({ err }, "Error listening"); process.exit(1); }
  logger.info({ port }, "Server listening");
});

startBot().catch((err) => {
  logger.error({ err }, "Failed to start bot");
  process.exit(1);
});
