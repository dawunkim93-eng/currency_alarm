/**
 * 달러·엔화 매수 적합성 판정 — 세븐스플릿 앱 방식을 그대로 옮긴 순수 함수
 *
 * 4개 지표(환율·국제강도·갭·적정환율) 중 갭과 적정환율은 수식상 같은 조건이므로
 * **3조건 × 4기간(1·3·6·12개월) = 12점**으로 채점한다. 적정 환율은 표시값으로만 남긴다.
 *
 *   1) 환율이 싸다     : 현재 환율 < 기간 (최저+최고)/2
 *   2) 국제적으로 약세 : 달러는 DXY < 중간값, 엔은 USD/JPY > 중간값 (엔 약세가 O)
 *   3) 갭 비율         : (지수 ÷ 환율 × 100) > 기간 평균 갭 — 엔은 USD/JPY ÷ 원엔환율
 *   적정 환율          : 지수 ÷ 평균 갭 × 100 (현재 환율과의 차이를 보여주는 참고값)
 *
 * 주의 (원문 관찰 기준)
 *   - 1·2번 기준값은 최저·최고 두 값만으로 정해지므로 극단값 하루에 좌우된다.
 *   - 갭의 O 는 "환율이 오를 여지"이지 보장이 아니다 — 갭은 국제강도 하락으로도
 *     좁혀지고, 그때는 환율이 제자리라 매수 이득이 없다.
 */

export const BANDS = ["부적합", "중립", "적합", "만점"];

/** 12개 중 이 개수 이상이면 '적합'. 만점은 최대 점수일 때만 별도 밴드. */
export const GOOD_SCORE_DEFAULT = 9;

const WINDOWS_DAYS = [30, 90, 180, 365];
const WINDOW_LABELS = ["1M", "3M", "6M", "12M"];
/** 창 안에 이보다 적은 봉이면 판정을 하지 않는다 (공휴일·수집 실패 방어). */
const MIN_BARS = 10;

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
    strength: "usdjpy",
    /** 엔은 USD/JPY 가 높을수록 약세(쌈)라 달러와 방향이 뒤집힌다. */
    strengthFiresBelow: false,
    gapNote: "USD/JPY ÷ 원엔",
  },
];

/**
 * @param {object} args
 * @param {object} args.daily  일별 시계열 { usdkrw, dxy, jpykrw, usdjpy }
 *   각 항목은 { bars: [{t, c}], current: number }. 부분 실패한 키는 null.
 * @param {object} args.config  (suitability 섹션 포함)
 * @returns {object[]} 신호 배열 — 데이터가 부족한 통화는 조용히 생략
 */
export function evaluateSuitability({ daily, config }) {
  const s = config?.suitability ?? {};
  if (s.enabled === false) return [];
  const good = typeof s.goodScore === "number" ? s.goodScore : GOOD_SCORE_DEFAULT;
  const windows = Array.isArray(s.windows) && s.windows.length ? s.windows : WINDOWS_DAYS;
  const labels = windows.length === WINDOWS_DAYS.length ? WINDOW_LABELS : windows.map((d) => `${d}일`);

  const signals = [];
  for (const spec of SPEC) {
    const rate = daily?.[spec.rate];
    const strength = daily?.[spec.strength];
    if (!rate || !strength || typeof rate.current !== "number" || typeof strength.current !== "number") continue;

    const aligned = alignByDate(rate.bars, strength.bars);
    if (aligned.length < MIN_BARS) continue;

    const windowRows = [];
    let score = 0;
    const maxScore = windows.length * 3;

    windows.forEach((days, wi) => {
      const label = labels[wi];
      const cut = aligned[aligned.length - 1].t - days * 86_400_000;
      const slice = aligned.filter((row) => row.t >= cut);
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
 * 야후 1년 일봉 → [{t, c}]. **당일 미완성 봉은 통계에서 제외**한다 (앱이 기간
 * 최저·최고에 실시간 값을 넣지 않는 것과 같다). 현재값은 meta 의 실시간 가격을
 * 그대로 쓴다.
 */
export function toBars(timestamps, closes, now = Date.now()) {
  const pairs = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) pairs.push({ t: timestamps[i], c });
  }
  // 마지막 봉이 24시간 안이면 오늘 진행 중 봉이다 — 통계에서 버린다.
  const bars = pairs.length && now - pairs[pairs.length - 1].t * 1000 < 86_400_000 ? pairs.slice(0, -1) : pairs;
  return bars;
}