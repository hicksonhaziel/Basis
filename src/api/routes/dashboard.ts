import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

const dashboardDirectory = fileURLToPath(new URL('../../../dashboard/', import.meta.url));

interface DashboardAsset {
  file: string;
  contentType: string;
}

const assets: Record<string, DashboardAsset> = {
  '/app.mjs': { file: 'app.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/audit-chain.mjs': { file: 'audit-chain.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/phase7-evidence.json': { file: 'phase7-evidence.json', contentType: 'application/json; charset=utf-8' },
  '/backtest-report.json': { file: 'backtest-report.json', contentType: 'application/json; charset=utf-8' },
  '/evidence.jsonl': { file: 'evidence.jsonl', contentType: 'application/x-ndjson; charset=utf-8' },
};

async function sendAsset(reply: FastifyReply, asset: DashboardAsset): Promise<FastifyReply> {
  try {
    const body = await readFile(`${dashboardDirectory}${asset.file}`);
    return reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .type(asset.contentType)
      .send(body);
  } catch (error) {
    reply.log.error({ error, file: asset.file }, 'Dashboard asset unavailable');
    return reply.status(503).send({ error: 'Dashboard asset unavailable' });
  }
}

export function registerDashboardRoutes(app: FastifyInstance): void {
  const index: DashboardAsset = { file: 'index.html', contentType: 'text/html; charset=utf-8' };
  for (const path of ['/', '/dashboard', '/dashboard/']) {
    app.get(path, async (_request, reply) => sendAsset(reply, index));
  }
  for (const [path, asset] of Object.entries(assets)) {
    app.get(path, async (_request, reply) => sendAsset(reply, asset));
  }
}
