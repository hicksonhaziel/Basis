/** Permissionless maintenance for one immutable Morpho Blue market on Base Sepolia. */
import { encodeAbiParameters, encodeFunctionData, keccak256 } from 'viem';
import type { AdapterMeta, AdapterRpc, CallParams, CanonicalFields, JobAdapter, PostconditionCheck, PostconditionReceipt, SimulationParams } from './adapter.ts';
import { VerificationFailure, VerificationUncertain } from '../executor/verify.ts';
import { canonicalJson } from '../integrity/canonical.ts';

export const MORPHO_CHAIN_ID = 84532;
export const MORPHO_ADDRESS = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const;
export const MORPHO_RUNTIME_CODE_HASH = '0xde5df0406e830f48506c94032a90a393b444b3de1cd5340d8c1a131a41189d3d' as const;
export const MORPHO_IRM_ADDRESS = '0x46415998764C29aB2a25CbeA6254146D50D22687' as const;
export const MORPHO_IRM_RUNTIME_CODE_HASH = '0x9978b522abfe0f3b8279800375d833b9d9660ae4f6321a2efb1f1f98850a0cbe' as const;
export const MORPHO_MARKET_ID = '0xe36464b73c0c39836918f7b2b9a6f1a8b70d7bb9901b38f29544d9b96119862e' as const;
export const MORPHO_SELECTOR = '0x151c1ade' as const;
export const MORPHO_ACCRUE_INTEREST_TOPIC = '0x9d9bd501d0657d7dfe415f779a620a62b78bc508ddc0891fbbd8b7ac0f8fce87' as const;
export const MIN_ACCRUAL_STALENESS_SECONDS = 300n;
export const MORPHO_MARKET_PARAMS = {
  loanToken: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  collateralToken: '0x4200000000000000000000000000000000000006',
  oracle: '0x1631366C38d49ba58793A5F219050923fbF24C81',
  irm: MORPHO_IRM_ADDRESS,
  lltv: 915_000_000_000_000_000n,
} as const;
const MARKET_PARAMS_COMPONENTS = [
  { name: 'loanToken', type: 'address' }, { name: 'collateralToken', type: 'address' }, { name: 'oracle', type: 'address' },
  { name: 'irm', type: 'address' }, { name: 'lltv', type: 'uint256' },
] as const;
export const MORPHO_ACCRUE_INTEREST_ABI = [
  { name: 'accrueInterest', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'marketParams', type: 'tuple', components: MARKET_PARAMS_COMPONENTS }], outputs: [] },
  { name: 'idToMarketParams', type: 'function', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: MARKET_PARAMS_COMPONENTS },
  { name: 'market', type: 'function', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [
    { name: 'totalSupplyAssets', type: 'uint128' }, { name: 'totalSupplyShares', type: 'uint128' }, { name: 'totalBorrowAssets', type: 'uint128' },
    { name: 'totalBorrowShares', type: 'uint128' }, { name: 'lastUpdate', type: 'uint128' }, { name: 'fee', type: 'uint128' },
  ] },
  { name: 'AccrueInterest', type: 'event', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'prevBorrowRate', type: 'uint256', indexed: false },
    { name: 'interest', type: 'uint256', indexed: false }, { name: 'feeShares', type: 'uint256', indexed: false },
  ] },
] as const;

export interface MorphoAccrueInterestParams {
  adapterVersion: '1.0.0'; chainId: typeof MORPHO_CHAIN_ID; morphoAddress: typeof MORPHO_ADDRESS;
  morphoRuntimeCodeHash: typeof MORPHO_RUNTIME_CODE_HASH; irmAddress: typeof MORPHO_IRM_ADDRESS;
  irmRuntimeCodeHash: typeof MORPHO_IRM_RUNTIME_CODE_HASH; marketId: typeof MORPHO_MARKET_ID;
  marketParams: typeof MORPHO_MARKET_PARAMS; selector: typeof MORPHO_SELECTOR; eventTopic: typeof MORPHO_ACCRUE_INTEREST_TOPIC;
  nativeValueWei: '0'; maxGasEstimate: '180000'; minStalenessSeconds: '300';
}
type MarketTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
type MarketParamsTuple = readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint];
class PinnedPolicyMismatch extends Error {}
const meta: AdapterMeta = { jobType: 'morpho.accrue_interest', version: '1.0.0', description: 'Accrue interest for one pinned Morpho Blue market on Base Sepolia', mode: 'permissionless', maxGasEstimate: 180_000n, sendsNativeValue: false, supportedChains: [MORPHO_CHAIN_ID] };

function paramsTuple(): MarketParamsTuple {
  const p = MORPHO_MARKET_PARAMS;
  return [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv];
}
export function deriveMorphoMarketId(): `0x${string}` {
  return keccak256(encodeAbiParameters(MARKET_PARAMS_COMPONENTS, paramsTuple()));
}
export function runtimeCodeHashMatches(bytecode: `0x${string}` | undefined, expected: `0x${string}`): boolean {
  return !!bytecode && keccak256(bytecode) === expected;
}
function assertPinnedMarketId(): void {
  if (deriveMorphoMarketId() !== MORPHO_MARKET_ID) throw new PinnedPolicyMismatch('morpho.accrue_interest: pinned market ID does not match MarketParams');
}
function sameAddress(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
}
function assertPinnedMarket(actual: unknown): void {
  if (!Array.isArray(actual) || actual.length !== 5) throw new PinnedPolicyMismatch('morpho.accrue_interest: malformed idToMarketParams result');
  const expected = paramsTuple();
  for (let index = 0; index < 4; index++) if (!sameAddress(actual[index], expected[index] as string)) throw new PinnedPolicyMismatch('morpho.accrue_interest: on-chain MarketParams mismatch');
  if (BigInt(actual[4] as bigint | string) !== expected[4]) throw new PinnedPolicyMismatch('morpho.accrue_interest: on-chain MarketParams LLTV mismatch');
}
export function validatePinnedMorphoMarketParams(actual: unknown): void {
  assertPinnedMarket(actual);
}
function assertMarketTuple(actual: unknown): asserts actual is MarketTuple {
  if (!Array.isArray(actual) || actual.length !== 6 || actual.some((value) => typeof value !== 'bigint')) throw new PinnedPolicyMismatch('morpho.accrue_interest: malformed market state');
}
async function assertImmutableDeployment(rpc: AdapterRpc, blockNumber?: bigint): Promise<void> {
  assertPinnedMarketId();
  if (await rpc.getChainId() !== MORPHO_CHAIN_ID) throw new PinnedPolicyMismatch('morpho.accrue_interest: RPC chain ID mismatch');
  const [morphoCode, irmCode, rawParams] = await Promise.all([
    rpc.getBytecode({ address: MORPHO_ADDRESS, blockNumber }),
    rpc.getBytecode({ address: MORPHO_IRM_ADDRESS, blockNumber }),
    rpc.readContract({ address: MORPHO_ADDRESS, abi: MORPHO_ACCRUE_INTEREST_ABI, functionName: 'idToMarketParams', args: [MORPHO_MARKET_ID], ...(blockNumber === undefined ? {} : { blockNumber }) }),
  ]);
  if (!runtimeCodeHashMatches(morphoCode, MORPHO_RUNTIME_CODE_HASH)) throw new PinnedPolicyMismatch('morpho.accrue_interest: Morpho runtime code hash mismatch');
  if (!runtimeCodeHashMatches(irmCode, MORPHO_IRM_RUNTIME_CODE_HASH)) throw new PinnedPolicyMismatch('morpho.accrue_interest: IRM runtime code hash mismatch');
  assertPinnedMarket(rawParams);
}
async function readMarket(rpc: AdapterRpc, blockNumber?: bigint): Promise<MarketTuple> {
  const raw = await rpc.readContract({ address: MORPHO_ADDRESS, abi: MORPHO_ACCRUE_INTEREST_ABI, functionName: 'market', args: [MORPHO_MARKET_ID], ...(blockNumber === undefined ? {} : { blockNumber }) });
  assertMarketTuple(raw);
  return raw;
}
export function validateMorphoPreflightState(market: readonly bigint[], timestamp: bigint): void {
  assertMarketTuple(market);
  const lastUpdate = market[4];
  if (lastUpdate === 0n) throw new PinnedPolicyMismatch('morpho.accrue_interest: pinned market is uncreated');
  if (timestamp < lastUpdate) throw new PinnedPolicyMismatch('morpho.accrue_interest: market lastUpdate is in the future');
  if (timestamp - lastUpdate < MIN_ACCRUAL_STALENESS_SECONDS) throw new PinnedPolicyMismatch('morpho.accrue_interest: market staleness is below 300 seconds');
  if (market[2] === 0n) throw new PinnedPolicyMismatch('morpho.accrue_interest: totalBorrowAssets is zero');
  if (market[3] === 0n) throw new PinnedPolicyMismatch('morpho.accrue_interest: totalBorrowShares is zero');
  if (market[5] !== 0n) throw new PinnedPolicyMismatch('morpho.accrue_interest: market fee is nonzero');
}
async function assertAccrualEligible(rpc: AdapterRpc): Promise<void> {
  await assertImmutableDeployment(rpc);
  const [latest, market] = await Promise.all([rpc.getBlock(), readMarket(rpc)]);
  validateMorphoPreflightState(market, latest.timestamp);
}
function validateEmptyObject(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype || Object.keys(raw as object).length !== 0) throw new Error('morpho.accrue_interest: params must be exactly {}');
}
function pinnedParams(): MorphoAccrueInterestParams {
  assertPinnedMarketId();
  return {
    adapterVersion: '1.0.0', chainId: MORPHO_CHAIN_ID, morphoAddress: MORPHO_ADDRESS, morphoRuntimeCodeHash: MORPHO_RUNTIME_CODE_HASH,
    irmAddress: MORPHO_IRM_ADDRESS, irmRuntimeCodeHash: MORPHO_IRM_RUNTIME_CODE_HASH, marketId: MORPHO_MARKET_ID,
    marketParams: MORPHO_MARKET_PARAMS, selector: MORPHO_SELECTOR, eventTopic: MORPHO_ACCRUE_INTEREST_TOPIC,
    nativeValueWei: '0', maxGasEstimate: '180000', minStalenessSeconds: '300',
  };
}
function assertExactPersisted(raw: unknown, chainId: number): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('morpho.accrue_interest: persisted params must be a plain object');
  const actual = raw as Record<string, unknown>;
  const expected = JSON.parse(JSON.stringify(pinnedParams(), (_key, value) => typeof value === 'bigint' ? value.toString() : value)) as Record<string, unknown>;
  if (chainId !== MORPHO_CHAIN_ID || canonicalJson(actual) !== canonicalJson(expected)) throw new Error('morpho.accrue_interest: persisted pinned policy fields mismatch');
}
export function evaluateMorphoAccrualEvent(receipt: PostconditionReceipt): { count: number; valid: boolean; detail: string } {
  const morphoRawLogs = receipt.rawLogs.filter((log) => log.address.toLowerCase() === MORPHO_ADDRESS.toLowerCase());
  const events = receipt.logs.filter((log) => log.address.toLowerCase() === MORPHO_ADDRESS.toLowerCase() && log.eventName === 'AccrueInterest');
  const event = events[0];
  let valid = false;
  try {
    valid = morphoRawLogs.length === 1 && morphoRawLogs[0]?.topics[0]?.toLowerCase() === MORPHO_ACCRUE_INTEREST_TOPIC
      && events.length === 1 && !!event
      && String(event.args.id).toLowerCase() === MORPHO_MARKET_ID
      && BigInt(event.args.prevBorrowRate as string | bigint) > 0n
      && BigInt(event.args.interest as string | bigint) > 0n
      && BigInt(event.args.feeShares as string | bigint) === 0n;
  } catch { valid = false; }
  return { count: morphoRawLogs.length, valid, detail: event ? JSON.stringify(event.args) : 'AccrueInterest event absent' };
}
function proofFailure(message: string, sponsored: boolean): Error {
  return sponsored ? new VerificationUncertain(message) : new VerificationFailure(message);
}

export function validateMorphoReceiptBlockState(market: readonly bigint[], blockTimestamp: bigint): void {
  assertMarketTuple(market);
  if (market[4] !== blockTimestamp) throw new VerificationFailure('Receipt-block market.lastUpdate does not equal block timestamp');
  if (market[2] === 0n || market[3] === 0n) throw new VerificationFailure('Receipt-block borrow state is not positive');
  if (market[5] !== 0n) throw new VerificationFailure('Receipt-block market fee is nonzero');
}

export const morphoAccrueInterestAdapter: JobAdapter<MorphoAccrueInterestParams> = {
  meta,
  validateParams(raw, chainId) {
    validateEmptyObject(raw);
    if (chainId !== MORPHO_CHAIN_ID) throw new Error(`morpho.accrue_interest: unsupported chain ${chainId}`);
    return pinnedParams();
  },
  validatePersistedParams(raw, chainId) { assertExactPersisted(raw, chainId); return pinnedParams(); },
  buildCall(_params, executorAddress): CallParams {
    const data = encodeFunctionData({ abi: MORPHO_ACCRUE_INTEREST_ABI, functionName: 'accrueInterest', args: [MORPHO_MARKET_PARAMS] });
    if (!data.startsWith(MORPHO_SELECTOR)) throw new Error('morpho.accrue_interest: encoded selector mismatch');

    return { to: MORPHO_ADDRESS, data, value: 0n, from: executorAddress };
  },
  buildSimulation(): SimulationParams {
    return { contractAddress: MORPHO_ADDRESS, functionName: 'accrueInterest', functionArgs: JSON.stringify([{ ...MORPHO_MARKET_PARAMS, lltv: MORPHO_MARKET_PARAMS.lltv.toString() }]), abi: JSON.stringify(MORPHO_ACCRUE_INTEREST_ABI) };
  },
  canonicalIntent(_params, chainId, bucket): CanonicalFields {
    const canonical = [`${meta.jobType}@${meta.version}`, chainId, MORPHO_ADDRESS.toLowerCase(), MORPHO_SELECTOR, MORPHO_MARKET_ID,
      MORPHO_MARKET_PARAMS.loanToken.toLowerCase(), MORPHO_MARKET_PARAMS.collateralToken.toLowerCase(), MORPHO_MARKET_PARAMS.oracle.toLowerCase(),
      MORPHO_MARKET_PARAMS.irm.toLowerCase(), MORPHO_MARKET_PARAMS.lltv, '0', bucket].join('|');
    return { fields: ['adapterVersion','chainId','morpho','selector','marketId','loanToken','collateralToken','oracle','irm','lltv','valueWei','deadlineBucket'], canonical };
  },
  quotePreflight: async (_params, rpc) => assertAccrualEligible(rpc),
  preSubmitPreflight: async (_params, rpc) => assertAccrualEligible(rpc),
  verifyPostconditions(_params, receipt): PostconditionCheck[] {
    const proof = evaluateMorphoAccrualEvent(receipt);
    return [{ passed: proof.valid, check: 'Exactly one Morpho log is the pinned positive AccrueInterest event with zero fee shares', detail: proof.detail }];
  },
  async verifyHistoricalReceipt(_params, receipt, rpc, context) {
    try {
      const proof = evaluateMorphoAccrualEvent(receipt);
      if (!proof.valid) throw proofFailure('Exact Morpho AccrueInterest proof is missing or invalid', context.sponsored);
      await assertImmutableDeployment(rpc, receipt.blockNumber);
      const [block, market] = await Promise.all([rpc.getBlock({ blockNumber: receipt.blockNumber }), readMarket(rpc, receipt.blockNumber)]);
      try { validateMorphoReceiptBlockState(market, block.timestamp); }
      catch (error) { throw proofFailure(error instanceof Error ? error.message : String(error), context.sponsored); }
      return [{ passed: true, check: 'Historical Morpho state matches the exact accrual receipt block', detail: `block=${receipt.blockNumber} timestamp=${block.timestamp}` }];
    } catch (error) {
      if (error instanceof VerificationFailure || error instanceof VerificationUncertain) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PinnedPolicyMismatch) throw proofFailure(message, context.sponsored);
      throw new VerificationUncertain(`Historical Morpho receipt proof unavailable: ${message}`);
    }
  },
  describe: () => `Morpho accrueInterest: Base Sepolia market ${MORPHO_MARKET_ID}`,
};
