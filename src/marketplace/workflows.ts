export type BasisWorkflowSlug = 'basis-quote' | 'basis-order-t1' | 'basis-order-t2' | 'basis-order-t3' | 'basis-order-t4' | 'basis-status';

export interface BasisMarketplaceWorkflow {
  slug: BasisWorkflowSlug;
  name: string;
  description: string;
  endpointPath: '/quote' | '/orders' | '/orders/{{@trigger:Trigger.orderId}}';
  credentialEnv?: 'BASIS_ORDER_T1_SECRET' | 'BASIS_ORDER_T2_SECRET' | 'BASIS_ORDER_T3_SECRET' | 'BASIS_ORDER_T4_SECRET';
  priceUsdcPerCall: '0' | '0.01' | '0.05' | '0.25' | '1.00';
  workflowType: 'read';
  inputSchema: Record<string, unknown>;
  outputMapping: { nodeId: 'webhook'; fields: ['response'] };
  outputSchema: Record<string, unknown>;
}

const evmAddress = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$', description: 'Future refund recipient cryptographically bound into the signed quote' };
const quoteInput = {
  type: 'object',
  required: ['jobType', 'params', 'chainId', 'deadlineTier', 'refundRecipient'],
  properties: {
    jobType: { type: 'string', enum: ['weth.wrap', 'weth.unwrap', 'erc20.transfer'] },
    params: { type: 'object', description: 'Structured parameters validated by the selected Basis adapter' },
    chainId: { type: 'integer' },
    deadlineTier: { type: 'string', enum: ['next-block', '5m', '1h', 'best-effort'] },
    refundRecipient: evmAddress,
  },
  additionalProperties: false,
};
export const PAID_ORDER_INPUT_SCHEMA = {
  type: 'object',
  required: ['quoteId'],
  properties: { quoteId: { type: 'string', description: 'Signed, unconsumed Basis quote identifier' } },
  additionalProperties: false,
};
const statusInput = {
  type: 'object', required: ['orderId'],
  properties: { orderId: { type: 'string', description: 'Basis order identifier' } },
  additionalProperties: false,
};

const orderOutput = { type: 'object', properties: { orderId: { type: 'string' }, state: { type: 'string' }, duplicate: { type: 'boolean' } } };

export const BASIS_MARKETPLACE_WORKFLOWS: readonly BasisMarketplaceWorkflow[] = [
  { slug: 'basis-quote', name: 'basis-quote', description: 'Return a signed, expiring Basis execution quote without executing it.', endpointPath: '/quote', priceUsdcPerCall: '0', workflowType: 'read', inputSchema: quoteInput, outputMapping: { nodeId: 'webhook', fields: ['response'] }, outputSchema: { type: 'object', properties: { quoteId: { type: 'string' }, expiresAt: { type: 'string' }, priceUsd: { type: 'string' }, paymentTier: { type: 'string' }, signature: { type: 'string' } } } },
  { slug: 'basis-order-t1', name: 'basis-order-t1', description: 'Accept a signed Basis $0.01-tier quote for asynchronous execution.', endpointPath: '/orders', credentialEnv: 'BASIS_ORDER_T1_SECRET', priceUsdcPerCall: '0.01', workflowType: 'read', inputSchema: PAID_ORDER_INPUT_SCHEMA, outputMapping: { nodeId: 'webhook', fields: ['response'] }, outputSchema: orderOutput },
  { slug: 'basis-order-t2', name: 'basis-order-t2', description: 'Accept a signed Basis $0.05-tier quote for asynchronous execution.', endpointPath: '/orders', credentialEnv: 'BASIS_ORDER_T2_SECRET', priceUsdcPerCall: '0.05', workflowType: 'read', inputSchema: PAID_ORDER_INPUT_SCHEMA, outputMapping: { nodeId: 'webhook', fields: ['response'] }, outputSchema: orderOutput },
  { slug: 'basis-order-t3', name: 'basis-order-t3', description: 'Accept a signed Basis $0.25-tier quote for asynchronous execution.', endpointPath: '/orders', credentialEnv: 'BASIS_ORDER_T3_SECRET', priceUsdcPerCall: '0.25', workflowType: 'read', inputSchema: PAID_ORDER_INPUT_SCHEMA, outputMapping: { nodeId: 'webhook', fields: ['response'] }, outputSchema: orderOutput },
  { slug: 'basis-order-t4', name: 'basis-order-t4', description: 'Accept a signed Basis $1.00-tier quote for asynchronous execution.', endpointPath: '/orders', credentialEnv: 'BASIS_ORDER_T4_SECRET', priceUsdcPerCall: '1.00', workflowType: 'read', inputSchema: PAID_ORDER_INPUT_SCHEMA, outputMapping: { nodeId: 'webhook', fields: ['response'] }, outputSchema: orderOutput },
  { slug: 'basis-status', name: 'basis-status', description: 'Return public Basis order state and independent verification proof.', endpointPath: '/orders/{{@trigger:Trigger.orderId}}', priceUsdcPerCall: '0', workflowType: 'read', inputSchema: statusInput, outputMapping: { nodeId: 'webhook', fields: ['response'] }, outputSchema: { type: 'object', properties: { orderId: { type: 'string' }, state: { type: 'string' }, execution: { type: ['object', 'null'] }, verification: { type: ['object', 'null'] } } } },
] as const;

function payloadFor(slug: BasisWorkflowSlug): string | undefined {
  if (slug === 'basis-quote') return '{"jobType":"{{@trigger:Trigger.jobType}}","params":{{@trigger:Trigger.params}},"chainId":{{@trigger:Trigger.chainId}},"deadlineTier":"{{@trigger:Trigger.deadlineTier}}","refundRecipient":"{{@trigger:Trigger.refundRecipient}}"}';
  if (slug.startsWith('basis-order-')) return '{"quoteId":"{{@trigger:Trigger.quoteId}}"}';
  return undefined;
}

export function buildKeeperHubWorkflow(definition: BasisMarketplaceWorkflow, publicBaseUrl: string, secret?: string) {
  const webhookUrl = `${publicBaseUrl.replace(/\/$/, '')}${definition.endpointPath}`;
  const headers = definition.credentialEnv
    ? JSON.stringify({ Authorization: `Bearer ${secret ?? ''}`, 'Content-Type': 'application/json' })
    : JSON.stringify({ 'Content-Type': 'application/json' });
  return {
    name: definition.name,
    description: definition.description,
    enabled: true,
    visibility: 'private',
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', description: '', type: 'trigger', config: { triggerType: 'Manual' }, status: 'idle' } },
      { id: 'webhook', type: 'action', position: { x: 272, y: 0 }, data: { label: 'Basis API', description: '', type: 'action', config: { actionType: 'webhook/send-webhook', webhookUrl, webhookMethod: definition.slug === 'basis-status' ? 'GET' : 'POST', webhookHeaders: headers, ...(payloadFor(definition.slug) ? { webhookPayload: payloadFor(definition.slug) } : {}) }, status: 'idle' } },
    ],
    edges: [{ id: 'trigger-webhook', source: 'trigger', target: 'webhook', type: 'animated' }],
    inputSchema: definition.inputSchema,
    outputMapping: definition.outputMapping,
    priceUsdcPerCall: definition.priceUsdcPerCall,
    workflowType: definition.workflowType,
  };
}

export function validateBasisWorkflowDefinitions(): void {
  if (BASIS_MARKETPLACE_WORKFLOWS.length !== 6) throw new Error('Exactly six Basis storefront workflows are required');
  for (const definition of BASIS_MARKETPLACE_WORKFLOWS) {
    const graph = buildKeeperHubWorkflow(definition, 'https://basis.invalid', definition.credentialEnv ? 'x'.repeat(32) : undefined);
    const serialized = JSON.stringify(graph);
    if (definition.workflowType !== 'read') throw new Error(`${definition.slug} must be read-type`);
    if (/write-contract|protocol-write/i.test(serialized)) throw new Error(`${definition.slug} contains a prohibited write node`);
    const webhookConfig = graph.nodes[1]!.data.config as Record<string, unknown>;
    if (graph.nodes.length !== 2 || webhookConfig.actionType !== 'webhook/send-webhook') throw new Error(`${definition.slug} is not a thin webhook wrapper`);
    if (definition.slug.startsWith('basis-order-') && JSON.stringify(definition.inputSchema) !== JSON.stringify(PAID_ORDER_INPUT_SCHEMA)) throw new Error(`${definition.slug} paid schema drifted`);
  }
}
