import type { ExecuteContractCallRequest, SimulationSuccess } from '../keeperhub/client.ts';

export interface CanonicalExecutionIntent {
  adapterName: string;
  adapterVersion: string;
  chainId: number;
  target: `0x${string}`;
  functionName: string;
  functionArgs?: string;
  abi: string;
  calldata: `0x${string}`;
  nativeValueWei: string;
  keeperHubValue?: string;
  executorAddress: `0x${string}`;
  deadlineAt: string;
  validatedParams: unknown;
}

export interface PersistedExecutionIntent extends CanonicalExecutionIntent {
  quoteId: string;
  orderId: string;
  idempotencyKey: string;
}

export function toJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return value;
}

export function keeperHubRequest(intent: CanonicalExecutionIntent): ExecuteContractCallRequest {
  return {
    contractAddress: intent.target,
    chainId: intent.chainId,
    functionName: intent.functionName,
    functionArgs: intent.functionArgs,
    abi: intent.abi,
    value: intent.keeperHubValue,
  };
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function simulationValueWei(value: string): bigint {
  if (/^\d+$/.test(value)) return BigInt(value);
  if (!/^\d+\.\d+$/.test(value)) throw new Error(`Invalid simulation value: ${value}`);
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > 18) throw new Error('Simulation value has more than 18 decimals');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

export function assertSimulationMatchesIntent(simulation: SimulationSuccess, intent: CanonicalExecutionIntent): void {
  if (simulation.from.toLowerCase() !== intent.executorAddress.toLowerCase()) throw new Error('Re-simulation executor mismatch');
  if (simulation.to.toLowerCase() !== intent.target.toLowerCase()) throw new Error('Re-simulation target mismatch');
  if (simulationValueWei(simulation.value) !== BigInt(intent.nativeValueWei)) throw new Error('Re-simulation value mismatch');
}

export function assertRequestMatchesIntent(request: ExecuteContractCallRequest, intent: CanonicalExecutionIntent): void {
  const expected = keeperHubRequest(intent);
  if (stableJson(request) !== stableJson(expected)) throw new Error('Outbound KeeperHub request differs from signed canonical intent');
}
