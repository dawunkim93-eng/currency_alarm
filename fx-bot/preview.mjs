#!/usr/bin/env node
/**
 * 알림 미리보기 — 토큰도 네트워크도 없이 메시지 모양만 본다
 *
 *   npm run fx-preview
 *
 * 임계값을 조이기 전에 "이 상황이면 뭐라고 오는지"를 눈으로 확인하는 용도다.
 * 시세는 가짜지만 계산 경로는 실제와 완전히 같다.
 */
import { DEFAULTS, deepMerge } from "./lib/config.mjs";
import { buildQuotes } from "./lib/venues.mjs";
import { evaluate } from "./lib/signals.mjs";
import { evaluateSuitability } from "./lib/suitability.mjs";
import { formatAlert, formatRates, formatSignals, formatSuitability, formatSuitabilityBriefing } from "./lib/format.mjs";

const config = deepMerge(DEFAULTS, { token: "preview", chatIds: ["0"] });
const now = Date.now();

const forex = {
  base: 1390.5,
  ttSelling: 1404.3,
  ttBuying: 1376.7,
  changePct: -0.15,
  changePrice: -2.1,
  provider: "하나은행",
  source: "dunamu",
};

/** 역프 상황: 업비트 테더가 은행 달러보다 싸다. JPYC 도 엔보다 싸다(엔 역프). */
const market = {
  forex,
  exchanges: {
    upbit: { ask: 1383.0, bid: 1382.9 },
    bithumb: { ask: 1383.4, bid: 1382.5 },
  },
  jpy: {
    base: 8.637,
    ttSelling: 8.77,
    ttBuying: 8.504,
    changePct: -1.14,
    changePrice: -0.0998,
    provider: "하나은행",
    source: "dunamu",
  },
  jpyc: { ask: 8.55, bid: 8.54, at: now },
  errors: [],
  at: now,
};

const history = [
  { t: now - 28 * 60_000, base: 1384.2 },
  { t: now - 12 * 60_000, base: 1387.0 },
];

const quotes = buildQuotes({ market, config, now });
const signals = evaluate({ market, quotes, config, history, now });

// 적합성 — 실제와 같은 모양의 1년 일봉을 흉내 낸다(하락 추세 + DXY 최근 반등).
const DAY = 86_400_000;
const rateBars = [];
const dxyBars = [];
const yenBars = [];
for (let i = 0; i < 260; i += 1) {
  const t = now - (259 - i) * DAY;
  rateBars.push({ t, c: 1400 - i });
  dxyBars.push({ t, c: i < 250 ? 110 - i * 0.04 : 100 + (i - 249) * 0.5 });
  yenBars.push({ t, c: 100 - i * 0.03 });
}
const suitSignals = evaluateSuitability({
  daily: {
    usdkrw: { bars: rateBars, current: 1313 },
    dxy: { bars: dxyBars, current: 101.5 },
    jpykrw: { bars: rateBars.map((bar) => ({ t: bar.t, c: bar.c / 160 })), current: 8.2 },
    yenIndex: { bars: yenBars, current: 92.2 },
  },
  config,
});
signals.push(...suitSignals);

const strip = (text) => text.replace(/<[^>]+>/g, "");
const show = (title, text) => console.log(`\n══════ ${title} ══════\n${strip(text)}`);

show("트리거 알림", formatAlert({ signals: signals.filter((s) => s.fired), market, quotes, config }));
show("아침 적합성 브리핑", formatSuitabilityBriefing({ signals, market, quotes }) ?? "(적합성 데이터 없음 — 브리핑 생략)");
show("/시세", formatRates({ market, quotes, signals, config }));
show("/신호", formatSignals({ signals, market, quotes, config }));
show("/적합", formatSuitability({ signals }));
