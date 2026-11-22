// 状态存取：凭据、缺页、冲突、领用单、保留与出库都落在一个 JSON 状态文件里，
// 下一班可以接着同一状态文件继续收件与处理。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_STATE = 'var/state.json';

export function initialState() {
  return {
    version: 1,
    feeds: {
      stations: { done: false, gaps: [] },
      plant: { done: false, gaps: [] },
      lab: { done: true, gaps: [] },
    },
    credentials: { transfers: {}, plant: {}, labs: {}, originals: {} },
    duplicates: {},
    conflicts: [],
    orders: {},
    reservations: {},
    handovers: [],
    followups: [],
    runs: [],
    seq: 0,
  };
}

export function loadState(path) {
  if (!existsSync(path)) return initialState();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const base = initialState();
  return {
    ...base, ...parsed,
    feeds: { ...base.feeds, ...parsed.feeds },
    credentials: { ...base.credentials, ...parsed.credentials },
  };
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
