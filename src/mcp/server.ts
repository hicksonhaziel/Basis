import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { BASIS_MARKETPLACE_WORKFLOWS } from '../marketplace/workflows.ts';

const DEFAULT_BASE_URL = 'https://outstanding-motivation-production-c0ff.up.railway.app';
const baseUrl = new URL(process.env.BASIS_PUBLIC_BASE_URL ?? DEFAULT_BASE_URL);
if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost' && baseUrl.hostname !== '127.0.0.1') {
  throw new Error('BASIS_PUBLIC_BASE_URL must use HTTPS outside localhost');
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`Basis API ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
}

export function createBasisMcpServer(): McpServer {
  const server = new McpServer({ name: 'basis', version: '0.1.0' });

  server.registerTool('basis_quote', {
    title: 'Request Basis execution quote',
    description: 'Create a deterministic signed quote. This records a quote but never submits a transaction or asserts payment.',
    inputSchema: {
      jobType: z.enum(['weth.wrap', 'weth.unwrap', 'erc20.transfer', 'morpho.accrue_interest']),
      params: z.record(z.string(), z.unknown()),
      chainId: z.number().int().positive(),
      deadlineTier: z.enum(['next-block', '5m', '1h', 'best-effort']),
      refundRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    try { return result(await request('/quote', { method: 'POST', body: JSON.stringify(input) })); }
    catch (error) { return failure(error); }
  });

  server.registerTool('basis_status', {
    title: 'Read Basis order status',
    description: 'Read order, execution, independent verification and refund state from the public Basis API.',
    inputSchema: { orderId: z.string().min(1).max(200) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ orderId }) => {
    try { return result(await request(`/orders/${encodeURIComponent(orderId)}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool('basis_evidence', {
    title: 'Read Basis public evidence',
    description: 'Read the redacted public evidence package and its explicit testnet/payment/publication labels.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try { return result(await request('/phase7-evidence.json')); }
    catch (error) { return failure(error); }
  });

  server.registerTool('basis_marketplace_catalog', {
    title: 'List Basis Marketplace tools',
    description: 'List the six KeeperHub-hosted workflow tools and prices. Paid orders must use these Marketplace tools; this MCP server never bypasses payment authority.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => result({
    operatorApi: baseUrl.origin,
    executionBoundary: 'Paid execution is available only through KeeperHub Marketplace workflow tools.',
    workflows: BASIS_MARKETPLACE_WORKFLOWS.map(({ slug, name, description, priceUsdcPerCall, workflowType, inputSchema }) => ({ slug, name, description, priceUsdcPerCall, workflowType, inputSchema })),
  }));

  return server;
}

async function main(): Promise<void> {
  const server = createBasisMcpServer();
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
