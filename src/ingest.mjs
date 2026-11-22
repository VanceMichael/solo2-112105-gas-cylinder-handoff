// 收件：从交接站与净化中心的分页接口领取流水，按凭据 id 落账。
// 三种情况分开记账：
//   暂缺页 —— 登记缺页，其他来源继续领取；补到的页可解除缺件；
//   再次送到的同一凭据 —— 幂等去重，不重复计入；
//   明确冲销 —— 由净化账上的 reversal 记录表达，被冲销工序永不重新计入。
// 同一 id 再次送到但内容不一致时保留先到版本并登记冲突。
import { createHash } from 'node:crypto';
import { reevaluate } from './ledger.mjs';

const TIMEOUT = 8000;

const stable = value => JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
    : v);

export async function receive(state, { origin, fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  const run = { at: now, newRows: 0, duplicates: 0, conflicts: 0, labs: 0, originals: 0, gapsOpened: [], gapsResolved: [] };
  await walkFeed(state, 'stations', '/stations/transfers', 'transfers', run, { origin, fetchImpl, now });
  await walkFeed(state, 'plant', '/plant/ledger', 'plant', run, { origin, fetchImpl, now });
  await fetchLabs(state, run, { origin, fetchImpl, now });
  await fetchOriginals(state, run, { origin, fetchImpl, now });
  reevaluate(state, now);
  state.runs.push(run);
  return run;
}

function openGap(state, feed, cursor, error, now, run) {
  const gaps = state.feeds[feed].gaps;
  const existing = gaps.find(g => g.cursor === cursor && g.status === 'open');
  if (existing) {
    existing.error = error;
    existing.lastAt = now;
    return;
  }
  const gap = { feed, cursor, error, since: now, status: 'open' };
  gaps.push(gap);
  run.gapsOpened.push(gap);
}

function closeGap(state, feed, cursor, now, run) {
  for (const g of state.feeds[feed].gaps) {
    if (g.cursor === cursor && g.status === 'open') {
      g.status = 'resolved';
      g.resolvedAt = now;
      run.gapsResolved.push(g);
    }
  }
}

async function walkFeed(state, feedName, firstPath, storeKey, run, ctx) {
  const feed = state.feeds[feedName];
  const seenThisRun = new Set();
  const visited = new Set();
  let cursor = null;
  for (;;) {
    const path = cursor == null ? firstPath : `${firstPath}?cursor=${encodeURIComponent(cursor)}`;
    let res;
    try {
      res = await ctx.fetchImpl(ctx.origin + path, { signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      openGap(state, feedName, cursor, `网络错误：${err.message}`, ctx.now, run);
      break;
    }
    if (!res.ok) {
      openGap(state, feedName, cursor, `HTTP ${res.status}`, ctx.now, run);
      break;
    }
    closeGap(state, feedName, cursor, ctx.now, run);
    let body;
    try {
      body = await res.json();
    } catch {
      openGap(state, feedName, cursor, '响应不是 JSON', ctx.now, run);
      break;
    }
    for (const row of body.rows ?? []) applyRow(state, storeKey, row, seenThisRun, run, ctx.now);
    const next = body.next ?? null;
    if (next == null) {
      feed.done = true;
      feed.completedAt = ctx.now;
      break;
    }
    if (visited.has(next)) {
      state.conflicts.push({ at: ctx.now, type: 'cursor-loop', detail: `来源 ${feedName} 翻页游标 ${next} 成环` });
      run.conflicts += 1;
      break;
    }
    visited.add(next);
    cursor = next;
  }
}

function applyRow(state, storeKey, row, seenThisRun, run, now) {
  if (!row || row.id == null) {
    state.conflicts.push({ at: now, type: 'row-without-id', detail: `来源 ${storeKey} 收到没有 id 的记录` });
    run.conflicts += 1;
    return;
  }
  const againThisRun = seenThisRun.has(row.id);
  seenThisRun.add(row.id);
  const store = state.credentials[storeKey];
  const prev = store[row.id];
  if (!prev) {
    store[row.id] = row;
    run.newRows += 1;
    return;
  }
  if (stable(prev) === stable(row)) {
    const d = (state.duplicates[row.id] ??= { kind: storeKey, count: 0, firstAt: now });
    d.count += 1;
    d.lastAt = now;
    if (againThisRun) run.duplicates += 1; // 同一次领取中再次送到的同一凭据
    return;
  }
  state.conflicts.push({ at: now, type: 'redelivery-mismatch', id: row.id, detail: `凭据 ${row.id} 再次送到时内容不一致，保留先到版本`, kept: prev, incoming: row });
  run.conflicts += 1;
}

function collectFills(state) {
  const fills = new Set(Object.keys(state.credentials.labs));
  for (const row of Object.values(state.credentials.plant)) {
    if (row.type === 'fill') fills.add(row.id);
    if (row.type === 'correction') fills.add(row.id);
    for (const o of row.outputs ?? []) if (o.fill) fills.add(o.fill);
    for (const mv of row.moves ?? []) if (mv.fill) fills.add(mv.fill);
  }
  for (const o of Object.values(state.orders)) fills.add(o.fill);
  return [...fills];
}

async function fetchLabs(state, run, ctx) {
  for (const fill of collectFills(state)) {
    let res;
    try {
      res = await ctx.fetchImpl(`${ctx.origin}/lab/fills/${encodeURIComponent(fill)}`, { signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      openGap(state, 'lab', fill, `网络错误：${err.message}`, ctx.now, run);
      continue;
    }
    if (res.status === 404) {
      state.credentials.labs[fill] = { missing: true, fetchedAt: ctx.now };
      closeGap(state, 'lab', fill, ctx.now, run);
      continue;
    }
    if (!res.ok) {
      openGap(state, 'lab', fill, `HTTP ${res.status}`, ctx.now, run);
      continue;
    }
    closeGap(state, 'lab', fill, ctx.now, run);
    state.credentials.labs[fill] = { ...(await res.json()), fetchedAt: ctx.now };
    run.labs += 1;
  }
}

async function fetchOriginals(state, run, ctx) {
  for (const cat of Object.values(state.credentials.labs)) {
    for (const rep of cat.reports ?? []) {
      if (!rep.file || !rep.sha256) continue;
      const prev = state.credentials.originals[rep.file];
      if (prev?.ok && prev.sha256 === rep.sha256) continue;
      try {
        const res = await ctx.fetchImpl(ctx.origin + rep.file, { signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok) {
          state.credentials.originals[rep.file] = { ok: false, sha256: rep.sha256, error: `HTTP ${res.status}`, fetchedAt: ctx.now };
          continue;
        }
        const digest = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
        state.credentials.originals[rep.file] = { ok: digest === rep.sha256, sha256: rep.sha256, actual: digest, fetchedAt: ctx.now };
        run.originals += 1;
      } catch (err) {
        state.credentials.originals[rep.file] = { ok: false, sha256: rep.sha256, error: String(err.message ?? err), fetchedAt: ctx.now };
      }
    }
  }
}
