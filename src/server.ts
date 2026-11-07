import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AuthManager } from './auth/manager.js';
import { LoginLimiter } from './auth/limiter.js';
import { AccountManager } from './account/manager.js';
import { Backend } from './backend.js';
import { logger } from './logger.js';
import { registerRoutes } from './routes.js';
import { BackendError } from './errors.js';
import { fail } from './response.js';

/**
 * Fastify server — mirrors codex-api's createServer layout (pino logger,
 * CORS {origin: true, credentials: true}, @fastify/static at /, custom
 * error handler) with Go's security headers, envelope and auth model.
 */

export interface ServerOptions {
  auth: AuthManager;
  limiter: LoginLimiter;
  manager: AccountManager;
  secureCookie: boolean;
  staticDir: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function createServer(opts: ServerOptions) {
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024, // 1 MiB, like Go's maxBodyBytes
    trustProxy: false, // direct TCP peer IP, like Go SetTrustedProxies(nil)
  });

  // Custom JSON parser: empty body -> {} (so logout/reload with no body
  // don't 400 under Fastify's FST_ERR_CTP_EMPTY_JSON_BODY); malformed JSON
  // -> 400 VALIDATION_ERROR "参数错误".
  app.addContentTypeParser(
    /^application\/json/,
    { parseAs: 'string' },
    (req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (text === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        const err = new Error('参数错误') as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // Security headers on every response; no-store on /api.
  app.addHook('onRequest', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      void reply.header(k, v);
    }
    if (req.url.startsWith('/api')) {
      void reply.header('Cache-Control', 'no-store');
    }
  });

  // Health check with silent logging.
  app.get('/health', { logLevel: 'silent' }, async (_req, reply) => {
    void reply.send({ status: 'ok' });
  });

  void app.register(fastifyCors, { origin: true, credentials: true });

  const backend = new Backend(opts.manager);
  registerRoutes(app, {
    auth: opts.auth,
    limiter: opts.limiter,
    backend,
    secureCookie: opts.secureCookie,
  });

  // Static frontend (admin build output). Hashed assets immutable,
  // index.html no-cache. Missing files fall through to the notFound handler.
  const staticDir = opts.staticDir;
  if (existsSync(staticDir)) {
    void app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      setHeaders: (res, path) => {
        if (path.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url === '/api') {
      fail(reply, 404, 'VALIDATION_ERROR', '接口不存在');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      void reply.code(405).type('text/plain; charset=utf-8').send('方法不允许');
      return;
    }
    // SPA fallback: serve index.html when built, else Go's 503 fallback text.
    if (existsSync(join(staticDir, 'index.html'))) {
      void reply.sendFile('index.html');
      return;
    }
    void reply
      .code(503)
      .type('text/plain; charset=utf-8')
      .send('管理界面资源未构建,请先运行 npm run build 后重新编译服务');
  });

  app.setErrorHandler((err, _req, reply) => {
    if (reply.sent) return;
    if (err instanceof BackendError) {
      fail(reply, err.status, err.code, err.message);
      return;
    }
    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (statusCode === 400 || statusCode === 413) {
      fail(reply, 400, 'VALIDATION_ERROR', '参数错误');
      return;
    }
    if (statusCode === 404) {
      fail(reply, 404, 'VALIDATION_ERROR', '接口不存在');
      return;
    }
    app.log.error(err);
    fail(reply, 500, 'INTERNAL_ERROR', '内部错误');
  });

  return app;
}
