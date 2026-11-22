// 瓶级视图：谱系 + 检验 + 保留/出库占用，得出每只瓶此刻的合格可领量。
import { buildGenealogy, keyOf, pairOf } from './genealogy.mjs';
import { labEvidence } from './lab.mjs';

export function buildViews(state) {
  const gen = buildGenealogy(state);
  const handedByKey = new Map();
  for (const h of state.handovers) {
    const k = keyOf(h.station, h.bottle, h.fill);
    handedByKey.set(k, (handedByKey.get(k) ?? 0) + h.g);
  }
  const activeByKey = new Map();
  const heldByKey = new Map();
  for (const r of Object.values(state.reservations)) {
    const rest = Math.max(0, r.g - r.handedG);
    if (!rest) continue;
    const k = keyOf(r.station, r.bottle, r.fill);
    if (r.status === 'active') activeByKey.set(k, (activeByKey.get(k) ?? 0) + rest);
    if (r.status === 'held') heldByKey.set(k, (heldByKey.get(k) ?? 0) + rest);
  }
  const views = new Map();
  for (const rec of gen.bottles.values()) {
    const chain = gen.resolve(rec.entryId);
    const lab = labEvidence(state, rec.fill, rec.station, rec.bottle);
    const entry = gen.entries.get(rec.entryId);
    const reversed = entry?.reversed ?? false;
    const problems = [...chain.problems, ...lab.problems];
    const current = !reversed && gen.currentByPair.get(pairOf(rec.station, rec.bottle)) === rec.key;
    const qualified = current && !rec.movedAway && rec.g > 0 && problems.length === 0;
    const handedOutG = handedByKey.get(rec.key) ?? 0;
    const activeG = activeByKey.get(rec.key) ?? 0;
    const heldG = heldByKey.get(rec.key) ?? 0;
    const qualifiedG = qualified ? rec.g : 0;
    const qualifiedRemainingG = Math.max(0, qualifiedG - handedOutG);
    const availableG = Math.max(0, qualifiedRemainingG - activeG);
    const status = reversed ? '已冲销'
      : rec.movedAway ? '已迁出'
      : problems.some(p => p.severity === 'conflict') ? '挂起'
      : problems.length ? '待确认'
      : '合格';
    views.set(rec.key, {
      ...rec, current, reversed, problems,
      chainProblems: chain.problems, labProblems: lab.problems,
      evidence: chain.evidence, report: lab.report,
      nominalG: rec.g, handedOutG, activeG, heldG,
      qualifiedG, qualifiedRemainingG, availableG, status,
    });
  }
  return { views, gen };
}
