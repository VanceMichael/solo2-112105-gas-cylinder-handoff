// 检验凭据：只认检验站按充装批给出的目录。报告必须指到已核验的原件、
// 代表范围覆盖该瓶、结论合格、且该版本未被撤回。
// 回收输入的早期报告不能替代净化后混合批的报告；瓶改归其他充装批后，
// 旧报告的覆盖不跟瓶号走（目录按充装批取，身份不含当前充装号即不可用）。
export function labEvidence(state, fill, station, bottle) {
  const pair = `${station}/${bottle}`;
  const cat = state.credentials.labs[fill];
  if (!cat) return { report: null, problems: [{ severity: 'pending', type: 'catalog-missing', at: fill, detail: `检验目录 /lab/fills/${fill} 尚未领取` }] };
  if (cat.missing) return { report: null, problems: [{ severity: 'pending', type: 'catalog-missing', at: fill, detail: `检验站没有充装批 ${fill} 的目录` }] };
  const reports = cat.reports ?? [];
  const withdrawals = cat.withdrawals ?? [];
  const mine = reports.filter(r => (r.scope ?? []).includes(pair));
  const disqualified = mine.filter(r => r.verdict !== 'qualified');
  const withdrawn = r => withdrawals.some(w => w.id === r.id && w.rev === r.rev && (w.scope ?? []).includes(pair));
  const effective = mine.filter(r => r.verdict === 'qualified' && !withdrawn(r));
  const verified = effective.filter(r => state.credentials.originals[r.file]?.ok);
  if (verified.length) {
    const best = [...verified].sort((a, b) => (b.rev ?? 0) - (a.rev ?? 0))[0];
    return { report: { id: best.id, rev: best.rev, file: best.file, sha256: best.sha256, verdict: best.verdict }, problems: [] };
  }
  const problems = [];
  if (disqualified.length) problems.push({ severity: 'conflict', type: 'not-qualified', at: fill, detail: `报告 ${disqualified.map(r => `${r.id} rev${r.rev}`).join('、')} 结论非合格` });
  const unverified = effective.filter(r => !state.credentials.originals[r.file]?.ok);
  if (unverified.length) {
    problems.push({ severity: 'pending', type: 'original-unverified', at: fill, detail: `报告原件待核验：${unverified.map(r => r.file).join('、')}` });
  } else if (mine.some(r => r.verdict === 'qualified')) {
    problems.push({ severity: 'pending', type: 'report-withdrawn', at: fill, detail: `充装批 ${fill} 覆盖 ${pair} 的报告已撤回，待重发` });
  } else {
    problems.push({ severity: 'pending', type: 'no-report', at: fill, detail: `充装批 ${fill} 没有覆盖 ${pair} 的检验报告` });
  }
  return { report: null, problems };
}
