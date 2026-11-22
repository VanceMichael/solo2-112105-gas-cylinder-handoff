#!/usr/bin/env node
// 仓库值班台：收件、查瓶、领用、出库、跟进的命令行入口。
// 状态默认存 var/state.json，可用 --state 指定；来源默认 http://127.0.0.1:4178，可用 --origin 指定。
import { readFileSync } from 'node:fs';
import { loadState, saveState, DEFAULT_STATE } from './store.mjs';
import { receive } from './ingest.mjs';
import { buildViews } from './view.mjs';
import { buildGenealogy, keyOf } from './genealogy.mjs';
import { handoverOrder, orderView, placeRequest, reassignOrder, releaseOrder, reevaluate } from './ledger.mjs';

const USAGE = `用法：node src/cli.mjs [--state 路径] [--origin 地址] <命令> …

收件与来源：
  receive                              从来源领取新凭据（缺页、重发、冲销分别记账）
  feeds                                各来源翻页与缺页状态
  gaps                                 缺件、冲突、重发、冲销一览

瓶与凭据：
  bottles                              候选瓶此刻的合格可领量
  bottle <站> <瓶>                     单瓶各充装身份的量、凭据与待确认项

领用：
  request <单号> <站> <瓶> <充装> <克> 登记检修班申请并保留
  import-requests <文件>               导入 requests.json 格式的申请
  orders                               领用单一览
  order <单号>                         领用单详情（含待重配量）
  handover <单号> [克]                 确认出库（默认全部已保留量）
  reassign <单号> <站> <瓶> <充装>     改配到其他瓶/充装
  release <单号>                       撤销保留并关闭申请
  audit                                停发与跟进清单（仓管）
`;

const RES_STATUS = { active: '保留中', held: '已停发', released: '已撤销', handed: '已出库' };

const argv = process.argv.slice(2);
const opts = { state: process.env.DESK_STATE ?? DEFAULT_STATE, origin: process.env.DESK_ORIGIN ?? 'http://127.0.0.1:4178' };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--state') opts.state = argv[++i];
  else if (argv[i] === '--origin') opts.origin = argv[++i];
  else pos.push(argv[i]);
}
const [cmd, ...rest] = pos;
const state = loadState(opts.state);
const now = new Date().toISOString();
const persist = () => saveState(opts.state, state);

function printRun(run) {
  console.log(`收件完成：新凭据 ${run.newRows}，同批重发 ${run.duplicates}，冲突 ${run.conflicts}，检验目录 ${run.labs}，原件核验 ${run.originals}`);
  for (const g of run.gapsOpened) console.log(`  缺页登记：${g.feed} ${g.cursor ?? '(首页)'}（${g.error}）`);
  for (const g of run.gapsResolved) console.log(`  缺页解除：${g.feed} ${g.cursor ?? '(首页)'}`);
}

function printBottles() {
  const { views } = buildViews(state);
  if (!views.size) { console.log('（暂无瓶记录，先 receive）'); return; }
  console.log('瓶（站/瓶@充装） | 状态 | 名义g | 合格剩余g | 已留g | 停发g | 已出g | 可领g');
  for (const v of [...views.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`${v.key}${v.current ? '' : '（历史）'} | ${v.status} | ${v.nominalG} | ${v.qualifiedRemainingG} | ${v.activeG} | ${v.heldG} | ${v.handedOutG} | ${v.availableG}`);
  }
}

function printBottle(station, bottle) {
  const { views } = buildViews(state);
  const list = [...views.values()].filter(v => v.station === station && v.bottle === bottle);
  if (!list.length) { console.log(`没有 ${station}/${bottle} 的记录`); return; }
  for (const v of list) {
    console.log(`\n${v.key}${v.current ? '（当前身份）' : '（历史身份）'} 状态：${v.status}`);
    console.log(`  名义 ${v.nominalG}g｜合格剩余 ${v.qualifiedRemainingG}g｜已留 ${v.activeG}g｜停发 ${v.heldG}g｜已出 ${v.handedOutG}g｜可领 ${v.availableG}g`);
    if (v.report) console.log(`  检验：报告 ${v.report.id} rev${v.report.rev}（${v.report.file}，原件已核）`);
    if (v.problems.length) {
      console.log('  待确认/冲突：');
      for (const p of v.problems) console.log(`    - [${p.severity === 'conflict' ? '冲突' : '待确认'}] ${p.detail}`);
    }
    console.log('  谱系凭据：');
    for (const e of v.evidence) console.log(`    - ${e}`);
    for (const r of Object.values(state.reservations).filter(r => keyOf(r.station, r.bottle, r.fill) === v.key)) {
      console.log(`  保留 ${r.id}：${r.ref} ${r.g - r.handedG}g ${RES_STATUS[r.status] ?? r.status}${r.reason ? `（${r.reason}）` : ''}`);
    }
    for (const h of state.handovers.filter(h => keyOf(h.station, h.bottle, h.fill) === v.key)) {
      console.log(`  出库 ${h.id}：${h.ref} ${h.g}g（当时证据：报告 ${h.evidence.report ? `${h.evidence.report.id} rev${h.evidence.report.rev}` : '无'}）`);
    }
  }
}

function printOrders() {
  const orders = Object.values(state.orders).sort((a, b) => a.seq - b.seq);
  if (!orders.length) { console.log('（暂无领用单）'); return; }
  console.log('单号 | 目标（站/瓶@充装） | 申请g | 保留g | 停发g | 已出g | 待重配g | 状态');
  for (const o of orders) {
    const v = orderView(state, o.ref);
    console.log(`${o.ref} | ${o.station}/${o.bottle}@${o.fill} | ${o.requestedG} | ${v.activeG} | ${v.heldG} | ${v.handedG} | ${v.pendingReallocG} | ${o.status === 'open' ? '在办' : '已关闭'}`);
  }
}

function printOrder(ref) {
  const v = orderView(state, ref);
  if (!v) { console.log(`领用单 ${ref} 不存在`); return; }
  console.log(`${v.ref} → ${v.station}/${v.bottle}@${v.fill}（${v.status === 'open' ? '在办' : '已关闭'}）`);
  console.log(`  申请 ${v.requestedG}g｜保留 ${v.activeG}g｜停发 ${v.heldG}g｜已出 ${v.handedG}g｜待重配 ${v.pendingReallocG}g（未配 ${v.unallocatedG}g）`);
  for (const r of v.reservations) console.log(`  保留 ${r.id}：${r.g - r.handedG}g ${RES_STATUS[r.status] ?? r.status}${r.reason ? `（${r.reason}）` : ''}`);
  for (const h of v.handovers) console.log(`  出库 ${h.id}：${h.g}g @ ${h.at}（当时证据：报告 ${h.evidence.report ? `${h.evidence.report.id} rev${h.evidence.report.rev}` : '无'}）`);
  console.log('  履历：');
  for (const e of v.history) console.log(`    - ${e.at} ${e.event}${e.g != null ? ` ${e.g}g` : ''}${e.reason ? `（${e.reason}）` : ''}${e.to ? ` → ${e.to.station}/${e.to.bottle}@${e.to.fill}` : ''}`);
}

function printAudit() {
  const held = Object.values(state.reservations).filter(r => r.status === 'held');
  console.log('停发保留（证据变化，立即停止发货）：');
  if (!held.length) console.log('  （无）');
  for (const r of held) console.log(`  ${r.id} ${r.ref} ${r.station}/${r.bottle}@${r.fill} ${r.g - r.handedG}g —— ${r.reason}`);
  console.log('跟进清单（已出库交接按当时证据保留，需联系领用班）：');
  if (!state.followups.length) console.log('  （无）');
  for (const f of state.followups) console.log(`  ${f.ref}（${f.handover}）${f.station}/${f.bottle}@${f.fill} ${f.g}g：${f.reasons.join('；')}`);
}

function printGaps() {
  const gen = buildGenealogy(state);
  console.log('来源缺页：');
  const gaps = Object.values(state.feeds).flatMap(f => f.gaps);
  if (!gaps.length) console.log('  （无）');
  for (const g of gaps) console.log(`  ${g.feed} ${g.cursor ?? '(首页)'} ${g.status === 'open' ? '缺页中' : '已解除'}（${g.error}，${g.since}${g.resolvedAt ? ` → ${g.resolvedAt}` : ''}）`);
  console.log('凭据冲突：');
  if (!state.conflicts.length) console.log('  （无）');
  for (const c of state.conflicts) console.log(`  [${c.type}] ${c.detail ?? c.id ?? ''}`);
  console.log('谱系结构问题：');
  if (!gen.structural.length) console.log('  （无）');
  for (const p of gen.structural) console.log(`  [${p.type}] ${p.detail}`);
  console.log('再次送到的同一凭据（未重复计入）：');
  const dups = Object.entries(state.duplicates);
  if (!dups.length) console.log('  （无）');
  for (const [id, d] of dups) console.log(`  ${id}（${d.kind}）×${d.count}`);
  console.log('冲销：');
  const reversed = [...gen.entries.values()].filter(e => e.reversed);
  if (!reversed.length) console.log('  （无）');
  for (const e of reversed) console.log(`  ${e.id} —— ${e.problems.find(p => p.type === 'reversed')?.detail ?? ''}`);
}

try {
  switch (cmd) {
    case 'receive': {
      const run = await receive(state, { origin: opts.origin, now });
      persist();
      printRun(run);
      break;
    }
    case 'feeds': {
      for (const [name, feed] of Object.entries(state.feeds)) {
        const open = feed.gaps.filter(g => g.status === 'open');
        console.log(`${name}：${feed.done ? '已到底' : '未到底'}${open.length ? `，缺页 ${open.map(g => g.cursor ?? '(首页)').join('、')}` : ''}`);
      }
      break;
    }
    case 'gaps':
      printGaps();
      break;
    case 'bottles':
      printBottles();
      break;
    case 'bottle':
      printBottle(rest[0], rest[1]);
      break;
    case 'request': {
      const [ref, station, bottle, fill, g] = rest;
      const v = placeRequest(state, { ref, station, bottle, fill, g: Number(g) }, now);
      persist();
      console.log(`已登记 ${ref}：保留 ${v.activeG}g，待重配 ${v.pendingReallocG}g`);
      break;
    }
    case 'import-requests': {
      const data = JSON.parse(readFileSync(rest[0], 'utf8'));
      for (const r of data.reservations ?? []) {
        if (state.orders[r.ref]) { console.log(`跳过已存在的 ${r.ref}`); continue; }
        const v = placeRequest(state, r, now);
        console.log(`${r.ref}：保留 ${v.activeG}g，待重配 ${v.pendingReallocG}g`);
      }
      persist();
      break;
    }
    case 'orders':
      printOrders();
      break;
    case 'order':
      printOrder(rest[0]);
      break;
    case 'handover': {
      const shipped = handoverOrder(state, rest[0], rest[1] != null ? Number(rest[1]) : undefined, now);
      persist();
      for (const h of shipped) console.log(`已出库 ${h.id}：${h.ref} ${h.station}/${h.bottle}@${h.fill} ${h.g}g`);
      break;
    }
    case 'reassign': {
      const [ref, station, bottle, fill] = rest;
      const v = reassignOrder(state, ref, { station, bottle, fill }, now);
      persist();
      console.log(`已改配 ${ref} → ${station}/${bottle}@${fill}：保留 ${v.activeG}g，待重配 ${v.pendingReallocG}g`);
      break;
    }
    case 'release': {
      releaseOrder(state, rest[0], now);
      persist();
      console.log(`已撤销并关闭 ${rest[0]}`);
      break;
    }
    case 'audit':
      reevaluate(state, now);
      persist();
      printAudit();
      break;
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
} catch (err) {
  console.error(`错误：${err.message}`);
  process.exitCode = 1;
}
