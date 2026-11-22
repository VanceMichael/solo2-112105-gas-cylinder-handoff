// 领用台账：申请、保留、停发、出库、改配、撤销。
// 同一可用量按保留先后承诺，不能同时承诺给两个班；
// 证据变化时受影响的保留立即停发，原申请显示待重配量；
// 已出库的交接按当时证据保留，不改写，只生成给仓管的跟进清单。
import { buildViews } from './view.mjs';
import { keyOf, pairOf } from './genealogy.mjs';

const reservationsOf = (state, ref) => Object.values(state.reservations).filter(r => r.ref === ref);
const handedOfOrder = (state, ref) => state.handovers.filter(h => h.ref === ref).reduce((a, h) => a + h.g, 0);

function mustOrder(state, ref) {
  const o = state.orders[ref];
  if (!o) throw new Error(`领用单 ${ref} 不存在`);
  return o;
}

export function orderView(state, ref) {
  const o = state.orders[ref];
  if (!o) return null;
  const res = reservationsOf(state, ref);
  const handedG = handedOfOrder(state, ref);
  const activeG = res.filter(r => r.status === 'active').reduce((a, r) => a + r.g - r.handedG, 0);
  const heldG = res.filter(r => r.status === 'held').reduce((a, r) => a + r.g - r.handedG, 0);
  const unallocatedG = o.status === 'open' ? Math.max(0, o.requestedG - handedG - activeG - heldG) : 0;
  return {
    ...o, handedG, activeG, heldG, unallocatedG,
    pendingReallocG: heldG + unallocatedG,
    reservations: res.sort((a, b) => a.seq - b.seq),
    handovers: state.handovers.filter(h => h.ref === ref),
  };
}

export function placeRequest(state, { ref, station, bottle, fill, g }, now) {
  if (!ref) throw new Error('缺申请号');
  if (state.orders[ref]) throw new Error(`领用单 ${ref} 已存在`);
  if (!Number.isInteger(g) || g <= 0) throw new Error('数量须为正整数克');
  state.orders[ref] = {
    ref, station, bottle, fill, requestedG: g, status: 'open',
    seq: ++state.seq, createdAt: now,
    history: [{ at: now, event: 'request', station, bottle, fill, g }],
  };
  reevaluate(state, now);
  return orderView(state, ref);
}

export function releaseOrder(state, ref, now, reason = '撤销保留') {
  const o = mustOrder(state, ref);
  if (o.status !== 'open') throw new Error(`领用单 ${ref} 已关闭`);
  for (const r of reservationsOf(state, ref)) {
    if (r.status === 'active' || r.status === 'held') {
      r.status = 'released';
      r.closedAt = now;
      r.closeReason = reason;
    }
  }
  o.status = 'closed';
  o.closedAt = now;
  o.history.push({ at: now, event: 'release' });
  reevaluate(state, now);
  return orderView(state, ref);
}

export function reassignOrder(state, ref, target, now) {
  const o = mustOrder(state, ref);
  if (o.status !== 'open') throw new Error(`领用单 ${ref} 已关闭`);
  for (const r of reservationsOf(state, ref)) {
    if (r.status === 'active' || r.status === 'held') {
      r.status = 'released';
      r.closedAt = now;
      r.closeReason = '改配';
    }
  }
  o.history.push({ at: now, event: 'reassign', from: { station: o.station, bottle: o.bottle, fill: o.fill }, to: target });
  Object.assign(o, target);
  reevaluate(state, now);
  return orderView(state, ref);
}

export function handoverOrder(state, ref, grams, now) {
  const o = mustOrder(state, ref);
  if (o.status !== 'open') throw new Error(`领用单 ${ref} 已关闭`);
  reevaluate(state, now);
  const { views } = buildViews(state);
  let remaining = grams ?? Infinity;
  const shipped = [];
  const actives = reservationsOf(state, ref)
    .filter(r => r.status === 'active' && r.g > r.handedG)
    .sort((a, b) => a.seq - b.seq);
  for (const r of actives) {
    if (remaining <= 0) break;
    const view = views.get(keyOf(r.station, r.bottle, r.fill));
    if (!view || view.status !== '合格') continue; // 停发保护：证据已变化的保留不能出库
    const ship = Math.min(r.g - r.handedG, remaining);
    r.handedG += ship;
    if (r.handedG === r.g) r.status = 'handed';
    const h = {
      id: `H${++state.seq}`, ref, reservation: r.id,
      station: r.station, bottle: r.bottle, fill: r.fill, g: ship, at: now,
      evidence: {
        entryId: view.entryId, fill: r.fill,
        report: view.report ? { id: view.report.id, rev: view.report.rev, file: view.report.file } : null,
      },
    };
    state.handovers.push(h);
    shipped.push(h);
    remaining -= ship;
  }
  if (!shipped.length) throw new Error(`领用单 ${ref} 没有可出库的保留（已停发或未配到量）`);
  o.history.push({ at: now, event: 'handover', g: shipped.reduce((a, h) => a + h.g, 0) });
  reevaluate(state, now);
  return shipped;
}

export function reevaluate(state, now = new Date().toISOString()) {
  const { views, gen } = buildViews(state);
  // 1) 未配量按申请先后补配（新到的来源数据可继续处理旧申请）
  const openOrders = Object.values(state.orders).filter(o => o.status === 'open').sort((a, b) => a.seq - b.seq);
  for (const o of openOrders) {
    const need = orderView(state, o.ref).unallocatedG;
    if (need <= 0) continue;
    const view = views.get(keyOf(o.station, o.bottle, o.fill));
    if (!view || view.availableG <= 0) continue;
    const take = Math.min(need, view.availableG);
    const r = {
      id: `R${++state.seq}`, ref: o.ref, station: o.station, bottle: o.bottle, fill: o.fill,
      g: take, handedG: 0, status: 'active', reason: null, seq: state.seq, createdAt: now,
    };
    state.reservations[r.id] = r;
    view.activeG += take;
    view.availableG -= take;
    o.history.push({ at: now, event: 'reserve', id: r.id, g: take });
  }
  // 2) 停发评估：同一可用量按保留先后承诺，证据不足立即停发
  const byKey = new Map();
  for (const r of Object.values(state.reservations)) {
    if (r.status !== 'active' && r.status !== 'held') continue;
    const k = keyOf(r.station, r.bottle, r.fill);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const [k, list] of byKey) {
    const view = views.get(k);
    let budget = view ? view.qualifiedRemainingG : 0;
    for (const r of list.sort((a, b) => a.seq - b.seq)) {
      const need = r.g - r.handedG;
      let next = 'active';
      let reason = null;
      if (!view) { next = 'held'; reason = '充装记录不存在'; }
      else if (view.reversed) { next = 'held'; reason = '充装已冲销'; }
      else if (view.movedAway || !view.current) { next = 'held'; reason = `充装归属已更正（现为 ${currentFill(gen, r.station, r.bottle) ?? '未知'}）`; }
      else if (view.problems.length) { next = 'held'; reason = `证据不足：${view.problems[0].detail}`; }
      else if (need > budget) { next = 'held'; reason = '合格余量不足'; }
      if (next === 'active') budget -= need;
      if (r.status !== next || r.reason !== reason) {
        r.status = next;
        r.reason = reason;
        state.orders[r.ref]?.history.push({ at: now, event: next === 'held' ? 'hold' : 'resume', id: r.id, reason });
      }
    }
  }
  // 3) 跟进清单：已出库交接按当时证据保留，只列需要联系的领用班与原因
  state.followups = [];
  for (const h of state.handovers) {
    const view = views.get(keyOf(h.station, h.bottle, h.fill));
    const reasons = [];
    if (!view) {
      reasons.push('充装记录已不存在');
    } else {
      if (view.reversed) reasons.push('充装已冲销');
      if (view.movedAway || !view.current) reasons.push(`充装归属已更正（现为 ${currentFill(gen, h.station, h.bottle) ?? '未知'}）`);
      const snap = h.evidence?.report ?? null;
      if (!view.report) reasons.push(`检验报告已撤回或缺失（原 ${snap ? `${snap.id} rev${snap.rev}` : '无'}）`);
      else if (!snap || snap.id !== view.report.id || snap.rev !== view.report.rev) {
        reasons.push(`报告版本变更：${snap ? `${snap.id} rev${snap.rev}` : '无'} → ${view.report.id} rev${view.report.rev}`);
      }
      for (const p of view.chainProblems) reasons.push(`谱系${p.severity === 'conflict' ? '冲突' : '待确认'}：${p.detail}`);
    }
    if (reasons.length) {
      state.followups.push({ ref: h.ref, handover: h.id, station: h.station, bottle: h.bottle, fill: h.fill, g: h.g, reasons });
    }
  }
  return state.followups;
}

function currentFill(gen, station, bottle) {
  const key = gen.currentByPair.get(pairOf(station, bottle));
  return key ? key.split('@')[1] : null;
}
