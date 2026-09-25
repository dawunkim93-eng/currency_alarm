/**
 * 달러·엔화 매수 적합성 판정 — 세븐스플릿 앱 방식을 그대로 옮긴 순수 함수
 *
 * 4개 지표(환율·국제강도·갭·적정환율) 중 갭과 적정환율은 수식상 같은 조건이므로
 * **3조건 × 4기간(1·3·6·12개월) = 12점**으로 채점한다. 적정 환율은 표시값으로만 남긴다.
 *
 *   1) 환율이 싸다     : 현재 환율 < 기간 (최저+최고)/2
 *   2) 국제적으로 약세 : 달러는 DXY < 중간값, 엔은 엔지수(바스켓) < 중간값
 *      (엔의 약세 = 엔지수 하락 = 매수에 유리, 달러와 같은 방향이다)
 *   3) 갭 비율         : (지수 ÷ 환율 × 100) > 기간 평균 갭
 *   적정 환율          : 지수 ÷ 평균 갭 × 100 (현재 환율과의 차이를 보여주는 참고값)
 *
 * 기준값은 앱 관찰을 따른다 — 1·2번은 최저·최고의 중간값, 갭은 기간 평균.
 * 창은 **영업일 봉 개수**(기본 21·63·126·250)다. 앱 데이터와 대조한 결과
 * 1개월 창이 영업일 ~21봉과 일치했고(중간값 오차 0.04%), 달력일 기준(30일)은
 * 앱보다 창이 넓어 중간값이 어긋났다.
 *
 * 주의 (원문 관찰 기준)
 *   - 1·2번 기준값은 최저·최고 두 값만으로 정해지므로 극단값 하루에 좌우된다.
 *   - 갭의 O 는 "환율이 오를 여지"이지 보장이 아니다 — 갭은 국제강도 하락으로도
 *     좁혀지고, 그때는 환율이 제자리라 매수 이득이 없다.
 *   - 앱은 국내 고시 기반일별 시세를 쓴다. 우리는 야후 마감가라 절대값이 다를
 *     수 있으나 판정(O/X)은 대체로 일치한다.
 */

export const BANDS = ["부적합", "중립", "적합", "만점"];

/** 12개 중 이 개수 이상이면 '적합'. 만점은 최대 점수일 때만 별도 밴드. */
export const GOOD_SCORE_DEFAULT = 9;

/** 아침 브리핑 기본 시각(KST 시). 매일 이 시각을 지나면 하루 한 번 보낸다. */
export const REPORT_HOUR_DEFAULT = 8;

import { kstHour, kstEpochAt } from "./format.mjs";

/** 판정 창 — **영업일 봉 개수**다 (달력일이 아니라). 앱의 1M 이 ~21봉과 일치했다. */
const WINDOWS_BARS = [21, 63, 126, 250];
const WINDOW_LABELS = ["1M", "3M", "6M", "12M"];
/** 창 안에 이보다 적은 봉이면 판정을 하지 않는다 (공휴일·수집 실패 방어). */
const MIN_BARS = 10;

/**
 * 엔 강도 지수의 바스켓 — 달러의 DXY 역할. 앱의 '엔 지수'는 실효환율(접근 불가)이라
 * 주요 통화 대비 엔화를 **등가중 기하평균**으로 자체 계산한다. 스케일은 앱과 다르지만
 * 판정은 전부 중간값·평균과의 비교라 무관하다 — 모양(강세·약세 궤적)이 같으면 된다.
 */
export const YEN_BASKET = ["usd", "eur", "gbp", "chf", "cad", "cny", "aud"];

const SPEC = [
  {
    id: "suit_usd",
    emoji: "💵",
    title: "달러 매수 적합성",
    rate: "usdkrw",
    strength: "dxy",
    /** 달러는 지수(강세)가 낮을수록 매수에 유리하다. */
    strengthFiresBelow: true,
    gapNote: "DXY ÷ 환율",
  },
  {
    id: "suit_jpy",
    emoji: "💴",
    title: "엔화 매수 적합성",
    rate: "jpykrw",
    strength: "yenIndex",
    /** 엔지수가 낮을수록 약세(쌈) — 달러와 같은 방향이다. */
    strengthFiresBelow: true,
    gapNote: "엔지수(7통화 바스켓) ÷ 원엔",
  },
];

/**
 * 엔 강도 지수 — 바스켓 통화 대비 엔화를 기하평균해 기준일(첫 봉)=100 으로
 * 정규화한다. 높을수록 엔 강세. 스케일은 판정에 무관하다 (전부 같은 시리즈
 * 안에서 중간값·평균과 비교하므로).
 *
 * @param {object} daily  { usd: {bars, current}, eur: …, … } — YEN_BASKET 키들
 * @returns {{ bars: [{t, c}], current: number } | null}
 */
export function buildYenIndex(daily, { now = Date.now() } = {}) {
  const legs = YEN_BASKET.map((key) => daily?.[key]).filter(Boolean);
  if (legs.length < YEN_BASKET.length) return null;

  // 공통 날짜에만 지수를 만든다 — 한 통화라 빠진 날은 그날 통째로 건너뛴다.
  const maps = legs.map((leg) => new Map(leg.bars.map((bar) => [dayKey(bar.t), bar.c])));
  const dates = new Set(maps[0].keys());
  for (const map of maps.slice(1)) {
    for (const d of [...dates]) if (!map.has(d)) dates.delete(d);
  }
  if (dates.size < MIN_BARS) return null;

  const sorted = [...dates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const base = maps.map((map) => map.get(sorted[0]));
  const bars = sorted.map((d) => {
    const t = new Date(d).getTime();
    const geo = Math.exp(
      maps.reduce((acc, map, i) => acc + Math.log(map.get(d) / base[i]), 0) / maps.length,
    );
    return { t, c: 100 / geo }; // 엔이 강해지면(타통화 대비 엔값↑) 지수가 올라간다
  });

  const currents = legs.map((leg) => leg.current);
  if (currents.some((c) => typeof c !== "number" || !Number.isFinite(c))) return null;
  const geoCur = currents.reduce((acc, c, i) => acc * (c / legs[i].bars.at(-1).c), 1);
  const current = bars.at(-1).c * geoCur;
  return { bars, current };
}

/**
 * @param {object} args
 * @param {object} args.daily  일별 시계열 — sources.fetchDailySeries 의 결과.
 *   각 항목은 { bars: [{t, c}], current: number }, 부분 실패한 키는 null.
 *   엔 강도는 여기서 yenIndex 를 만들어 쓴다 (daily.yenIndex 가 있으면 그걸 쓴다).
 * @param {object} args.config  (suitability 섹션 포함)
 * @returns {object[]} 신호 배열 — 데이터가 부족한 통화는 조용히 생략
 */
export function evaluateSuitability({ daily, config, now = Date.now() }) {
  const s = config?.suitability ?? {};
  if (s.enabled === false) return [];
  const good = typeof s.goodScore === "number" ? s.goodScore : GOOD_SCORE_DEFAULT;
  const windows = Array.isArray(s.windows) && s.windows.length ? s.windows : WINDOWS_BARS;
  const labels = windows.length === WINDOWS_BARS.length ? WINDOW_LABELS : windows.map((n) => `${n}봉`);

  // 엔 강도 지수 — 바스켓 통화가 다 살아 있어야 만든다.
  const yenIndex = daily?.yenIndex ?? buildYenIndex(daily, { now });

  const inputs = { ...daily, yenIndex };
  const signals = [];
  for (const spec of SPEC) {
    const rate = daily?.[spec.rate];
    const strength = yenIndex && spec.strength === "yenIndex" ? yenIndex : daily?.[spec.strength];
    if (!rate || !strength || typeof rate.current !== "number" || typeof strength.current !== "number") continue;

    const aligned = alignByDate(rate.bars, strength.bars);
    if (aligned.length < MIN_BARS) continue;

    const windowRows = [];
    let score = 0;
    const maxScore = windows.length * 3;

    windows.forEach((barsCount, wi) => {
      const label = labels[wi];
      // 봉 개수 기준 창 — 최근 N개의 완성 봉.
      const slice = aligned.slice(-barsCount);
      if (slice.length < MIN_BARS) {
        windowRows.push({ label, ok: false, score: 0, note: "데이터 부족" });
        return;
      }

      const rates = slice.map((row) => row.rate);
      const strengths = slice.map((row) => row.strength);
      const gaps = slice.map((row) => (row.strength / row.rate) * 100);
      const rateMid = (Math.min(...rates) + Math.max(...rates)) / 2;
      const strengthMid = (Math.min(...strengths) + Math.max(...strengths)) / 2;
      const gapAvg = gaps.reduce((a, b) => a + b, 0) / gaps.length;

      const checks = [
        {
          key: "rate",
          label: "환율",
          current: rate.current,
          reference: rateMid,
          // 음수(현재 < 기준)면 O. 표시 % = (현재 − 기준) / 현재 × 100.
          ok: rate.current < rateMid,
          pct: pctOf(rate.current, rateMid),
        },
        {
          key: "strength",
          label: "국제강도",
          current: strength.current,
          reference: strengthMid,
          ok: spec.strengthFiresBelow
            ? strength.current < strengthMid
            : strength.current > strengthMid,
          pct: pctOf(strength.current, strengthMid),
        },
        {
          key: "gap",
          label: "갭비율",
          current: (strength.current / rate.current) * 100,
          reference: gapAvg,
          ok: (strength.current / rate.current) * 100 > gapAvg,
          pct: pctOf((strength.current / rate.current) * 100, gapAvg),
        },
      ];
      const fair = (strength.current / gapAvg) * 100;
      const windowScore = checks.filter((c) => c.ok).length;
      score += windowScore;
      windowRows.push({ label, ok: true, score: windowScore, checks, fair });
    });

    const perfect = score >= maxScore;
    const rank = perfect ? 3 : score >= good ? 2 : score <= maxScore - good ? 0 : 1;
    const summary = windowRows
      .filter((row) => row.ok)
      .map((row) => `${row.label} ${row.score}/3`)
      .join(" · ");

    signals.push({
      id: spec.id,
      kind: "suitability",
      emoji: spec.emoji,
      title: spec.title,
      band: BANDS[rank],
      rank,
      score,
      maxScore,
      subtitle: `${BANDS[rank]} ${score}/${maxScore} — ${summary}`,
      value: rank,
      threshold: good,
      fired: rank >= 2,
      legs: windowRows
        .filter((row) => row.ok)
        .map((row) => ({ label: row.label, value: row.score, unit: "/3" })),
      note: `${spec.gapNote} 기준. 세부는 /적합`,
    });
  }

  return signals;
}

/**
 * 아침 브리핑 발송 시점 판정.
 *
 * "KST 시각이 reportHour(기본 8)를 넘었고, 마지막 발송이 오늘 그 시각보다
 * 이전"이면 due — 하루에 정확히 한 번. 8시 실행이 지연·누락돼도 그날 안의
 * 다음 틱이 대신 보낸다.
 */
export function isReportDue({ config, lastSuitAt = 0, now = Date.now() }) {
  const suit = config?.suitability ?? {};
  if (suit.enabled === false) return false;
  const hour = typeof suit.reportHour === "number" ? suit.reportHour : REPORT_HOUR_DEFAULT;
  if (hour < 0 || hour > 23) return false;
  if (kstHour(now) < hour) return false;
  return lastSuitAt < kstEpochAt(hour, now);
}

/** (현재 − 기준) ÷ 현재 × 100 — 앱 화면의 괄호 % 와 같은 규칙. */
export function pctOf(current, reference) {
  if (!current) return null;
  return ((current - reference) / current) * 100;
}

/**
 * 두 시계열의 공통 날짜만 남긴다. DXY 는 미국 휴장일이 달라 봉 개수가 다르고,
 * 갭 계산은 같은 날짜끼리 짝지어야 한다.
 */
export function alignByDate(barsA, barsB) {
  const byDate = new Map(barsB.map((bar) => [dayKey(bar.t), bar.c]));
  const out = [];
  for (const bar of barsA) {
    const c = byDate.get(dayKey(bar.t));
    if (c != null) out.push({ t: bar.t, rate: bar.c, strength: c });
  }
  return out;
}

/** UTC 날짜 키. 야후 일봉 timestamp 는 정각이라 date 로 묶으면 안전하다. */
export function dayKey(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/**
 * 야후 1년 일봉 → [{t, c}].
 *
 * ⚠️ 야후 chart.timestamp 는 **초 단위**다. 전부 ×1000 으로 ms 로 정규화해서
 * 돌려준다 — 창 필터·dayKey·히스토리 비교가 전부 ms 기준이라 여기서 못박는다.
 * (초/ms 를 섞어 쓰면 창 필터가 음수 컷이 되어 모든 창이 1년 전체가 되는
 * 버그가 생겼었다 — 테스트 픽스처가 ms 라 못 잡혔던 케이스.)
 *
 * 당일 미완성 봉은 통계에서 제외한다 (앱이 기간 최저·최고에 실시간 값을 넣지
 * 않는 것과 같다). 현재값은 meta 의 실시간 가격을 그대로 쓴다.
 */
export function toBars(timestamps, closes, now = Date.now()) {
  const pairs = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) pairs.push({ t: timestamps[i] * 1000, c });
  }
  // 마지막 봉이 24시간 안이면 오늘 진행 중 봉이다 — 통계에서 버린다.
  const bars = pairs.length && now - pairs[pairs.length - 1].t < 86_400_000 ? pairs.slice(0, -1) : pairs;
  return bars;
}