import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(serverDir, '..');
const defaultDataPath = resolve(projectDir, 'server-data/community.json');
const defaultStaticDir = resolve(projectDir, 'dist');
const MAX_BODY_BYTES = 16 * 1024;

function emptyDatabase() {
  return { version: 1, visitors: {}, recentRuns: [] };
}

function normalizeName(value) {
  const normalized = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (normalized || 'Guest').slice(0, 20);
}

function validVisitorId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value);
}

function finiteNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function calculateScore(run) {
  return Math.round(run.kills * 12 + run.time * 4 + run.level * 80 + (run.won ? 5_000 : 0));
}

class CommunityStore {
  constructor(filePath, ephemeral = false) {
    this.filePath = filePath;
    this.ephemeral = ephemeral;
    this.data = emptyDatabase();
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.ephemeral) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed?.version === 1 && parsed.visitors && Array.isArray(parsed.recentRuns)) this.data = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  read(select) {
    return this.queue.then(() => select(this.data));
  }

  update(change) {
    const operation = this.queue.then(async () => {
      const result = change(this.data);
      if (!this.ephemeral) await this.persist();
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

function makeVisitor(visitorId, name, now) {
  return {
    id: visitorId,
    name: normalizeName(name),
    firstSeen: now,
    lastSeen: now,
    visits: 0,
    games: 0,
    wins: 0,
    totalKills: 0,
    totalPlaySeconds: 0,
    bestScore: 0,
    bestRun: null,
  };
}

function publicLeaderboard(database, requestedLimit) {
  const limit = Math.round(finiteNumber(requestedLimit, 1, 50));
  return Object.values(database.visitors)
    .filter((visitor) => visitor.bestRun)
    .sort((left, right) => right.bestScore - left.bestScore
      || Number(right.bestRun.won) - Number(left.bestRun.won)
      || right.bestRun.kills - left.bestRun.kills
      || left.bestRun.time - right.bestRun.time)
    .slice(0, limit)
    .map((visitor, index) => ({
      rank: index + 1,
      name: visitor.name,
      score: visitor.bestScore,
      kills: visitor.bestRun.kills,
      time: visitor.bestRun.time,
      level: visitor.bestRun.level,
      won: visitor.bestRun.won,
    }));
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function secureTokenMatches(expected, supplied) {
  if (!expected || expected.length < 12 || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function mimeType(path) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
  })[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function serveStatic(request, response, staticDir, pathname) {
  const root = resolve(staticDir);
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  const candidate = resolve(root, `.${requestedPath === '/' ? '/index.html' : requestedPath}`);
  const safeCandidate = candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : resolve(root, 'index.html');
  let filePath = safeCandidate;
  try {
    const details = await stat(filePath);
    if (details.isDirectory()) filePath = resolve(filePath, 'index.html');
  } catch {
    // Only extensionless navigation routes receive the SPA shell. Returning
    // index.html for a missing sprite/script hid deployment mistakes behind a
    // misleading 200 and cached the wrong payload as an immutable asset.
    const assetRequest = extname(requestedPath) !== ''
      || requestedPath.startsWith('/art/')
      || requestedPath.startsWith('/assets/')
      || requestedPath.startsWith('/src/');
    if (assetRequest) {
      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      }).end('Not found');
      return;
    }
    filePath = resolve(root, 'index.html');
  }
  try {
    const details = await stat(filePath);
    const hashedAsset = /[/\\]assets[/\\][^/\\]+-[A-Za-z0-9_-]{8,}\.[^/\\]+$/.test(filePath);
    const cache = filePath.endsWith('index.html')
      ? 'no-cache'
      : hashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600, must-revalidate';
    response.writeHead(200, {
      'content-type': mimeType(filePath),
      'content-length': details.size,
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Build not found. Run npm run build first.');
  }
}

function createRateLimiter(disabled = false) {
  const buckets = new Map();
  return (key, write = false) => {
    if (disabled) return true;
    const now = Date.now();
    const windowMs = 60_000;
    const limit = write ? 30 : 180;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      bucket = { startedAt: now, reads: 0, writes: 0 };
      buckets.set(key, bucket);
    }
    const field = write ? 'writes' : 'reads';
    bucket[field]++;
    if (buckets.size > 2_000) {
      for (const [bucketKey, value] of buckets) {
        if (now - value.startedAt >= windowMs) buckets.delete(bucketKey);
      }
    }
    return bucket[field] <= limit;
  };
}

export async function createCommunityServer(options = {}) {
  const store = new CommunityStore(options.dataPath ?? defaultDataPath, options.ephemeral ?? false);
  await store.load();
  const adminToken = options.adminToken ?? process.env.FF_ADMIN_TOKEN ?? 'Isaac 201812';
  const allowRequest = createRateLimiter(options.disableRateLimit ?? false);
  let vite = null;
  if (options.dev) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      root: projectDir,
      server: {
        middlewareMode: true,
        // Middleware-mode Vite still creates a ping websocket even when HMR
        // is disabled. Give every app instance a deterministic private port
        // so a live preview and Playwright can run concurrently without page
        // errors from the shared 24678 default.
        hmr: { port: (options.port ?? 5180) + 10_000 },
      },
      appType: 'spa',
    });
  }

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname;
    const remoteKey = request.socket.remoteAddress ?? 'unknown';
    const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
    if (pathname.startsWith('/api/') && !allowRequest(remoteKey, isWrite)) {
      sendJson(response, 429, { error: 'rate-limit' });
      return;
    }
    try {
      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/leaderboard') {
        const entries = await store.read((database) => publicLeaderboard(database, requestUrl.searchParams.get('limit') ?? 8));
        sendJson(response, 200, { entries });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/visit') {
        const body = await readJson(request);
        if (!validVisitorId(body.visitorId)) {
          sendJson(response, 400, { error: 'invalid-visitor' });
          return;
        }
        const now = new Date().toISOString();
        await store.update((database) => {
          const visitor = database.visitors[body.visitorId] ?? makeVisitor(body.visitorId, body.name, now);
          visitor.name = normalizeName(body.name ?? visitor.name);
          visitor.lastSeen = now;
          visitor.visits++;
          database.visitors[body.visitorId] = visitor;
        });
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'PATCH' && pathname === '/api/profile') {
        const body = await readJson(request);
        if (!validVisitorId(body.visitorId)) {
          sendJson(response, 400, { error: 'invalid-visitor' });
          return;
        }
        const now = new Date().toISOString();
        await store.update((database) => {
          const visitor = database.visitors[body.visitorId] ?? makeVisitor(body.visitorId, body.name, now);
          visitor.name = normalizeName(body.name);
          visitor.lastSeen = now;
          database.visitors[body.visitorId] = visitor;
        });
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && pathname === '/api/run') {
        const body = await readJson(request);
        if (!validVisitorId(body.visitorId)) {
          sendJson(response, 400, { error: 'invalid-visitor' });
          return;
        }
        const run = {
          kills: Math.round(finiteNumber(body.kills, 0, 25_000)),
          time: Math.round(finiteNumber(body.time, 0, 86_400)),
          level: Math.round(finiteNumber(body.level, 1, 200)),
          won: body.won === true,
          playerId: ['messi', 'ronaldo', 'neymar', 'yamal'].includes(body.playerId) ? body.playerId : 'messi',
        };
        const score = calculateScore(run);
        const now = new Date().toISOString();
        await store.update((database) => {
          const visitor = database.visitors[body.visitorId] ?? makeVisitor(body.visitorId, body.name, now);
          visitor.name = normalizeName(body.name ?? visitor.name);
          visitor.lastSeen = now;
          visitor.games++;
          visitor.totalPlaySeconds = (visitor.totalPlaySeconds ?? 0) + Math.max(0, Number(run.time) || 0);
          visitor.wins += run.won ? 1 : 0;
          visitor.totalKills += run.kills;
          if (!visitor.bestRun || score > visitor.bestScore) {
            visitor.bestScore = score;
            visitor.bestRun = { ...run, score, createdAt: now };
          }
          database.visitors[body.visitorId] = visitor;
          database.recentRuns.push({ id: randomUUID(), visitorId: body.visitorId, name: visitor.name, ...run, score, createdAt: now });
          if (database.recentRuns.length > 500) database.recentRuns.splice(0, database.recentRuns.length - 500);
        });
        sendJson(response, 200, { ok: true, score });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/admin/stats') {
        if (!adminToken || adminToken.length < 12) {
          sendJson(response, 503, { error: 'admin-not-configured' });
          return;
        }
        const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
        if (!secureTokenMatches(adminToken, supplied)) {
          sendJson(response, 401, { error: 'unauthorized' });
          return;
        }
        const payload = await store.read((database) => {
          const visitors = Object.values(database.visitors).sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
          const dayAgo = Date.now() - 86_400_000;
          const playedByVisitor = new Map();
          for (const run of database.recentRuns) {
            playedByVisitor.set(run.visitorId, (playedByVisitor.get(run.visitorId) ?? 0) + (Number(run.time) || 0));
          }
          const playOf = (visitor) => visitor.totalPlaySeconds || playedByVisitor.get(visitor.id) || 0;
          const games = visitors.reduce((sum, visitor) => sum + visitor.games, 0);
          const playSeconds = visitors.reduce((sum, visitor) => sum + playOf(visitor), 0);
          const clock = (seconds) => {
            const totalMins = Math.max(0, (Math.max(0, seconds) / 600) * 90);
            const mins = Math.floor(totalMins);
            const extra = Math.min(59, Math.floor((totalMins - mins) * 60));
            return `${mins}'${String(extra).padStart(2, '0')}`;
          };
          return {
            summary: {
              visitors: visitors.length,
              active24h: visitors.filter((visitor) => Date.parse(visitor.lastSeen) >= dayAgo).length,
              visits: visitors.reduce((sum, visitor) => sum + visitor.visits, 0),
              games,
              wins: visitors.reduce((sum, visitor) => sum + visitor.wins, 0),
              totalKills: visitors.reduce((sum, visitor) => sum + visitor.totalKills, 0),
              totalPlaySeconds: playSeconds,
              avgPlayClock: games > 0 ? clock(playSeconds / games) : '0\'00',
            },
            visitors: visitors.map((visitor) => ({
              id: visitor.id,
              name: visitor.name,
              firstSeen: visitor.firstSeen,
              lastSeen: visitor.lastSeen,
              visits: visitor.visits,
              games: visitor.games,
              playcount: visitor.games,
              wins: visitor.wins,
              totalKills: visitor.totalKills,
              bestScore: visitor.bestScore,
              avgPlayClock: visitor.games > 0 ? clock(playOf(visitor) / visitor.games) : '0\'00',
            })),
            recentRuns: database.recentRuns.slice(-50).reverse(),
          };
        });
        sendJson(response, 200, payload);
        return;
      }
      if (pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'not-found' });
        return;
      }
      if (vite) {
        vite.middlewares(request, response, () => {
          if (!response.headersSent) response.writeHead(404).end('Not found');
        });
        return;
      }
      await serveStatic(request, response, options.staticDir ?? defaultStaticDir, pathname);
    } catch (error) {
      if (!response.headersSent) {
        const clientError = error?.message === 'body-too-large' || error instanceof SyntaxError;
        sendJson(response, clientError ? 400 : 500, { error: clientError ? 'invalid-request' : 'server-error' });
      } else {
        response.destroy();
      }
    }
  });

  server.on('close', () => {
    void vite?.close();
  });
  return { server, store };
}

function parseCli(argv) {
  const options = {
    dev: false,
    ephemeral: false,
    port: Number(process.env.PORT) || 5180,
    dataPath: undefined,
    adminToken: undefined,
    disableRateLimit: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dev') options.dev = true;
    else if (arg === '--ephemeral') options.ephemeral = true;
    else if (arg === '--port') options.port = Number(argv[++index]) || options.port;
    else if (arg === '--data') options.dataPath = resolve(argv[++index]);
    else if (arg === '--admin-token') options.adminToken = argv[++index];
    else if (arg === '--no-rate-limit') options.disableRateLimit = true;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cli = parseCli(process.argv.slice(2));
  const { server } = await createCommunityServer(cli);
  server.listen(cli.port, '0.0.0.0', () => {
    console.log(`Football Fighting ${cli.dev ? 'development' : 'production'} server: http://0.0.0.0:${cli.port}`);
    console.log(cli.ephemeral ? 'Community data: ephemeral' : `Community data: ${cli.dataPath ?? defaultDataPath}`);
    if (!cli.adminToken && !process.env.FF_ADMIN_TOKEN) {
      console.log('VIP admin token: Isaac 201812 (override with FF_ADMIN_TOKEN).');
    }
  });
}
