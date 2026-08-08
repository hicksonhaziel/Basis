/**
 * Adapter Registry.
 *
 * Central registry for all job adapters. Job types are registered at startup.
 * The registry enforces:
 * - No duplicate job types
 * - Chain support validation
 * - Admission checklist (adapter meta must meet minimum safety criteria)
 */

import type { JobAdapter, AdapterMeta } from './adapter.ts';

class AdapterRegistry {
  private adapters = new Map<string, JobAdapter>();

  /**
   * Register an adapter. Throws if:
   * - Job type already registered
   * - Adapter fails admission checklist
   */
  register(adapter: JobAdapter): void {
    const { jobType } = adapter.meta;

    if (this.adapters.has(jobType)) {
      throw new Error(`Adapter already registered: ${jobType}`);
    }

    this.validateAdmission(adapter.meta);
    this.adapters.set(jobType, adapter);
  }

  /**
   * Look up an adapter by job type.
   */
  get(jobType: string): JobAdapter | undefined {
    return this.adapters.get(jobType);
  }

  /**
   * Get an adapter or throw.
   */
  require(jobType: string): JobAdapter {
    const adapter = this.adapters.get(jobType);
    if (!adapter) {
      throw new Error(`No adapter registered for job type: ${jobType}`);
    }
    return adapter;
  }

  /**
   * List all registered job types.
   */
  listJobTypes(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * List all adapters with their metadata.
   */
  listAdapters(): AdapterMeta[] {
    return [...this.adapters.values()].map((a) => a.meta);
  }

  /**
   * Check if a job type is supported on a given chain.
   */
  supportsChain(jobType: string, chainId: number): boolean {
    const adapter = this.adapters.get(jobType);
    if (!adapter) return false;
    return adapter.meta.supportedChains.includes(chainId);
  }

  /**
   * Admission checklist validation.
   * Every adapter must meet minimum safety criteria.
   */
  private validateAdmission(meta: AdapterMeta): void {
    if (!meta.jobType || meta.jobType.length === 0) {
      throw new Error('Adapter must have a non-empty jobType');
    }
    if (!meta.version || !meta.version.match(/^\d+\.\d+\.\d+$/)) {
      throw new Error(`Adapter ${meta.jobType}: version must be semver (got "${meta.version}")`);
    }
    if (meta.maxGasEstimate <= 0n) {
      throw new Error(`Adapter ${meta.jobType}: maxGasEstimate must be positive`);
    }
    if (meta.supportedChains.length === 0) {
      throw new Error(`Adapter ${meta.jobType}: must support at least one chain`);
    }
  }
}

/** Singleton registry instance */
export const registry = new AdapterRegistry();
