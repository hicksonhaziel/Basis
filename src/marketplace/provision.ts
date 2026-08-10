import { createHash } from 'node:crypto';
import { BASIS_MARKETPLACE_WORKFLOWS, buildKeeperHubWorkflow, validateBasisWorkflowDefinitions } from './workflows.ts';

type ExistingWorkflow = { id: string; name: string; isListed?: boolean; listedSlug?: string | null; priceUsdcPerCall?: string | null };

const args = new Set(process.argv.slice(2));
const publish = args.has('--publish');
const apply = args.has('--apply') || publish;
const baseUrl = (process.env.KEEPERHUB_BASE_URL ?? 'https://app.keeperhub.com').replace(/\/$/, '');
const apiKey = process.env.KEEPERHUB_API_KEY;
const publicBaseUrl = process.env.BASIS_PUBLIC_BASE_URL;

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!apiKey) throw new Error('KEEPERHUB_API_KEY is required');
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`KeeperHub ${init.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  return body;
}

function secretFor(definition: (typeof BASIS_MARKETPLACE_WORKFLOWS)[number]): string | undefined {
  if (!definition.credentialEnv) return undefined;
  const secret = process.env[definition.credentialEnv];
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error(`${definition.credentialEnv} must contain at least 32 bytes`);
  return secret;
}

async function main(): Promise<void> {
  validateBasisWorkflowDefinitions();
  if (apply && !publicBaseUrl) throw new Error('BASIS_PUBLIC_BASE_URL is required for --apply or --publish');
  const effectivePublicBaseUrl = publicBaseUrl ?? 'https://basis.invalid';
  const inventory = apiKey ? await api('/api/workflows') : [];
  if (!Array.isArray(inventory)) throw new Error('KeeperHub workflow inventory response was not an array');
  const existing = new Map((inventory as ExistingWorkflow[]).map((workflow) => [workflow.name, workflow]));
  const report: Array<Record<string, unknown>> = [];

  for (const definition of BASIS_MARKETPLACE_WORKFLOWS) {
    const found = existing.get(definition.name);
    const action = found ? 'update' : 'create';
    if (!apply) {
      report.push({ slug: definition.slug, workflowId: found?.id ?? null, action, publish: false, priceUsdcPerCall: definition.priceUsdcPerCall, workflowType: 'read', valid: true });
      continue;
    }

    const graph = buildKeeperHubWorkflow(definition, effectivePublicBaseUrl, secretFor(definition));
    let workflow = found;
    if (!workflow) {
      const created = await api('/api/workflows/create', {
        method: 'POST',
        headers: { 'Idempotency-Key': createHash('sha256').update(`basis-storefront:${definition.slug}`).digest('hex') },
        body: JSON.stringify(graph),
      }) as ExistingWorkflow;
      if (!created?.id) throw new Error(`KeeperHub did not return an ID for ${definition.slug}`);
      workflow = created;
    } else {
      if (workflow.isListed && workflow.listedSlug && workflow.listedSlug !== definition.slug) {
        throw new Error(`${definition.slug} already has permanent slug ${workflow.listedSlug}; refusing to replace it`);
      }
      if (workflow.isListed && workflow.priceUsdcPerCall !== definition.priceUsdcPerCall) {
        throw new Error(`${definition.slug} is listed at ${workflow.priceUsdcPerCall}; unlist explicitly before changing to ${definition.priceUsdcPerCall}`);
      }
      await api(`/api/workflows/${workflow.id}`, { method: 'PATCH', body: JSON.stringify(graph) });
    }

    const validation = await api(`/api/workflows/${workflow.id}/validate?deepCheck=true`) as Record<string, unknown>;
    const validationResult = (validation.result ?? validation) as Record<string, unknown>;
    if (validationResult.valid === false || validation.ok === false) throw new Error(`${definition.slug} validation failed: ${JSON.stringify(validation)}`);

    if (publish && !workflow.isListed) {
      await api(`/api/workflows/${workflow.id}/go-live`, { method: 'PUT', body: JSON.stringify({ name: definition.name, mode: 'public' }) });
      await api(`/api/mcp/workflows/${workflow.id}/listing`, {
        method: 'POST',
        body: JSON.stringify({ slug: definition.slug, category: 'developer-tools', chain: 'multi-chain', inputSchema: definition.inputSchema, outputMapping: definition.outputMapping, workflowType: 'read', shareExecutionStatus: false }),
      });
    }
    report.push({ slug: definition.slug, workflowId: workflow.id, action, publish, priceUsdcPerCall: definition.priceUsdcPerCall, workflowType: 'read', validation: validationResult });
  }

  console.log(JSON.stringify({ dryRun: !apply, publish, workflows: report }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
