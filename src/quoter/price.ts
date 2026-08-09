/** Pure, versioned quote pricing with no network, storage, clock, or randomness. */
import { Decimal } from 'decimal.js';
import type { FeeSample } from './fee-history.ts';
import { feePercentile } from './fee-history.ts';
import { MARKETPLACE_FEE_BPS, selectPaymentTier } from '../config/policy.ts';

export interface QuoteInputs {
  gasEstimate: bigint;
  feeSamples: FeeSample[];
  feePercentileTarget: number;
  nativeAssetUsd: Decimal;
  targetMarginBps: number;
  fixedOverheadUsd: Decimal;
  pricingModelVersion: string;
}

export interface QuoteBreakdown {
  protectedGasPriceWei: bigint;
  marketExecutionCostUsd: Decimal;
  /** Always zero: Basis does not sell an unimplemented retry service. */
  riskCostUsd: Decimal;
  /** Always zero: Basis does not offer private routing. */
  privateRoutingFeeUsd: Decimal;
  fixedOverheadUsd: Decimal;
  targetMarginUsd: Decimal;
  /** Marketplace's 30% share of the buyer-facing gross price. */
  marketplaceFeeUsd: Decimal;
  marketplaceFeeBps: number;
  rawPriceUsd: Decimal;
  tierRoundingUsd: Decimal;
  payableTierUsd: Decimal;
  paymentTier: string;
  pricingModelVersion: string;
}

const WEI_PER_ETH = new Decimal('1000000000000000000');
const BPS = new Decimal(10_000);

export function priceQuote(inputs: QuoteInputs): QuoteBreakdown {
  const protectedGasPriceWei = feePercentile(inputs.feeSamples, inputs.feePercentileTarget);
  const gasCostWei = new Decimal(inputs.gasEstimate.toString()).mul(protectedGasPriceWei.toString());
  const marketExecutionCostUsd = gasCostWei.mul(inputs.nativeAssetUsd).div(WEI_PER_ETH);
  const riskCostUsd = new Decimal(0);
  const privateRoutingFeeUsd = new Decimal(0);
  const targetMarginUsd = marketExecutionCostUsd.mul(inputs.targetMarginBps).div(BPS);
  const sellerRequiredUsd = marketExecutionCostUsd.add(inputs.fixedOverheadUsd).add(targetMarginUsd);
  const rawPriceUsd = sellerRequiredUsd.div(BPS.sub(MARKETPLACE_FEE_BPS)).mul(BPS);
  const marketplaceFeeUsd = rawPriceUsd.sub(sellerRequiredUsd);
  const { tier, price: payableTierUsd } = selectPaymentTier(rawPriceUsd);

  return {
    protectedGasPriceWei,
    marketExecutionCostUsd,
    riskCostUsd,
    privateRoutingFeeUsd,
    fixedOverheadUsd: inputs.fixedOverheadUsd,
    targetMarginUsd,
    marketplaceFeeUsd,
    marketplaceFeeBps: MARKETPLACE_FEE_BPS,
    rawPriceUsd,
    tierRoundingUsd: payableTierUsd.sub(rawPriceUsd),
    payableTierUsd,
    paymentTier: tier,
    pricingModelVersion: inputs.pricingModelVersion,
  };
}
