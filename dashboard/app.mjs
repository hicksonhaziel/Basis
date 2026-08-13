const $ = (id) => document.getElementById(id);
const EXPLORER = 'https://sepolia.basescan.org';

function text(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value);
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

async function loadAuditEvents() {
  const response = await fetch('/evidence.jsonl');
  if (!response.ok) throw new Error(`audit evidence returned HTTP ${response.status}`);
  return (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function explorerUrl(hash) {
  return /^0x[0-9a-f]{64}$/i.test(hash) ? `${EXPLORER}/tx/${hash.toLowerCase()}` : null;
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

function renderStatuses(environment) {
  const states = [
    [environment.networkClass, ''],
    [environment.workflowVisibility, 'good'],
    [environment.paymentStatus, 'warn'],
    [environment.refundStatus, 'warn'],
    [environment.publicationStatus, 'live'],
  ];
  $('status-rail').replaceChildren(...states.map(([value, tone]) => {
    const badge = document.createElement('span');
    badge.className = `badge ${tone}`;
    badge.textContent = String(value);
    return badge;
  }));
}

function deriveExecutions(events) {
  const quotes = new Map();
  const starts = new Map();
  const executions = [];
  for (const event of events) {
    if (event.type === 'QUOTE_ISSUED') quotes.set(event.entityId, event.payload);
    if (event.type === 'EXECUTION_STARTED') starts.set(event.entityId, event.payload);
    if (event.type !== 'EXECUTION_VERIFIED') continue;
    const start = starts.get(event.entityId) ?? {};
    const quote = quotes.get(start.quoteId) ?? {};
    executions.push({
      timestamp: event.timestamp,
      jobType: quote.jobType ?? 'keeper.execution',
      deadlineTier: quote.deadlineTier ?? 'policy-bound',
      ...event.payload,
    });
  }
  return executions;
}

function shortHash(hash) {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function utcTime(raw) {
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? '—' : date.toISOString().slice(11, 19);
}

function renderExecutions(events) {
  const executions = deriveExecutions(events);
  const hitCount = executions.filter((execution) => execution.deadlineHit).length;
  const hitRate = executions.length ? `${Math.round((hitCount / executions.length) * 100)}%` : '—';
  text('benchmark-executions', executions.length);
  text('execution-total', executions.length);
  text('deadline-rate', hitRate);
  text('side-deadline-rate', hitRate);
  text('audit-count', events.length);

  const latest = executions.at(-1);
  const latestUrl = latest ? explorerUrl(latest.transactionHash) : null;
  if (latestUrl) {
    $('latest-transaction').href = latestUrl;
    text('latest-hash', shortHash(latest.transactionHash));
  }

  const rows = executions.slice(-6).reverse().map((execution) => {
    const row = document.createElement('tr');
    const job = document.createElement('td');
    const jobName = document.createElement('span');
    jobName.className = 'job-name';
    jobName.textContent = execution.jobType.replace('.', ' ');
    const tier = document.createElement('span');
    tier.className = 'job-tier';
    tier.textContent = execution.deadlineTier;
    job.append(jobName, tier);

    const transaction = document.createElement('td');
    const url = explorerUrl(execution.transactionHash);
    if (url) {
      const link = document.createElement('a');
      link.className = 'tx-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.append(document.createTextNode(shortHash(execution.transactionHash)), externalIcon());
      transaction.append(link);
    } else transaction.textContent = 'Unavailable';

    const state = document.createElement('td');
    const verified = document.createElement('span');
    verified.className = 'verified';
    verified.textContent = 'Verified';
    state.append(verified);

    const gas = document.createElement('td');
    gas.className = 'cell-muted';
    gas.textContent = Number(execution.gasUsedWei).toLocaleString();
    const time = document.createElement('td');
    time.className = 'cell-muted';
    time.textContent = utcTime(execution.timestamp);
    row.append(job, transaction, state, gas, time);
    return row;
  });
  $('execution-body').replaceChildren(...rows);

  const gas = executions.map((execution) => Number(execution.gasUsedWei)).filter(Number.isFinite);
  const low = Math.min(...gas);
  const high = Math.max(...gas);
  $('execution-bars').replaceChildren(...gas.map((value, index) => {
    const bar = document.createElement('span');
    const ratio = high === low ? 0.7 : (value - low) / (high - low);
    bar.className = 'execution-bar';
    bar.style.height = `${32 + ratio * 64}%`;
    bar.style.animationDelay = `${index * 16}ms`;
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
    for (const value of [tier, `${values.coverage.toFixed(1)}%`, values.underpriceCount, `${values.overpriceP50.toFixed(1)}%`, `${values.overpriceP95.toFixed(1)}%`]) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    }
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
    fill.style.width = `${Math.max(0, Math.min(100, values.coverage))}%`;
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
    text('api-detail', `${metrics.executions.total} live execution / ${metrics.auditChain.length} live events`);
  } catch {
    text('api-state', 'Static mode');
    text('api-detail', 'Live operator metrics unavailable');
  }
}

function activateReveals() {
  const items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  items.forEach((item) => observer.observe(item));
}

async function start() {
  activateReveals();
  const results = await Promise.allSettled([
    fetchJson('/phase7-evidence.json'),
    fetchJson('/backtest-report.json'),
    loadAuditEvents(),
    renderApiState(),
  ]);
  if (results[0].status === 'fulfilled') renderStatuses(results[0].value.environment);
  if (results[1].status === 'fulfilled') renderBacktest(results[1].value);
  else text('backtest-source', 'Historical report unavailable');
  if (results[2].status === 'fulfilled') renderExecutions(results[2].value);
  else text('execution-body', 'Committed execution ledger unavailable');
}

void start();
