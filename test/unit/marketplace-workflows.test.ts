import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASIS_MARKETPLACE_WORKFLOWS, PAID_ORDER_INPUT_SCHEMA, buildKeeperHubWorkflow, validateBasisWorkflowDefinitions } from '../../src/marketplace/workflows.ts';

const expectedPrices = new Map([
  ['basis-quote', '0'], ['basis-order-t1', '0.01'], ['basis-order-t2', '0.05'],
  ['basis-order-t3', '0.25'], ['basis-order-t4', '1.00'], ['basis-status', '0'],
]);

describe('KeeperHub Marketplace workflow definitions', () => {
  it('contains exactly six deterministic thin read wrappers at exact fixed prices', () => {
    validateBasisWorkflowDefinitions();
    assert.equal(BASIS_MARKETPLACE_WORKFLOWS.length, 6);
    for (const definition of BASIS_MARKETPLACE_WORKFLOWS) {
      assert.equal(definition.workflowType, 'read');
      assert.equal(definition.priceUsdcPerCall, expectedPrices.get(definition.slug));
      const first = buildKeeperHubWorkflow(definition, 'https://basis.example', definition.credentialEnv ? 'x'.repeat(32) : undefined);
      const second = buildKeeperHubWorkflow(definition, 'https://basis.example', definition.credentialEnv ? 'x'.repeat(32) : undefined);
      assert.deepEqual(first, second);
      assert.equal(first.nodes.length, 2);
      assert.equal((first.nodes[1]!.data.config as Record<string, unknown>).actionType, 'webhook/send-webhook');
      assert.doesNotMatch(JSON.stringify(first), /write-contract|protocol-write/i);
    }
  });

  it('paid wrappers accept only quoteId and no transaction or refund fields', () => {
    for (const definition of BASIS_MARKETPLACE_WORKFLOWS.filter((item) => item.slug.startsWith('basis-order-'))) {
      assert.deepEqual(definition.inputSchema, PAID_ORDER_INPUT_SCHEMA);
      assert.deepEqual(Object.keys((definition.inputSchema.properties as Record<string, unknown>)), ['quoteId']);
      assert.equal(definition.inputSchema.additionalProperties, false);
    }
  });

  it('quote and status are free while each paid listing has a distinct credential source', () => {
    assert.equal(BASIS_MARKETPLACE_WORKFLOWS.find((item) => item.slug === 'basis-quote')!.priceUsdcPerCall, '0');
    assert.equal(BASIS_MARKETPLACE_WORKFLOWS.find((item) => item.slug === 'basis-status')!.priceUsdcPerCall, '0');
    const credentialEnvs = BASIS_MARKETPLACE_WORKFLOWS.filter((item) => item.credentialEnv).map((item) => item.credentialEnv);
    assert.equal(new Set(credentialEnvs).size, 4);
  });

  it('public schemas and outputs never contain authentication secrets', () => {
    const publicContract = BASIS_MARKETPLACE_WORKFLOWS.map(({ inputSchema, outputSchema, outputMapping }) => ({ inputSchema, outputSchema, outputMapping }));
    const serialized = JSON.stringify(publicContract);
    for (const secret of ['t1-secret', 'Bearer', 'Authorization', 'BASIS_ORDER_T1_SECRET']) assert.equal(serialized.includes(secret), false);
  });
});
