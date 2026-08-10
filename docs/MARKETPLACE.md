# KeeperHub Marketplace storefront

## Architecture

Basis uses six thin KeeperHub read-workflow storefronts and one stateful Basis backend:

| Slug | Price per call | Input | Basis endpoint |
|---|---:|---|---|
| `basis-quote` | Free | supported structured job fields plus `refundRecipient` | `POST /quote` |
| `basis-order-t1` | $0.01 | `quoteId` only | `POST /orders` |
| `basis-order-t2` | $0.05 | `quoteId` only | `POST /orders` |
| `basis-order-t3` | $0.25 | `quoteId` only | `POST /orders` |
| `basis-order-t4` | $1.00 | `quoteId` only | `POST /orders` |
| `basis-status` | Free | `orderId` only | `GET /orders/:id` |

Each graph is Manual trigger → `webhook/send-webhook` → output mapping. No graph contains `write-contract`, protocol-write, arbitrary transaction input, or Basis business logic. Actual transactions continue through KeeperHub Direct Execution from the Basis server. Marketplace write workflows are deliberately not used because the current call route returns unsigned calldata to the buyer instead of executing with the seller wallet.

## Confirmed payment behavior (KeeperHub staging source, 2026-08-10)

Paid calls offer x402 with USDC on Base and MPP with USDC.e on Tempo. KeeperHub internally creates `PaymentMeta` containing protocol, chain, and payer address when recoverable. Its `workflow_payments` record also contains amount, KeeperHub workflow execution ID, creator wallet, and a hash of the payment signature/credential. That hash is not an onchain transaction hash.

The call route invokes the workflow with `triggerInput: body`. It does not add `PaymentMeta`, payment hash, receipt, transaction hash, listing slug, or Marketplace execution ID to trigger input. Therefore none can be included in the Basis Webhook payload. No authenticated seller endpoint for payment lookup by workflow execution ID exists; the earnings endpoint is aggregate reporting. Basis never accepts a caller-supplied `paymentTxHash` as proof.

The paid route can distinguish paid calls from owner/manual runs internally, but does not expose that distinction to nodes. Tier-specific callback credentials identify which wrapper called Basis, not the payer. `refundRecipient` is consequently supplied by the quote requester, normalized, and cryptographically bound into the quote under the fixed Base-USDC v1 policy; it may differ from the hidden Marketplace payer.

Webhook actions return `{ success, statusCode, response }`, and listing `outputMapping` can expose the parsed response. Read calls wait for completion for about 25 seconds, then return `{ executionId, status: "running" }`; Basis order wrappers return acceptance quickly and execution continues asynchronously.

## Provisioning and publication

`npm run marketplace:provision` validates definitions, lists existing workflows, and prints a dry-run. It does not mutate or publish. Add `--apply` to create/update private workflows and validate each against KeeperHub. Add `--publish` only with explicit approval; it implies apply, makes the workflow public, and creates the listing. The tool preserves existing permanent slugs, refuses unsafe listed-price changes, reports real IDs only, and stops with KeeperHub's exact error response.

KeeperHub uses `priceUsdcPerCall`; listing metadata includes slug, input schema, output mapping, and `workflowType: "read"`. A published slug is permanent.

## MCP calling limitation

The direct REST endpoint `POST /api/mcp/workflows/<slug>/call` and aggregate MCP `call_workflow(slug, inputs)` pass the listing body. Current dedicated per-workflow MCP tools derive a Manual-trigger schema that accepts only an optional `type: "manual"` and silently drops extra fields. Until a live test proves otherwise, do not use `/mcp/w/<slug>` for Basis inputs. Test both aggregate MCP and direct REST after private provisioning and before publication.
