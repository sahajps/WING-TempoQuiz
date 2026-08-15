'use strict';

const path = require('node:path');
const express = require('express');

const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const backup = require('./backup');
const security = require('./security');
const { HttpError } = require('./util');

const adminRoutes = require('./routes/admin');
const bankRoutes = require('./routes/bank');
const quizRoutes = require('./routes/quizzes');
const playRoutes = require('./routes/play');

const app = express();

// ngrok forwards over plain HTTP, so the X-Forwarded-* headers are the only
// source of truth for the client's real protocol and address.
if (config.TRUST_PROXY) app.set('trust proxy', true);
app.disable('x-powered-by');
app.set('etag', false);

app.use(security.securityHeaders);
app.use(security.cookieMiddleware);
app.use(express.json({ limit: config.MAX_BODY_BYTES }));
app.use(express.urlencoded({ extended: false, limit: config.MAX_BODY_BYTES }));
app.use(security.sameOriginOnly);
app.use(auth.attachSession);

// Routes reachable while the first-run password is still in force. The
// generated bootstrap password is printed to the server log, so until it has
// been replaced a session holding it may do nothing but replace it.
const PASSWORD_SETUP_ROUTES = new Set([
  '/api/admin/login',
  '/api/admin/logout',
  '/api/admin/session',
  '/api/admin/credentials',
  '/api/ping',
]);

app.use((req, _res, next) => {
  if (!req.adminSession || !req.path.startsWith('/api/')) {
    next();
    return;
  }
  const admin = auth.getAdmin();
  if (!admin || !admin.must_change) {
    next();
    return;
  }
  req.adminMustChangePassword = true;
  if (PASSWORD_SETUP_ROUTES.has(req.path)) {
    next();
    return;
  }
  next(new HttpError(403, 'Set a new administrator password before using the console.'));
});

const apiLimiter = security.createRateLimiter({
  windowMs: 60_000,
  max: 600,
  name: 'API',
});

// Images change rarely and are safe to hold for a while.
app.use('/assets', express.static(path.join(config.PUBLIC_DIR, 'assets'), {
  maxAge: '7d',
  etag: true,
}));

// Scripts and stylesheets must NOT be held without revalidating. Caching them
// for an hour means that after an update a browser keeps running the old code
// against the new server — which silently breaks students mid-class and is
// invisible to whoever deployed it. "no-cache" still stores the file but
// revalidates every time, so the ETag turns almost every request into a 304.
app.use(express.static(config.PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(js|css|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use('/api', apiLimiter);
app.use('/api/admin', adminRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/play', playRoutes);

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, service: 'tempoquiz', time: new Date().toISOString() });
});

// --- pages ------------------------------------------------------------------

function page(name) {
  return (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.PUBLIC_DIR, name));
  };
}

app.get('/', page('index.html'));
app.get('/join/:code', page('join.html'));
app.get('/play/:code', page('play.html'));
app.get('/host/:code', page('host.html'));
app.get('/admin', page('admin.html'));
app.get('/admin/console', page('console.html'));

// --- errors -----------------------------------------------------------------

app.use((req, res, next) => {
  next(new HttpError(404, `No route for ${req.method} ${req.path}`));
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((error, req, res, _next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.path}:`, error);
  }
  // A JSON body larger than the limit surfaces as a parser error; translate it
  // into something an instructor can act on.
  const message = error.type === 'entity.too.large'
    ? 'That request is too large. Split the quiz into smaller appends.'
    : status >= 500
      ? 'Something went wrong on the server.'
      : error.message;

  if (req.path.startsWith('/api/')) {
    res.status(status).json({ ok: false, error: message, details: error.details || undefined });
    return;
  }
  res.status(status).type('text/plain').send(`${status} — ${message}`);
});

// --- startup ----------------------------------------------------------------

function printBanner(bootstrap) {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  TempoQuiz · WING-NUS');
  console.log(line);
  console.log(`  Local        http://localhost:${config.PORT}`);
  console.log(`  Admin        http://localhost:${config.PORT}/admin`);
  console.log(`  Database     ${config.DB_FILE}`);
  console.log(`  Archives     ${config.ARCHIVE_DIR}`);
  if (config.PUBLIC_URL) console.log(`  Public URL   ${config.PUBLIC_URL}`);
  else console.log('  Public URL   (auto-detected from the incoming request)');

  if (bootstrap.created && bootstrap.generated) {
    console.log(line);
    console.log('  FIRST RUN — a temporary administrator password was generated.');
    console.log('  It is shown only once and must be changed at first sign-in.');
    console.log('');
    console.log(`      username   ${bootstrap.username}`);
    console.log(`      password   ${bootstrap.password}`);
  } else if (bootstrap.created) {
    console.log(line);
    console.log(`  Administrator account created as "${bootstrap.username}"`);
    console.log('  using the password from config/tempoquiz.yml.');
  }
  console.log(`${line}\n`);
}

function start() {
  db.migrate();
  const bootstrap = auth.ensureAdminAccount();
  auth.purgeExpiredSessions();

  const server = app.listen(config.PORT, config.HOST, () => {
    printBanner(bootstrap);
    // Started only once the port is actually bound, so a start that fails on
    // EADDRINUSE does not leave a stray snapshot behind.
    backup.startScheduler();
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\nPort ${config.PORT} is already in use.\nChange server.port in config/tempoquiz.yml, or run ./run.sh stop first.\n`);
      process.exit(1);
    }
    throw error;
  });

  // Long-poll friendly: keep sockets alive a little longer than the client's
  // polling interval so phones are not constantly reconnecting.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down.`);
    backup.stopScheduler();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not hang forever on a student's open polling connection.
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
