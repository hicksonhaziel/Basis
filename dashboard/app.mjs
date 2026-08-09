import { verifyAuditEvents } from './audit-chain.mjs';

/**
 * Basis Dashboard — app.mjs
 * Loads evidence data (JSONL audit chain) and populates the open book.
 * Falls back to committed evidence when no live server is available.
 */

// Try live API first, fallback to static evidence
async function loadData() {
  try {
    const res = await fetch('/metrics');
    if (res.ok) return { source: 'live', metrics: await res.json() };
  } catch {}

  // Fallback: load committed evidence JSONL
  try {
    const res = await fetch('./evidence.jsonl');
    if (res.ok) {
      const text = await res.text();
      return { source: 'static', events: parseJsonl(text) };
    }
  } catch {}

  return { source: 'empty', events: [] };
}

function parseJsonl(text) {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// Compute metrics from audit events
function computeMetrics(events) {
  const quotes = events.filter(e => e.type === 'QUOTE_ISSUED');
  const orders = events.filter(e => e.type === 'ORDER_CREATED');
  const settled = events.filter(e => e.type === 'EXECUTION_VERIFIED');
  const failed = events.filter(e => e.type === 'EXECUTION_FAILED');

  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.payload.priceUsd || '0.01'), 0);
  const totalExec = settled.length + failed.length;
  const deadlineHits = settled.filter(e => e.payload.deadlineHit !== false).length;

  return {
    revenue: totalRevenue,
    totalExec,
    settled: settled.length,
    failed: failed.length,
    deadlineHits,
    hitRate: totalExec > 0 ? (deadlineHits / totalExec * 100) : 0,
    successRate: totalExec > 0 ? (settled.length / totalExec * 100) : 0,
    chainLength: events.length,
    lastHash: events.length > 0 ? events[events.length - 1].hash : '0'.repeat(64),
    orders,
    settled,
  };
}

// Build execution tape rows
function buildTape(events) {
  const orders = events.filter(e => e.type === 'ORDER_CREATED');
  const executions = events.filter(e => e.type === 'EXECUTION_VERIFIED' || e.type === 'EXECUTION_FAILED');

  return orders.map((order, i) => {
    const exec = executions[i];
    const isSuccess = exec?.type === 'EXECUTION_VERIFIED';
    return {
      orderId: order.entityId?.slice(0, 12) + '...',
      jobType: order.payload.jobType || 'weth.*',
      tier: order.payload.deadlineTier || '—',
      price: '$' + (order.payload.priceUsd || '0.01'),
      status: isSuccess ? 'SETTLED' : (exec ? 'FAILED' : 'PENDING'),
      tx: exec?.payload?.transactionHash?.slice(0, 14) + '...' || '—',
      gas: exec?.payload?.gasUsedWei || '—',
    };
  });
}

// Verify the hash chain integrity
async function verifyChain() {
  const el = document.getElementById('verify-result');
  if (!window._events || window._events.length === 0) {
    el.innerHTML = '<span class="yellow">No events loaded</span>';
    return;
  }

  const result = await verifyAuditEvents(window._events);
  if (!result.valid) {
    el.innerHTML = `<span class="red">✗ Chain broken at seq ${result.brokenAt}: ${result.error}</span>`;
    return;
  }
  el.innerHTML = `<span class="green">✓ Chain valid — ${window._events.length} events, hashes recomputed</span>`;
}
window.verifyChain = verifyChain;

// Render
async function render() {
  const data = await loadData();

  let metrics, tape;

  if (data.source === 'live') {
    document.getElementById('revenue').textContent = '$' + (data.metrics.orders.total * 0.01).toFixed(2);
    document.getElementById('total-exec').textContent = data.metrics.executions.total;
    document.getElementById('success-rate').textContent = data.metrics.executions.total > 0
      ? Math.round(data.metrics.executions.completed / data.metrics.executions.total * 100) + '%' : '—';
    document.getElementById('chain-length').textContent = data.metrics.auditChain.length;
    document.getElementById('last-hash').textContent = data.metrics.auditChain.lastHash.slice(0, 16) + '...';
    return;
  }

  const events = data.events || [];
  window._events = events;
  metrics = computeMetrics(events);
  tape = buildTape(events);

  // Populate cards
  document.getElementById('revenue').textContent = '$' + metrics.revenue.toFixed(2);
  document.getElementById('gas-cost').textContent = '$0.00';
  document.getElementById('realized-cost').textContent = '$0.00';
  document.getElementById('margin').textContent = '100%';
  document.getElementById('total-exec').textContent = metrics.totalExec;
  document.getElementById('hit-rate').textContent = metrics.hitRate.toFixed(0) + '%';
  document.getElementById('success-rate').textContent = metrics.successRate.toFixed(0) + '%';
  document.getElementById('refunds').textContent = '0';
  document.getElementById('chain-length').textContent = metrics.chainLength;
  document.getElementById('last-hash').textContent = metrics.lastHash.slice(0, 20) + '...';

  // Populate tape
  const tbody = document.getElementById('tape-body');
  tbody.innerHTML = tape.slice(0, 30).map(row => `
    <tr>
      <td>${row.orderId}</td>
      <td>${row.jobType}</td>
      <td>${row.tier}</td>
      <td>${row.price}</td>
      <td><span class="tag tag-${row.status.toLowerCase()}">${row.status}</span></td>
      <td><code style="font-size:0.7rem">${row.tx}</code></td>
      <td>${row.gas}</td>
    </tr>
  `).join('');
}

render();
