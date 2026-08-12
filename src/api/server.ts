/**
 * Basis API Server — Fastify entry point.
 *
 * Standalone: node --experimental-strip-types --env-file=.env.local src/api/server.ts
 */

import Fastify from 'fastify';
import { loadEnv } from '../config/env.ts';
import { registry } from '../adapters/registry.ts';
import { createErc20TransferAdapter } from '../adapters/erc20-transfer.ts';
import { wethWrapAdapter } from '../adapters/weth-wrap.ts';
import { wethUnwrapAdapter } from '../adapters/weth-unwrap.ts';
import { morphoAccrueInterestAdapter } from '../adapters/morpho-accrue-interest.ts';
import { KeeperHubClient } from '../keeperhub/client.ts';
import { Ledger } from '../ledger/database.ts';
import { BasisExecutor } from '../executor/execute.ts';
import { registerQuoteRoutes } from './routes/quote.ts';
import { registerOrderRoutes } from './routes/order.ts';
import { registerStatusRoutes } from './routes/status.ts';
import { registerMetricsRoutes } from './routes/metrics.ts';
import { registerDashboardRoutes } from './routes/dashboard.ts';
import { ReconciliationWorker } from '../reconciliation/worker.ts';
import { createRpcClient } from '../quoter/fee-history.ts';

import { RefundEngine, type RefundRpc } from '../executor/refund.ts';
import { REFUND_CHAIN_ID } from '../config/policy.ts';

async function main(): Promise<void> {
  // Load environment
  const env = loadEnv();

  // Register only policy-bounded adapters. ERC-20 transfers stay disabled with no allowlist.
  if (env.erc20TransferAllowlist.length > 0) {
    registry.register(createErc20TransferAdapter(env.erc20TransferAllowlist));
  }
  registry.register(wethWrapAdapter);
  registry.register(wethUnwrapAdapter);
  registry.register(morphoAccrueInterestAdapter);

  // Create infrastructure
  const keeperHubClient = new KeeperHubClient({
    baseUrl: env.keeperHubBaseUrl,
    apiKey: env.keeperHubApiKey,
  });

  const ledger = new Ledger(
    process.env['DATABASE_PATH'] ?? 'data/basis.db',
    process.env['AUDIT_PATH'] ?? 'data/audit.jsonl',
  );

  const executor = new BasisExecutor({
    keeperHubClient,
    ledger,
    signingKey: env.basisSigningKey,
    rpcUrls: env.rpcUrls,
    environment: env.environment,
    oracleMaxStalenessSeconds: env.oracleMaxStalenessSeconds,
    oracleMaxDivergenceBps: env.oracleMaxDivergenceBps,
    oracleReference: env.oracleReference,
    allowTestFxFallback: env.allowTestFxFallback,
    testFxFallbackUsd: env.testFxFallbackUsd,
  });

  const refundRpcUrl = env.rpcUrls[REFUND_CHAIN_ID]!;
  const refundEngine = new RefundEngine(ledger, keeperHubClient, createRpcClient(REFUND_CHAIN_ID, refundRpcUrl) as unknown as RefundRpc, {
    enabled: env.refundsEnabled,
    confirmedWallet: env.refundWallet,
    minimumConfirmations: env.refundMinimumConfirmations,
  });
  const reconciler = new ReconciliationWorker(
    ledger,
    keeperHubClient,
    (chainId) => {
      const url = env.rpcUrls[chainId];
      if (!url) throw new Error(`No RPC URL configured for chain ${chainId}`);
      return createRpcClient(chainId, url);
    },
    refundEngine,
  );
  await reconciler.runOnce(true);
  let reconciliationRunning = false;
  const reconciliationTimer = setInterval(() => {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    void reconciler.runOnce(false)
      .catch((error) => app.log.error(error, 'Deterministic reconciliation failed'))
      .finally(() => { reconciliationRunning = false; });
  }, 30_000);

  // Create Fastify instance
  const app = Fastify({
    logger: true,
  });

  // Register routes
  registerQuoteRoutes(app, executor, ledger);
  registerOrderRoutes(app, executor, ledger, env.paidWorkflowCredentials, env.basisSigningKey);
  registerStatusRoutes(app, executor, ledger);
  registerMetricsRoutes(app, executor, ledger);
  registerDashboardRoutes(app);

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // Start server
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await app.listen({ port, host });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    app.log.info('Shutting down...');
    clearInterval(reconciliationTimer);
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
