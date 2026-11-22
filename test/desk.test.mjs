import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

import { openOrigin } from '../origin/test-origin.mjs';
import { initialState } from '../src/store.mjs';
import { receive } from '../src/ingest.mjs';
import { buildViews } from '../src/view.mjs';
import { handoverOrder, orderView, placeRequest, reassignOrder, releaseOrder } from '../src/ledger.mjs';

const T = ['2026-11-22T08:00:00Z', '2026-11-22T09:00:00Z', '2026-11-22T10:00:00Z', '2026-11-22T11:00:00Z'];

async function switchRelease(base, name) {
  const res = await fetch(`${base}/_desk/releases/${encodeURIComponent(name)}`, { method: 'POST' });
  assert.equal(res.status, 200);
}

test('值班全流程：首发缺页 → 补报解除 → 更正停发与跟进', async t => {
  const base = await openOrigin(t);
  const state = initialState();

  // —— 首发：交接站第二页 503，转入凭据缺页，瓶量待确认 ——
  await switchRelease(base, '首发');
  let run = await receive(state, { origin: base, now: T[0] });
  assert.equal(run.gapsOpened.length, 1);
  assert.equal(run.gapsOpened[0].cursor, 'shift-b');
  let views = buildViews(state).views;
  const c17 = views.get('S2/C-17@F-021');
  assert.equal(c17.nominalG, 9000);
  assert.equal(c17.qualifiedG, 0);
  assert.equal(c17.status, '待确认');
  assert.ok(c17.problems.some(p => p.type === 'transfer-missing' && p.detail.includes('R-B')));
  assert.equal(c17.report.id, 'L9'); // 检验目录与原件已核验，缺的是谱系凭据
  const c33 = views.get('S2/C-33@F-020');
  assert.equal(c33.qualifiedG, 0);
  assert.ok(c33.problems.some(p => p.type === 'transfer-missing' && p.detail.includes('R-Z')));

  // 检修班在缺件期间提交申请：全部待配
  for (const [ref, station, bottle, fill, g] of [
    ['班领甲', 'S3', 'C-18', 'F-021', 6200],
    ['班领乙', 'S3', 'C-18', 'F-021', 4500],
    ['班领丙', 'S2', 'C-33', 'F-020', 3000],
    ['班领丁', 'S3', 'C-18', 'F-021', 2000],
  ]) placeRequest(state, { ref, station, bottle, fill, g }, T[0]);
  assert.equal(orderView(state, '班领甲').pendingReallocG, 6200);

  // —— 补报：晚班页补到，缺件解除；T-A 同批重发不重复计入 ——
  await switchRelease(base, '补报');
  run = await receive(state, { origin: base, now: T[1] });
  assert.equal(run.gapsResolved.length, 1);
  assert.equal(run.duplicates, 1); // T-A 在同一次领取中再次送到
  assert.ok(state.duplicates['T-A'].count >= 1);
  views = buildViews(state).views;
  assert.equal(views.get('S3/C-18@F-021').qualifiedG, 10400);
  assert.equal(views.get('S2/C-33@F-020').qualifiedG, 5200);
  // 旧申请用新到的来源数据继续处理：按申请先后配量
  assert.equal(orderView(state, '班领甲').activeG, 6200);
  assert.equal(orderView(state, '班领乙').activeG, 4200); // 10400 - 6200，部分保留
  assert.equal(orderView(state, '班领乙').pendingReallocG, 300);
  assert.equal(orderView(state, '班领丙').activeG, 3000);
  assert.equal(orderView(state, '班领丁').pendingReallocG, 2000);
  assert.equal(views.get('S3/C-18@F-021').availableG, 0); // 同一可用量不能承诺给两个班

  // 出库：甲、丙按当时证据交接
  const shippedA = handoverOrder(state, '班领甲', undefined, T[1]);
  assert.equal(shippedA[0].evidence.report.rev, 1);
  handoverOrder(state, '班领丙', undefined, T[1]);
  views = buildViews(state).views;
  assert.equal(views.get('S2/C-33@F-020').availableG, 2200);

  // —— 更正：C-18 改归 F-023，L9 rev1 撤回、rev3 只覆盖 C-17 ——
  await switchRelease(base, '更正');
  run = await receive(state, { origin: base, now: T[2] });
  views = buildViews(state).views;
  // 旧报告的覆盖不跟瓶号走：C-18@F-023 没有报告
  const moved = views.get('S3/C-18@F-023');
  assert.equal(moved.current, true);
  assert.equal(moved.qualifiedG, 0);
  assert.ok(moved.problems.some(p => p.type === 'no-report'));
  const oldIdentity = views.get('S3/C-18@F-021');
  assert.equal(oldIdentity.movedAway, true);
  assert.equal(oldIdentity.current, false);
  // C-17 由 L9 rev3 继续覆盖；C-33 是另一个净化批次，不受影响
  assert.equal(views.get('S2/C-17@F-021').qualifiedG, 9000);
  assert.equal(views.get('S2/C-17@F-021').report.rev, 3);
  assert.equal(views.get('S2/C-33@F-020').availableG, 2200);

  // 乙的保留立即停发，原申请显示待重配量
  const yi = orderView(state, '班领乙');
  assert.equal(yi.activeG, 0);
  assert.equal(yi.heldG, 4200);
  assert.equal(yi.pendingReallocG, 4500);
  assert.match(yi.reservations.find(r => r.status === 'held').reason, /充装归属已更正（现为 F-023）/);
  assert.throws(() => handoverOrder(state, '班领乙', undefined, T[2]), /没有可出库的保留/);

  // 已出库的甲不改写，跟进清单列明联系哪个班、什么原因
  assert.equal(state.handovers.find(h => h.ref === '班领甲').g, 6200);
  const followA = state.followups.find(f => f.ref === '班领甲');
  assert.ok(followA);
  assert.ok(followA.reasons.some(r => r.includes('充装归属已更正')));
  assert.ok(followA.reasons.some(r => r.includes('检验报告已撤回')));
  assert.equal(state.followups.some(f => f.ref === '班领丙'), false);

  // 改配：乙改到 C-17@F-021；撤销后额度回到 C-17
  reassignOrder(state, '班领乙', { station: 'S2', bottle: 'C-17', fill: 'F-021' }, T[2]);
  assert.equal(orderView(state, '班领乙').activeG, 4500);
  releaseOrder(state, '班领乙', T[2]);
  views = buildViews(state).views;
  assert.equal(views.get('S2/C-17@F-021').availableG, 9000);

  // 另一个净化批次仍可正常领用
  placeRequest(state, { ref: '班领戊', station: 'S2', bottle: 'C-33', fill: 'F-020', g: 2000 }, T[2]);
  assert.equal(orderView(state, '班领戊').activeG, 2000);
  assert.equal(buildViews(state).views.get('S2/C-33@F-020').availableG, 200);

  // 再次收件：迟到的旧凭据不把额度再加回一次
  run = await receive(state, { origin: base, now: T[3] });
  assert.equal(run.newRows, 0);
  views = buildViews(state).views;
  assert.equal(views.get('S2/C-17@F-021').nominalG, 9000);
  assert.equal(views.get('S2/C-17@F-021').availableG, 9000);
  assert.equal(views.get('S3/C-18@F-021').nominalG, 0);
  assert.equal(state.followups.filter(f => f.ref === '班领甲').length, 1);
});

function fixtureOrigin(t, routes) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = routes[url.pathname + (url.searchParams.size ? `?${url.searchParams}` : '')] ?? routes[url.pathname];
    if (!route) { res.writeHead(404).end('no route'); return; }
    if (route.status && route.status !== 200) { res.writeHead(route.status).end('{}'); return; }
    res.writeHead(200, { 'content-type': route.mime ?? 'application/json' });
    res.end(route.text ?? JSON.stringify(route.body ?? route));
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

async function listen(server) {
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const doc = text => ({ mime: 'text/plain', text, sha: createHash('sha256').update(text).digest('hex') });

test('冲突、不守恒与冲销只挂起依赖该笔谱系的分支', async t => {
  const d1 = doc('Q0 F-100 S1/B-1 合格');
  const d2 = doc('Q1 F-101 S1/B-2 合格');
  const d3 = doc('Q2 F-102 S1/B-3 合格');
  const d4 = doc('Q3 F-103 S1/B-4 合格');
  const d5 = doc('Q5 F-105 S1/B-5 合格');
  const routes = {
    '/stations/transfers': { body: { rows: [
      { id: 'T-1', lot: 'R-1', station: 'S1', kg: 6, receivedBy: 'N-1' },
      { id: 'T-2', lot: 'R-2', station: 'S1', kg: 7, receivedBy: 'N-2' },
      { id: 'T-4', lot: 'R-4', station: 'S1', kg: 4, receivedBy: 'N-4' },
      { id: 'T-5', lot: 'R-5', station: 'S1', kg: 2, receivedBy: 'N-5' },
    ], next: null } },
    '/plant/ledger': { body: { rows: [
      { id: 'N-1', type: 'blend', inputs: [{ lot: 'R-1', kg: 6 }], outputs: [{ lot: 'P-1', g: 6000 }], lossG: 0 },
      { id: 'F-100', type: 'fill', inputs: [{ lot: 'P-1', g: 6000 }], outputs: [{ station: 'S1', bottle: 'B-1', fill: 'F-100', g: 6000 }], lossG: 0 },
      { id: 'N-2', type: 'blend', inputs: [{ lot: 'R-2', kg: 8 }], outputs: [{ lot: 'P-2', g: 8000 }], lossG: 0 },
      { id: 'F-101', type: 'fill', inputs: [{ lot: 'P-2', g: 8000 }], outputs: [{ station: 'S1', bottle: 'B-2', fill: 'F-101', g: 8000 }], lossG: 0 },
      { id: 'N-3', type: 'blend', inputs: [{ lot: 'R-3', kg: 5 }], outputs: [{ lot: 'P-3', g: 4500 }], lossG: 400 },
      { id: 'F-102', type: 'fill', inputs: [{ lot: 'P-3', g: 4500 }], outputs: [{ station: 'S1', bottle: 'B-3', fill: 'F-102', g: 4500 }], lossG: 0 },
      { id: 'N-4', type: 'blend', inputs: [{ lot: 'R-4', kg: 4 }], outputs: [{ lot: 'P-4', g: 4000 }], lossG: 0 },
      { id: 'F-103', type: 'fill', inputs: [{ lot: 'P-4', g: 4000 }], outputs: [{ station: 'S1', bottle: 'B-4', fill: 'F-103', g: 4000 }], lossG: 0 },
      { id: 'N-5', type: 'blend', inputs: [{ lot: 'R-5', kg: 2 }], outputs: [{ lot: 'P-5', g: 2000 }], lossG: 0 },
      { id: 'F-105', type: 'fill', inputs: [{ lot: 'P-5', g: 2000 }], outputs: [{ station: 'S1', bottle: 'B-5', fill: 'F-105', g: 2000 }], lossG: 0 },
    ], next: 'p2' } },
    '/plant/ledger?cursor=p2': { body: { rows: [
      { id: 'V-1', type: 'reversal', replaces: 'F-100' },
    ], next: null } },
    '/lab/fills/F-100': { body: { reports: [{ id: 'Q0', rev: 1, scope: ['S1/B-1'], verdict: 'qualified', file: '/doc/q0', sha256: d1.sha }], withdrawals: [] } },
    '/lab/fills/F-101': { body: { reports: [{ id: 'Q1', rev: 1, scope: ['S1/B-2'], verdict: 'qualified', file: '/doc/q1', sha256: d2.sha }], withdrawals: [] } },
    '/lab/fills/F-102': { body: { reports: [{ id: 'Q2', rev: 1, scope: ['S1/B-3'], verdict: 'qualified', file: '/doc/q2', sha256: d3.sha }], withdrawals: [] } },
    '/lab/fills/F-103': { body: { reports: [{ id: 'Q3', rev: 1, scope: ['S1/B-4'], verdict: 'qualified', file: '/doc/q3', sha256: d4.sha }], withdrawals: [] } },
    '/lab/fills/F-105': { body: { reports: [{ id: 'Q5', rev: 1, scope: ['S1/B-5'], verdict: 'qualified', file: '/doc/q5', sha256: '0'.repeat(64) }], withdrawals: [] } },
    '/doc/q0': d1, '/doc/q1': d2, '/doc/q2': d3, '/doc/q3': d4, '/doc/q5': d5,
  };
  const base = await listen(fixtureOrigin(t, routes));
  const state = initialState();
  await receive(state, { origin: base, now: T[0] });
  const views = buildViews(state).views;

  // 冲销：F-100 被 V-1 冲销，检验报告也救不回来
  assert.equal(views.get('S1/B-1@F-100').status, '已冲销');
  assert.equal(views.get('S1/B-1@F-100').qualifiedG, 0);
  // 重量冲突：T-2 登记 7000g，N-2 登记 8000g → 只挂起 R-2 分支
  const b2 = views.get('S1/B-2@F-101');
  assert.equal(b2.status, '挂起');
  assert.ok(b2.problems.some(p => p.type === 'weight-mismatch' && p.detail.includes('R-2')));
  // 不守恒 + 缺交接凭据：N-3 转入 5000 ≠ 分出 4500 + 损耗 400，且 R-3 无凭据
  const b3 = views.get('S1/B-3@F-102');
  assert.equal(b3.status, '挂起');
  assert.ok(b3.problems.some(p => p.type === 'conservation' && p.detail.includes('N-3')));
  assert.ok(b3.problems.some(p => p.type === 'transfer-missing' && p.detail.includes('R-3')));
  // 报告原件核验失败：sha256 不符 → 待确认
  const b5 = views.get('S1/B-5@F-105');
  assert.equal(b5.status, '待确认');
  assert.ok(b5.problems.some(p => p.type === 'original-unverified'));
  // 无冲突的分支正常可领
  assert.equal(views.get('S1/B-4@F-103').status, '合格');
  assert.equal(views.get('S1/B-4@F-103').availableG, 4000);

  placeRequest(state, { ref: '检修一', station: 'S1', bottle: 'B-1', fill: 'F-100', g: 1000 }, T[0]);
  assert.equal(orderView(state, '检修一').pendingReallocG, 1000); // 已冲销的充装不能领
  placeRequest(state, { ref: '检修二', station: 'S1', bottle: 'B-4', fill: 'F-103', g: 1500 }, T[0]);
  assert.equal(orderView(state, '检修二').activeG, 1500);

  // 同一凭据再次送到但内容不一致：保留先到版本，登记冲突，不挂起无关分支
  routes['/stations/transfers'].body.rows[2] = { id: 'T-4', lot: 'R-4', station: 'S1', kg: 4.5, receivedBy: 'N-4' };
  const run = await receive(state, { origin: base, now: T[1] });
  assert.ok(state.conflicts.some(c => c.type === 'redelivery-mismatch' && c.id === 'T-4'));
  assert.equal(state.credentials.transfers['T-4'].kg, 4);
  const after = buildViews(state).views;
  assert.equal(after.get('S1/B-4@F-103').status, '合格');
  // 冲销不因重复收件复活
  assert.equal(after.get('S1/B-1@F-100').status, '已冲销');
  assert.equal(run.newRows, 0);
});
