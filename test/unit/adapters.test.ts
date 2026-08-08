import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { JobAdapter, CallParams, SimulationParams, CanonicalFields, PostconditionCheck, PostconditionReceipt } from '../../src/adapters/adapter.ts';

// We can't easily reset the singleton, so we test via a fresh import of the class logic.
// For this test we'll create a minimal mock adapter.
function makeMockAdapter(overrides: Partial<JobAdapter['meta']> = {}): JobAdapter {
  return {
    meta: {
      jobType: 'test.mock',
      version: '1.0.0',
      description: 'Mock adapter for testing',
      mode: 'permissionless',
      maxGasEstimate: 100_000n,
      sendsNativeValue: false,
      supportedChains: [8453, 84532],
      ...overrides,
    },
    validateParams(raw: unknown) {
      return raw;
    },
    buildCall(_params, executorAddress): CallParams {
      return {
        to: '0x0000000000000000000000000000000000000001',
        data: '0x',
        value: 0n,
        from: executorAddress,
      };
    },
    buildSimulation(_params): SimulationParams {
      return {
        contractAddress: '0x0000000000000000000000000000000000000001',
        functionName: 'mock',
        abi: '[]',
      };
    },
    canonicalIntent(_params, chainId, deadlineBucket): CanonicalFields {
      return {
        fields: ['adapterVersion', 'chainId', 'deadlineBucket'],
        canonical: `test.mock@1.0.0|${chainId}|${deadlineBucket}`,
      };
    },
    verifyPostconditions(_params, _receipt): PostconditionCheck[] {
      return [{ passed: true, check: 'mock-check' }];
    },
    describe(_params) {
      return 'Mock test job';
    },
  };
}

describe('adapters/registry', () => {
  // We dynamically import a fresh registry module each test by using the registry directly
  // Since the singleton persists, we test registration behavior carefully.

  it('registers and retrieves an adapter', async () => {
    // Use dynamic import to get registry
    const { AdapterRegistry } = await import('../../src/adapters/registry.ts') as any;
    // Actually the exported thing is a singleton. Let's just test it.
    const { registry } = await import('../../src/adapters/registry.ts');

    // Check if test.mock is already registered (from another test run in same process)
    if (!registry.get('test.mock')) {
      const adapter = makeMockAdapter();
      registry.register(adapter);
    }
    const found = registry.require('test.mock');
    assert.equal(found.meta.jobType, 'test.mock');
    assert.equal(found.meta.version, '1.0.0');
  });

  it('rejects duplicate registration', async () => {
    const { registry } = await import('../../src/adapters/registry.ts');
    if (!registry.get('test.duplicate')) {
      registry.register(makeMockAdapter({ jobType: 'test.duplicate' }));
    }
    assert.throws(
      () => registry.register(makeMockAdapter({ jobType: 'test.duplicate' })),
      /already registered/,
    );
  });

  it('rejects adapter with invalid version', async () => {
    const { registry } = await import('../../src/adapters/registry.ts');
    assert.throws(
      () => registry.register(makeMockAdapter({ jobType: 'test.badversion', version: 'nope' })),
      /version must be semver/,
    );
  });

  it('rejects adapter with zero maxGasEstimate', async () => {
    const { registry } = await import('../../src/adapters/registry.ts');
    assert.throws(
      () => registry.register(makeMockAdapter({ jobType: 'test.zerogas', maxGasEstimate: 0n })),
      /maxGasEstimate must be positive/,
    );
  });

  it('rejects adapter with no supported chains', async () => {
    const { registry } = await import('../../src/adapters/registry.ts');
    assert.throws(
      () => registry.register(makeMockAdapter({ jobType: 'test.nochains', supportedChains: [] })),
      /must support at least one chain/,
    );
  });

  it('supportsChain returns correct results', async () => {
    const { registry } = await import('../../src/adapters/registry.ts');
    if (!registry.get('test.chaincheck')) {
      registry.register(makeMockAdapter({ jobType: 'test.chaincheck', supportedChains: [8453] }));
    }
    assert.equal(registry.supportsChain('test.chaincheck', 8453), true);
    assert.equal(registry.supportsChain('test.chaincheck', 1), false);
    assert.equal(registry.supportsChain('nonexistent', 8453), false);
  });

  it('require throws for unknown job type', async () => {
    const { registry } = await import('../../src/adapters/registry.ts');
    assert.throws(
      () => registry.require('does.not.exist'),
      /No adapter registered/,
    );
  });

  it('listJobTypes returns registered types', async () => {
    const { registry } = await import('../../src/adapters/registry.ts');
    const types = registry.listJobTypes();
    assert.ok(types.includes('test.mock'));
  });
});
