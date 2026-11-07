import { join } from 'node:path';
import { getEnvConfig } from './config.js';
import { parseSessionTTL } from './auth/duration.js';
import { AuthManager } from './auth/manager.js';
import { LoginLimiter } from './auth/limiter.js';
import { AccountStore } from './account/store.js';
import { AccountManager } from './account/manager.js';
import { createServer } from './server.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const cfg = getEnvConfig();
  const ttlMs = parseSessionTTL(cfg.ICLOUD_API_SESSION_TTL);

  const store = new AccountStore(cfg.DATA_DIR);
  const manager = new AccountManager({ store });
  const auth = new AuthManager(cfg.ICLOUD_API_ADMIN_PASSWORD, ttlMs);
  const limiter = new LoginLimiter();
  const staticDir = join(process.cwd(), 'static');

  const app = createServer({
    auth,
    limiter,
    manager,
    secureCookie: cfg.ICLOUD_API_SECURE_COOKIE,
    staticDir,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
    } catch (err) {
      logger.error({ err }, 'error closing server');
    }
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  logger.info(
    { host: cfg.HOST, port: cfg.PORT, dataDir: cfg.DATA_DIR },
    'icloud-api listening',
  );
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
