import app from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { startTelecomWorker, stopTelecomWorker } from './modules/telecom/telecom.worker';

const server = app.listen(env.port, () => {
  logger.info(`ChatFlow API listening on port ${env.port}`);
  startTelecomWorker();
});

const shutdown = () => {
  stopTelecomWorker();
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
