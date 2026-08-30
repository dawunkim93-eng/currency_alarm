/**
 * 상태 저장 — 시세 기록, 알림 쿨다운, 텔레그램 오프셋, 사용자가 바꾼 임계값
 *
 * 파일 하나(JSON)에 담는다. 봇이 재시작해도 "방금 보낸 알림을 또 보내는" 일이
 * 없어야 해서 디스크에 남긴다. GitHub Actions 처럼 매번 새 컨테이너에서 도는
 * 환경에서는 이 파일을 캐시로 실어 나른다 (fx-bot/README.md 참고).
 *
 * 쓰기는 임시 파일 → rename 으로 한다. 중간에 죽어도 반쯤 쓰인 JSON 이
 * 남지 않게 하려는 것 — 그게 남으면 다음 기동에서 상태를 통째로 잃는다.
 */
import fs from "node:fs";
import path from "node:path";
import { deepMerge } from "./config.mjs";

export const EMPTY_STATE = {
  version: 1,
  updateOffset: 0,
  history: [],
  alerts: {},
  lastDigestAt: 0,
  mutedUntil: 0,
  manualQuotes: {},
  overrides: {},
};

/** 기록 보존: 24시간, 최대 2000개. 급변동 판정에 필요한 창보다 넉넉하면 충분하다. */
const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX_POINTS = 2000;

export function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { ...EMPTY_STATE, ...parsed };
  } catch (error) {
    // 상태가 깨졌다고 봇을 못 켜게 하는 건 과하다. 비우고 계속 간다.
    console.warn(`[fx-bot] 상태 파일이 깨져 새로 시작합니다 (${statePath}): ${error.message}`);
    return { ...EMPTY_STATE };
  }
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

export function pushHistory(history, point, now = Date.now()) {
  const next = [...history, point].filter((entry) => now - entry.t <= HISTORY_MAX_AGE_MS);
  return next.length > HISTORY_MAX_POINTS ? next.slice(next.length - HISTORY_MAX_POINTS) : next;
}

/** 텔레그램에서 바꾼 설정(`/임계`, `/기준금액` …)을 config 위에 얹는다. */
export function applyOverrides(config, state) {
  return state?.overrides ? deepMerge(config, state.overrides) : config;
}

/** `"thresholds.toTetherPct"` 같은 점 경로에 값을 넣은 새 객체를 돌려준다. */
export function setPath(target, dottedPath, value) {
  const keys = dottedPath.split(".");
  const out = structuredClone(target ?? {});
  let cursor = out;
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
  return out;
}

export function getPath(target, dottedPath) {
  return dottedPath.split(".").reduce((cursor, key) => (cursor == null ? cursor : cursor[key]), target);
}
