import { verifyAuditEvents } from '/audit-chain.mjs';

const $ = (id) => document.getElementById(id);
const BASE_SEPOLIA_EXPLORER = 'https://sepolia.basescan.org';

function text(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value);
}

function showUnavailable(id, message = 'Not included in redacted package') {
  const element = $(id);
  if (!element) return;
  const label = document.createElement('span');
  label.className = 'unavailable';
  label.textContent = message;
  element.replaceChildren(label);
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

function safeExplorerUrl(transactionHash) {
  if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) return null;
  return `${BASE_SEPOLIA_EXPLORER}/tx/${transactionHash.toLowerCase()}`;
}

function externalIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M7 17 17 7M7 7h10v10');
  svg.append(path);
  return svg;
}

function jobIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5');
  svg.append(path);
  return svg;
}

function renderStatuses(environment) {
  const states = [
    [environment.networkClass, 'info'],
    [environment.workflowVisibility, 'good'],
    [environment.paymentStatus, 'warn'],
    [environment.refundStatus, 'warn'],
    [environment.publicationStatus, 'good'],
  ];
  const rail = $('status-rail');
  rail.replaceChildren(...states.map(([value, tone]) => {
    const badge = document.createElement('span');
    badge.className = `badge ${tone}`;
    badge.textContent = String(value);
    return badge;
  }));
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
  const explorerUrl = safeExplorerUrl(transactionHash);
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
  if (ids.length) $('basis-ids').replaceChildren(...ids.flatMap((id, index) => index ? [document.createElement('br'), document.createTextNode(id)] : [document.createTextNode(id)]));
  else showUnavailable('basis-ids');
}

function deriveExecutions(events) {
  const quotes = new Map();
  const starts = new Map();
  const executions = [];

  for (const event of events) {
    if (event.type === 'QUOTE_ISSUED') quotes.set(event.entityId, { ...event.payload, timestamp: event.timestamp });
    if (event.type === 'EXECUTION_STARTED') starts.set(event.entityId, { ...event.payload, timestamp: event.timestamp });
    if (event.type === 'EXECUTION_VERIFIED') {
      const start = starts.get(event.entityId) ?? {};
      const quote = quotes.get(start.quoteId) ?? {};
      executions.push({
        executionId: event.entityId,
        timestamp: event.timestamp,
        jobType: quote.jobType ?? 'keeper.execution',
        deadlineTier: quote.deadlineTier ?? 'policy-bound',
        chainId: start.chainId ?? 84532,
        ...event.payload,
      });
    }
  }
  return executions;
}

function formatTimestamp(raw) {
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function renderExecutions(events) {
  const executions = deriveExecutions(events);
  const deadlineHits = executions.filter((item) => item.deadlineHit).length;
  const deadlineRate = executions.length ? `${((deadlineHits / executions.length) * 100).toFixed(0)}%` : '—';
  text('benchmark-executions', executions.length);
  text('execution-total', executions.length);
  text('deadline-rate', deadlineRate);
  text('side-deadline-rate', deadlineRate);
  text('audit-count', events.length);

  const latest = executions.at(-1);
  const latestUrl = latest ? safeExplorerUrl(latest.transactionHash) : null;
  if (latestUrl) $('latest-transaction').href = latestUrl;

  const rows = executions.slice(-6).reverse().map((execution) => {
    const row = document.createElement('tr');

    const jobCell = document.createElement('td');
    const jobWrap = document.createElement('div');
    jobWrap.className = 'job-cell';
    const icon = document.createElement('span');
    icon.className = 'job-dot';
    icon.append(jobIcon());
    const jobText = document.createElement('span');
    const jobName = document.createElement('span');
    jobName.className = 'job-name';
    jobName.textContent = execution.jobType.replace('.', ' ');
    const jobTier = document.createElement('span');
    jobTier.className = 'job-tier';
    jobTier.textContent = execution.deadlineTier;
    jobText.append(jobName, jobTier);
    jobWrap.append(icon, jobText);
    jobCell.append(jobWrap);

    const transactionCell = document.createElement('td');
    const url = safeExplorerUrl(execution.transactionHash);
    if (url) {
      const link = document.createElement('a');
      link.className = 'tx-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.append(document.createTextNode(`${execution.transactionHash.slice(0, 8)}…${execution.transactionHash.slice(-6)}`), externalIcon());
      transactionCell.append(link);
    } else transactionCell.textContent = 'Unavailable';

    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = 'success';
    status.textContent = 'Verified';
    statusCell.append(status);

    const gasCell = document.createElement('td');
    gasCell.className = 'cell-muted';
    gasCell.textContent = `${Number(execution.gasUsedWei).toLocaleString()} units`;

    const timeCell = document.createElement('td');
    timeCell.className = 'cell-muted';
    timeCell.textContent = formatTimestamp(execution.timestamp);

    row.append(jobCell, transactionCell, statusCell, gasCell, timeCell);
    return row;
  });
  $('execution-body').replaceChildren(...rows);

  const gasValues = executions.map((item) => Number(item.gasUsedWei)).filter(Number.isFinite);
  const min = Math.min(...gasValues);
  const max = Math.max(...gasValues);
  $('execution-bars').replaceChildren(...gasValues.map((value, index) => {
    const bar = document.createElement('span');
    const normalized = max === min ? 0.7 : (value - min) / (max - min);
    bar.className = 'execution-bar';
    bar.style.height = `${34 + normalized * 66}%`;
    bar.style.animationDelay = `${index * 18}ms`;
    bar.title = `${value.toLocaleString()} gas units`;
    return bar;
  }));
}

function renderBacktest(report) {
  text('backtest-class', report.classification);
  text('backtest-source', `${report.provenance} · ${report.chain} · ${report.blocks} tested blocks`);

  const rows = [];
  const bars = [];
  for (const [tier, values] of Object.entries(report.tiers)) {
    const row = document.createElement('tr');
    const cells = [tier, `${values.coverage.toFixed(1)}%`, values.underpriceCount, `${values.overpriceP50.toFixed(1)}%`, `${values.overpriceP95.toFixed(1)}%`];
    row.replaceChildren(...cells.map((value) => {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      return cell;
    }));
    rows.push(row);

    const wrapper = document.createElement('div');
    wrapper.className = 'price-row';
    const top = document.createElement('div');
    top.className = 'price-top';
    const name = document.createElement('span');
    name.textContent = tier;
    const coverage = document.createElement('span');
    coverage.textContent = `${values.coverage.toFixed(1)}%`;
    top.append(name, coverage);
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${Math.min(100, Math.max(0, values.coverage))}%`;
    track.append(fill);
    wrapper.append(top, track);
    bars.push(wrapper);
  }
  $('backtest-body').replaceChildren(...rows);
  $('pricing-bars').replaceChildren(...bars);
}

async function renderApiState() {
  try {
    const [health, metrics] = await Promise.all([fetchJson('/health'), fetchJson('/metrics')]);
    text('api-state', health.status === 'ok' ? 'Online' : 'Degraded');
    text('api-detail', `${metrics.executions.total} live execution · ${metrics.auditChain.length} live audit events`);
  } catch (error) {
    text('api-state', 'Static mode');
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
    text('audit-result', `Valid · ${events.length} events recomputed`);
    text('audit-detail', `Sequence, predecessor links and SHA-256 hashes match. Last hash ${events.at(-1).hash.slice(0, 20)}…`);
    $('audit-result').style.color = 'var(--lime)';
  } else {
    text('audit-result', `${tamper ? 'Tamper detected' : 'Chain invalid'} · event ${result.brokenAt ?? 'unknown'}`);
    text('audit-detail', result.error ?? 'Hash verification failed.');
    $('audit-result').style.color = 'var(--red)';
  }
}

function activateMotion() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach((element) => element.classList.add('is-visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));
}

async function start() {
  activateMotion();
  const results = await Promise.allSettled([
    fetchJson('/phase7-evidence.json'),
    fetchJson('/backtest-report.json'),
    loadAuditEvents(),
    renderApiState(),
  ]);

  if (results[0].status === 'fulfilled') renderEvidence(results[0].value);
  else {
    text('proof-status', 'Evidence unavailable');
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
    renderExecutions(auditEvents);
    text('audit-detail', `${auditEvents.length} committed events loaded. Verify them locally in this browser.`);
  }
}

$('verify-button').addEventListener('click', () => void verifyAudit(false));
$('tamper-button').addEventListener('click', () => void verifyAudit(true));
void start();
