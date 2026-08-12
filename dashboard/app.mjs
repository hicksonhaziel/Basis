import { verifyAuditEvents } from '/audit-chain.mjs';

const $ = (id) => document.getElementById(id);

function text(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value);
}

function showUnavailable(id, message = 'Not included in redacted package') {
  const element = $(id);
  element.replaceChildren();
  const label = document.createElement('span');
  label.className = 'unavailable';
  label.textContent = message;
  element.append(label);
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

async function loadAuditEvents() {
  const response = await fetch('/evidence.jsonl');
  if (!response.ok) throw new Error(`audit evidence returned HTTP ${response.status}`);
  const body = await response.text();
  return body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function renderStatuses(environment) {
  const values = [environment.networkClass, environment.workflowVisibility, environment.paymentStatus, environment.refundStatus, environment.publicationStatus];
  const rail = $('status-rail');
  rail.replaceChildren(...values.map((value, index) => {
    const badge = document.createElement('span');
    badge.className = `badge ${index === 0 ? 'info' : 'warn'}`;
    badge.textContent = String(value);
    return badge;
  }));
}

function safeExplorerUrl(rawUrl, transactionHash) {
  if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'sepolia.basescan.org' || url.pathname.toLowerCase() !== `/tx/${transactionHash.toLowerCase()}`) return null;
    return url.href;
  } catch { return null; }
}

function renderEvidence(evidence) {
  const { environment, proof, publicChain, keeperHubReported, basisLocal, trustBoundary } = evidence;
  renderStatuses(environment);
  text('proof-status', proof.status);
  text('proof-disclosure', proof.disclosure);
  text('trust-public', trustBoundary.publicChain);
  text('trust-keeper', trustBoundary.keeperHub);
  text('trust-basis', trustBoundary.basis);
  text('network', `${environment.network} · chain ${environment.chainId}`);
  text('morpho-address', publicChain.morphoAddress);
  text('market-id', publicChain.marketId);
  text('selector', publicChain.functionSelector);
  text('event-topic', publicChain.accrueInterestTopic0);
  text('morpho-hash', publicChain.morphoRuntimeCodeHash);
  text('irm-hash', publicChain.irmRuntimeCodeHash);

  const transactionHash = typeof publicChain.transactionHash === 'string' ? publicChain.transactionHash : '';
  const explorerUrl = safeExplorerUrl(publicChain.explorerUrl, transactionHash);
  if (explorerUrl) {
    const link = document.createElement('a');
    link.href = explorerUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = transactionHash;
    $('transaction').replaceChildren(link);
  } else showUnavailable('transaction');

  if (publicChain.blockNumber && publicChain.blockTimestamp) text('block-time', `${publicChain.blockNumber} · ${publicChain.blockTimestamp}`);
  else showUnavailable('block-time');
  if (publicChain.event) text('event-proof', `interest ${publicChain.event.interest}; fee shares ${publicChain.event.feeShares}`);
  else showUnavailable('event-proof');
  if (publicChain.historicalStateProof) text('historical-proof', publicChain.historicalStateProof);
  else showUnavailable('historical-proof');
  if (keeperHubReported.executionId) text('keeperhub-id', `${keeperHubReported.executionId} · KeeperHub-reported`);
  else showUnavailable('keeperhub-id');

  const ids = [basisLocal.quoteId, basisLocal.orderId, basisLocal.executionId].filter((value) => typeof value === 'string' && value.length > 0);
  if (ids.length) {
    const nodes = [];
    ids.forEach((id, index) => {
      if (index > 0) nodes.push(document.createElement('br'));
      nodes.push(document.createTextNode(id));
    });
    $('basis-ids').replaceChildren(...nodes);
  } else showUnavailable('basis-ids');
}

function renderBacktest(report) {
  text('backtest-class', report.classification);
  text('backtest-source', `${report.provenance} · ${report.chain} · ${report.blocks} tested blocks`);
  const rows = Object.entries(report.tiers).map(([tier, values]) => {
    const row = document.createElement('tr');
    const cells = [tier, `${values.coverage.toFixed(1)}%`, values.underpriceCount, `${values.overpriceP50.toFixed(1)}%`, `${values.overpriceP95.toFixed(1)}%`];
    row.replaceChildren(...cells.map((value) => {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      return cell;
    }));
    return row;
  });
  $('backtest-body').replaceChildren(...rows);
}

async function renderApiState() {
  try {
    const [health, metrics] = await Promise.all([fetchJson('/health'), fetchJson('/metrics')]);
    text('api-state', health.status === 'ok' ? 'API ONLINE' : 'API DEGRADED');
    text('api-detail', `${metrics.executions.total} executions · ${metrics.auditChain.length} live audit events`);
  } catch (error) {
    text('api-state', 'STATIC EVIDENCE MODE');
    text('api-detail', error instanceof Error ? error.message : String(error));
  }
}

let auditEvents = [];
async function verifyAudit(tamper = false) {
  const events = structuredClone(auditEvents);
  if (tamper && events[0]) events[0].payload = { ...events[0].payload, simulatedTamper: true };
  if (!events.length) {
    text('audit-result', 'No audit events loaded');
    text('audit-detail', 'The committed benchmark ledger could not be loaded.');
    return;
  }
  const result = await verifyAuditEvents(events);
  if (result.valid) {
    text('audit-result', `VALID · ${events.length} events recomputed`);
    text('audit-detail', `Sequence, predecessor links and SHA-256 hashes match. Last hash ${events.at(-1).hash.slice(0, 20)}…`);
    $('audit-result').style.color = 'var(--green)';
  } else {
    text('audit-result', `${tamper ? 'TAMPER DETECTED' : 'CHAIN INVALID'} · event ${result.brokenAt ?? 'unknown'}`);
    text('audit-detail', result.error ?? 'Hash verification failed.');
    $('audit-result').style.color = 'var(--red)';
  }
}

async function start() {
  const results = await Promise.allSettled([fetchJson('/phase7-evidence.json'), fetchJson('/backtest-report.json'), loadAuditEvents(), renderApiState()]);
  if (results[0].status === 'fulfilled') renderEvidence(results[0].value);
  else {
    text('proof-status', 'EVIDENCE UNAVAILABLE');
    text('proof-disclosure', results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason));
  }
  if (results[1].status === 'fulfilled') renderBacktest(results[1].value);
  else {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'unavailable';
    cell.textContent = 'Backtest unavailable';
    row.append(cell);
    $('backtest-body').replaceChildren(row);
  }
  if (results[2].status === 'fulfilled') {
    auditEvents = results[2].value;
    text('audit-detail', `${auditEvents.length} committed benchmark events loaded; verification has not been run.`);
  }
}

$('verify-button').addEventListener('click', () => void verifyAudit(false));
$('tamper-button').addEventListener('click', () => void verifyAudit(true));
void start();
