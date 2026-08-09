/**
 * Job Adapter Interface.
 *
 * Every supported job type implements this interface. It defines:
 * - Schema validation for job parameters
 * - How to build the simulation/execution call
 * - How to derive the canonical intent for idempotency
 * - How to verify postconditions after execution
 * - Gas caps and safety properties
 */

export interface AdapterMeta {
  /** Unique job type identifier, e.g. 'erc20.transfer' */
  jobType: string;
  /** Semver version of this adapter */
  version: string;
  /** Human-readable description */
  description: string;
  /** Execution mode */
  mode: 'permissionless' | 'authorized';
  /** Maximum gas units this adapter will accept from simulation */
  maxGasEstimate: bigint;
  /** Whether native value (ETH) is sent with the call */
  sendsNativeValue: boolean;
  /** Supported chain IDs */
  supportedChains: number[];
}

export interface CallParams {
  /** Target contract address */
  to: `0x${string}`;
  /** Encoded calldata */
  data: `0x${string}`;
  /** Native value in wei (0n for most permissionless calls) */
  value: bigint;
  /** From address (Basis execution wallet) */
  from: `0x${string}`;
}

export interface SimulationParams {
  /** Target contract address */
  contractAddress: string;
  /** Function name for KeeperHub simulation */
  functionName: string;
  /** JSON-stringified function args array */
  functionArgs?: string;
  /** JSON-stringified ABI */
  abi: string;
  /** Native value in ether units (e.g. "0.0001") or undefined */
  value?: string;
}

export interface CanonicalFields {
  /** Fields contributing to the canonical intent hash, in order */
  fields: string[];
  /** Pipe-delimited canonical string */
  canonical: string;
}

export interface PostconditionCheck {
  /** Whether the postcondition was met */
  passed: boolean;
  /** Description of what was checked */
  check: string;
  /** Optional detail */
  detail?: string;
}

export interface JobAdapter<TParams = unknown> {
  /** Adapter metadata and safety properties */
  meta: AdapterMeta;

  /**
   * Validate raw job parameters. Throws if invalid.
   * Returns the typed, normalized params.
   */
  validateParams(raw: unknown, chainId?: number): TParams;

  /**
   * Build the on-chain call from validated params.
   * This is what gets simulated and executed.
   */
  buildCall(params: TParams, executorAddress: `0x${string}`): CallParams;

  /**
   * Build KeeperHub simulation/execution params.
   * KeeperHub needs function name + args + ABI, not raw calldata.
   */
  buildSimulation(params: TParams): SimulationParams;

  /**
   * Derive the canonical intent fields for idempotency key generation.
   * Must be deterministic and produce the same result for the same economic intent.
   */
  canonicalIntent(params: TParams, chainId: number, deadlineBucket: string): CanonicalFields;

  /**
   * Verify adapter-specific postconditions after execution.
   * Called with the transaction receipt events/state.
   */
  verifyPostconditions(
    params: TParams,
    receipt: PostconditionReceipt,
  ): PostconditionCheck[];

  /**
   * Human-readable summary of the job for display/logging.
   */
  describe(params: TParams): string;
}

export interface PostconditionReceipt {
  /** Expected Basis execution wallet */
  executorAddress: `0x${string}`;
  /** Transaction hash */
  transactionHash: `0x${string}`;
  /** Whether the transaction succeeded */
  status: 'success' | 'reverted';
  /** Gas used */
  gasUsed: bigint;
  /** Decoded logs relevant to this adapter */
  logs: DecodedLog[];
}

export interface DecodedLog {
  address: `0x${string}`;
  eventName: string;
  args: Record<string, unknown>;
}
