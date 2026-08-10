#!/usr/bin/env node
/**
 * CLI: Request a Quote.
 *
 * Usage:
 *   node --experimental-strip-types src/cli/quote.ts [--chain <chainId>] [--amount <wei>] [--tier <tier>]
 *
 * Defaults:
 *   chain: 84532 (Base Sepolia)
 *   amount: 1000000000000000 (0.001 ETH)
 *   tier: best-effort
 *
 * Required env:
 *   KEEPERHUB_API_KEY, BASIS_SIGNING_KEY
 */

import { parseArgs } from 'node:util';
import { loadEnv } from '../config/env.ts';
import { KeeperHubClient } from '../keeperhub/client.ts';
import { Ledger } from '../ledger/database.ts';
import { registry } from '../adapters/registry.ts';
import { wethWrapAdapter } from '../adapters/weth-wrap.ts';
import { BasisExecutor } from '../executor/execute.ts';
import type { DeadlineTier } from '../config/policy.ts';

// ─── Parse CLI args ──────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    chain: { type: 'string', default: '84532' },
    amount: { type: 'string', default: '1000000000000000' },
    tier: { type: 'string', default: 'best-effort' },
    'refund-recipient': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`
Basis Quote CLI

Request a weth.wrap quote and display the price breakdown.

Options:
  --chain <id>     Chain ID (default: 84532 = Base Sepolia)
  --amount <wei>   Amount of ETH to wrap in wei (default: 1000000000000000)
  --tier <tier>    Deadline tier: next-block | 5m | 1h | best-effort (default: best-effort)
  --refund-recipient <address>  Required EVM recipient for any future refund
  -h, --help       Show this help

Environment:
  KEEPERHUB_API_KEY     KeeperHub org API key (required)
  BASIS_SIGNING_KEY     HMAC signing key for quotes (required)
  RPC_URL_BASE_SEPOLIA  RPC URL for Base Sepolia (optional)
`);
  process.exit(0);
}

const chainId = parseInt(values.chain!, 10);
const amount = values.amount!;
const deadlineTier = values.tier! as DeadlineTier;
const refundRecipient = values['refund-recipient'];
if (!refundRecipient) {
  console.error('--refund-recipient is required');
  process.exit(1);
}

// Validate tier
const validTiers: DeadlineTier[] = ['next-block', '5m', '1h', 'best-effort'];
if (!validTiers.includes(deadlineTier)) {
  console.error(`Invalid tier: ${deadlineTier}. Must be one of: ${validTiers.join(', ')}`);
  process.exit(1);
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load environment
  const env = loadEnv();

  // Register adapters
  if (!registry.listJobTypes().includes('weth.wrap')) {
    registry.register(wethWrapAdapter);
  }

  // Create dependencies
  const keeperHubClient = new KeeperHubClient({
    baseUrl: env.keeperHubBaseUrl,
    apiKey: env.keeperHubApiKey,
  });

  const ledger = new Ledger(
    'data/basis.db',
    'data/audit.jsonl',
  );

  // Create executor
  const executor = new BasisExecutor({
    keeperHubClient,
    ledger,
    signingKey: env.basisSigningKey,
    rpcUrls: env.rpcUrls,
  });

  // Request quote
  console.log(`\n─── Basis Quote Request ───`);
  console.log(`  Job type:  weth.wrap`);
  console.log(`  Chain:     ${chainId}`);
  console.log(`  Amount:    ${amount} wei`);
  console.log(`  Tier:      ${deadlineTier}`);
  console.log(`──────────────────────────\n`);

  try {
    const quote = await executor.requestQuote({
      jobType: 'weth.wrap',
      params: { chainId, amount },
      chainId,
      deadlineTier,
      refundRecipient: refundRecipient!,
    });

    console.log(`✓ Quote issued: ${quote.quoteId}\n`);
    console.log(`─── Price Breakdown ───`);
    console.log(`  Gas estimate:        ${quote.breakdown.gasEstimate} gas`);
    console.log(`  Protected gas price: ${quote.breakdown.protectedGasPriceWei} wei`);
    console.log(`  ETH/USD:             $${quote.breakdown.nativeAssetUsd}`);
    console.log(`  Market exec cost:    $${quote.breakdown.marketExecutionCostUsd}`);
    console.log(`  Marketplace fee:     $${quote.breakdown.marketplaceFeeUsd} (${quote.breakdown.marketplaceFeeBps} bps)`);
    console.log(`  Fixed overhead:      $${quote.breakdown.fixedOverheadUsd}`);
    console.log(`  Target margin:       $${quote.breakdown.targetMarginUsd}`);
    console.log(`  Raw price:           $${quote.breakdown.rawPriceUsd}`);
    console.log(`  Tier rounding:       $${quote.breakdown.tierRoundingUsd}`);
    console.log(`──────────────────────────`);
    console.log(`  ► Payable:           $${quote.priceUsd} (${quote.paymentTier})`);
    console.log(`──────────────────────────\n`);
    console.log(`  Model:     ${quote.pricingModelVersion}`);
    console.log(`  Expires:   ${quote.expiresAt}`);
    console.log(`  Deadline:  ${quote.deadlineAt}`);
    console.log(`  Signature: ${quote.signature.slice(0, 16)}...`);
  } catch (err) {
    console.error(`\n✗ Quote failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    ledger.close();
  }
}

main();
