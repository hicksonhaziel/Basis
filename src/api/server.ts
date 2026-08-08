/**
 * Basis API Server — Fastify entry point.
 *
 * Standalone: node --experimental-strip-types --env-file=.env.local src/api/server.ts
 */

import Fastify from 'fastify';
import { loadEnv } from '../config/env.ts';
import { registry } from '../adapters/registry.ts';
import { erc20TransferAdapter } from '../adapters/erc20-transfer.ts';
import { wethWrapAdapter } from '../adapters/weth-wrap.ts';
import { KeeperHubClient } from '../keeperhub/client.ts';
import { Ledger } from '../ledger/database.ts';
import { BasisExecutor } from '../executor/execute.ts';
import { registerQuoteRoutes } from './routes/quote.ts';
import { registerOrderRoutes } from './routes/order.ts';
import { registerStatusRoutes } from './routes/status.ts';
import { registerMetricsRoutes } from './routes/metrics.ts';

async function main(): Promise<void> {
  // Load environment
  const env = loadEnv();

  // Register adapters
  registry.register(erc20TransferAdapter);
  registry.register(wethWrapAdapter);

  // Create infrastructure
  const keeperHubClient = new KeeperHubClient({
    baseUrl: env.keeperHubBaseUrl,
    apiKey: env.keeperHubApiKey,
  });

  const ledger = new Ledger(
    'data/basis.db',
    'data/audit.jsonl',
  );

  const executor = new BasisExecutor({
    keeperHubClient,
    ledger,
    signingKey: env.basisSigningKey,
    rpcUrls: env.rpcUrls,
  });

  // Create Fastify instance
  const app = Fastify({
    logger: true,
  });

  // Register routes
  registerQuoteRoutes(app, executor, ledger);
  registerOrderRoutes(app, executor, ledger);
  registerStatusRoutes(app, executor, ledger);
  registerMetricsRoutes(app, executor, ledger);

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // Start server
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await app.listen({ port, host });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    app.log.info('Shutting down...');
    await app.close();
    ledger.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
