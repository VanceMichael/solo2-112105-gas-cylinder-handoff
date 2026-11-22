// 批次谱系：以净化方签发的转入、混合、分装、灌装记录为准，
// 交接站流水用于核对每个外来转入批的重量与归属。
// 更正记录把所列瓶与克数从被更正的充装迁到新充装号，来源批不变；
// 冲销记录让被冲销工序整体失效，同名凭据之后再次送到也不重新计入。

export const kgToG = kg => Math.round(Number(kg) * 1000);
export const pairOf = (station, bottle) => `${station}/${bottle}`;
export const keyOf = (station, bottle, fill) => `${station}/${bottle}@${fill}`;

const PROCESS_TYPES = new Set(['intake', 'blend', 'split', 'fill']);

function inputGrams(input) {
  if (input == null) return null;
  if (input.g != null) return Math.round(Number(input.g));
  if (input.kg != null) return kgToG(input.kg);
  return null;
}

function mergeInputs(inputs, additions) {
  const byLot = new Map();
  for (const i of [...inputs, ...additions]) {
    const cur = byLot.get(i.lot) ?? { lot: i.lot, g: 0 };
    cur.g += inputGrams(i) ?? 0;
    byLot.set(i.lot, cur);
  }
  return [...byLot.values()];
}

function describeEntry(e) {
  const kind = { intake: '转入', blend: '混合', split: '分装', fill: '灌装' }[e.type] ?? e.type;
  const ins = e.inputs.map(i => `${i.lot} ${inputGrams(i)}g`).join(' + ') || '—';
  const outs = e.type === 'fill'
    ? e.outputs.map(o => `${o.station}/${o.bottle} ${o.g}g`).join('、') || '—'
    : e.outputs.map(o => `${o.lot} ${o.g}g`).join('、') || '—';
  return `工序 ${e.id}：${kind} ${ins} → ${outs}${e.lossG ? `（损耗 ${e.lossG}g）` : ''}${e.synthetic ? '（更正迁入）' : ''}`;
}

export function buildGenealogy(state) {
  const entries = new Map();
  const corrections = [];
  const reversals = [];
  const structural = [];

  for (const row of Object.values(state.credentials.plant)) {
    if (row.type === 'correction') { corrections.push(row); continue; }
    if (row.type === 'reversal') { reversals.push(row); continue; }
    entries.set(row.id, {
      id: row.id, type: row.type, row,
      inputs: (row.inputs ?? []).map(i => ({ ...i })),
      outputs: (row.outputs ?? []).map(o => ({ ...o })),
      lossG: row.lossG ?? 0,
      movedOut: [],
      reversed: false,
      synthetic: false,
      problems: [],
    });
  }

  // 冲销：被冲销工序整体失效
  for (const row of reversals) {
    const target = entries.get(row.replaces);
    if (!target) {
      structural.push({ severity: 'conflict', type: 'reversal-target-missing', at: row.id, detail: `冲销 ${row.id} 指向不存在的工序 ${row.replaces}` });
      continue;
    }
    if (target.reversed) continue;
    target.reversed = true;
    target.problems.push({ severity: 'conflict', type: 'reversed', at: target.id, detail: `工序 ${target.id} 已被 ${row.id} 冲销` });
  }

  // 更正（按到达顺序）：迁出所列瓶与克数，生成以更正号为充装号的合成充装
  for (const row of corrections) {
    const fail = (type, detail) => structural.push({ severity: 'conflict', type, at: row.id, detail });
    const target = entries.get(row.replaces);
    if (!target) { fail('correction-target-missing', `更正 ${row.id} 指向不存在的工序 ${row.replaces}`); continue; }
    if (target.reversed) { fail('correction-on-reversed', `更正 ${row.id} 指向已冲销的工序 ${row.replaces}`); continue; }
    if (target.type !== 'fill') { fail('correction-target-not-fill', `更正 ${row.id} 的对象 ${row.replaces} 不是充装工序`); continue; }
    if (!(row.moves ?? []).length) { fail('correction-empty', `更正 ${row.id} 没有迁出项`); continue; }
    if (!target.inputs.some(i => i.lot === row.inputLot)) { fail('correction-inputlot', `更正 ${row.id} 的来源批 ${row.inputLot} 不在 ${target.id} 的输入中`); continue; }
    const moved = [];
    let movedG = 0;
    for (const mv of row.moves) {
      const out = target.outputs.find(o => o.station === mv.station && o.bottle === mv.bottle && (o.g ?? 0) > 0);
      if (!out || out.g < mv.g) { fail('correction-move-missing', `更正 ${row.id} 迁出 ${mv.station}/${mv.bottle} ${mv.g}g，但 ${target.id} 没有足够余量`); continue; }
      out.g -= mv.g;
      movedG += mv.g;
      moved.push({ station: mv.station, bottle: mv.bottle, fill: mv.fill ?? row.id, g: mv.g });
      target.movedOut.push({ station: mv.station, bottle: mv.bottle, fill: mv.fill ?? row.id, g: mv.g, by: row.id });
    }
    if (!moved.length) continue;
    let syn = entries.get(row.id);
    if (!syn) {
      syn = { id: row.id, type: 'fill', row: { id: row.id, type: 'fill', viaCorrection: row.replaces }, inputs: [], outputs: [], lossG: 0, movedOut: [], reversed: false, synthetic: true, problems: [] };
      entries.set(row.id, syn);
    }
    syn.inputs = mergeInputs(syn.inputs, [{ lot: row.inputLot, g: movedG }]);
    syn.outputs.push(...moved);
  }

  // 守恒：转入（千克折克）= 分出 + 迁出 + 有凭据的工艺损耗
  for (const e of entries.values()) {
    if (e.reversed || !PROCESS_TYPES.has(e.type)) continue;
    const inG = e.inputs.reduce((a, i) => a + (inputGrams(i) ?? 0), 0);
    const outG = e.outputs.reduce((a, o) => a + (o.g ?? 0), 0);
    const movedG = e.movedOut.reduce((a, o) => a + (o.g ?? 0), 0);
    Object.assign(e, { inputsG: inG, outputsG: outG, movedG });
    if (inG !== outG + movedG + e.lossG) {
      e.problems.push({ severity: 'conflict', type: 'conservation', at: e.id,
        detail: `工序 ${e.id} 不守恒：转入 ${inG}g ≠ 分出 ${outG}g${movedG ? ` + 迁出 ${movedG}g` : ''} + 损耗 ${e.lossG}g` });
    }
  }

  // 批产出索引与交接凭据索引
  const producerOf = new Map();
  for (const e of entries.values()) {
    if (e.reversed || !PROCESS_TYPES.has(e.type) || e.type === 'fill') continue;
    for (const o of e.outputs) {
      if (o.lot == null) continue;
      if (producerOf.has(o.lot)) structural.push({ severity: 'conflict', type: 'lot-reproduced', at: e.id, detail: `批 ${o.lot} 由 ${producerOf.get(o.lot)} 与 ${e.id} 重复产出` });
      else producerOf.set(o.lot, e.id);
    }
  }
  const transfersByLot = new Map();
  for (const t of Object.values(state.credentials.transfers)) {
    if (!transfersByLot.has(t.lot)) transfersByLot.set(t.lot, []);
    transfersByLot.get(t.lot).push(t);
  }

  // 谱系求解：返回每个工序的问题清单与成立所凭的原始凭据
  const cache = new Map();
  function resolve(entryId, stack = []) {
    if (cache.has(entryId)) return cache.get(entryId);
    const e = entries.get(entryId);
    if (!e) return { problems: [{ severity: 'conflict', type: 'entry-missing', at: entryId, detail: `工序 ${entryId} 无记录` }], evidence: [] };
    if (stack.includes(entryId)) return { problems: [{ severity: 'conflict', type: 'lot-loop', at: entryId, detail: `批谱系在 ${entryId} 成环` }], evidence: [] };
    const problems = [...e.problems];
    const evidence = [describeEntry(e)];
    if (!e.reversed) {
      for (const input of e.inputs) {
        const producer = producerOf.get(input.lot);
        if (producer) {
          const up = resolve(producer, [...stack, entryId]);
          problems.push(...up.problems);
          evidence.push(...up.evidence);
        } else {
          const notes = transfersByLot.get(input.lot) ?? [];
          const inG = inputGrams(input);
          const match = notes.find(n => n.receivedBy === entryId && kgToG(n.kg) === inG);
          if (!notes.length) {
            problems.push({ severity: 'pending', type: 'transfer-missing', at: entryId, detail: `转入批 ${input.lot} 缺交接凭据（${entryId} 登记 ${inG}g）` });
          } else if (!match) {
            const got = notes.map(n => `${n.id}（${kgToG(n.kg)}g→${n.receivedBy}）`).join('、');
            const sameReceiver = notes.some(n => n.receivedBy === entryId);
            problems.push({ severity: 'conflict', type: sameReceiver ? 'weight-mismatch' : 'attribution-mismatch', at: entryId, detail: `转入批 ${input.lot} 与交接凭据不符：${entryId} 登记 ${inG}g，凭据 ${got}` });
          } else {
            evidence.push(`交接 ${match.id}：${input.lot} ${kgToG(match.kg)}g → ${entryId}`);
          }
        }
      }
    }
    const out = { problems, evidence };
    cache.set(entryId, out);
    return out;
  }

  // 瓶身份：站号 + 瓶号 + 充装号；被冲销的充装保留身份但不算当前
  const bottles = new Map();
  const currentByPair = new Map();
  for (const e of entries.values()) {
    if (e.type !== 'fill') continue;
    for (const o of e.outputs) {
      const fill = o.fill ?? e.id;
      const key = keyOf(o.station, o.bottle, fill);
      if (bottles.has(key)) {
        structural.push({ severity: 'conflict', type: 'bottle-output-twice', at: e.id, detail: `${key} 在 ${e.id} 重复登记` });
        continue;
      }
      bottles.set(key, { key, station: o.station, bottle: o.bottle, fill, g: o.g ?? 0, entryId: e.id, synthetic: e.synthetic, movedAway: false });
      if ((o.g ?? 0) > 0 && !e.reversed) {
        const pair = pairOf(o.station, o.bottle);
        if (currentByPair.has(pair)) structural.push({ severity: 'conflict', type: 'bottle-live-twice', at: e.id, detail: `${pair} 同时挂在 ${bottles.get(currentByPair.get(pair)).fill} 与 ${fill}` });
        currentByPair.set(pair, key);
      }
    }
    for (const mv of e.movedOut) {
      const rec = bottles.get(keyOf(mv.station, mv.bottle, e.id));
      if (rec && rec.g === 0) rec.movedAway = true;
    }
  }

  return { entries, bottles, currentByPair, structural, resolve, transfersByLot, producerOf };
}
