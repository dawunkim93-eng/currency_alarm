/**
 * 텔레그램 메시지 조립 (parse_mode: HTML)
 *
 * 알림은 "지금 뭘 하면 되는지"가 첫 두 줄에 나와야 한다. 폰 잠금화면 미리보기가
 * 딱 그만큼 보이기 때문이다. 근거 숫자는 그 아래로 내린다.
 */

/** 로케일마다 순서가 달라져서(31/08 vs 08/31) 조각을 직접 조립한다. */
const KST_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const KST = {
  format(date) {
    const parts = Object.fromEntries(KST_PARTS.formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  },
};

export const escapeHtml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const won = (value, digits = 2) =>
  Number(value).toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const signedPct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

export const kstTime = (ts = Date.now()) => `${KST.format(new Date(ts))} KST`;

/** 서울 기준 시각(시). 조용한 시간대 판정에 쓴다. */
export function kstHour(ts = Date.now()) {
  // hour12:false 는 자정을 "24"로 주는 구현이 있어 24로 나눈다.
  return (
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(
        new Date(ts),
      ),
    ) % 24
  );
}

export function isQuietHour(config, ts = Date.now()) {
  const quiet = config.digest?.quietHours;
  if (!quiet || quiet.from == null || quiet.to == null || quiet.from === quiet.to) return false;
  const hour = kstHour(ts);
  // 23 → 7 처럼 자정을 넘는 구간을 그대로 쓸 수 있어야 한다.
  return quiet.from < quiet.to ? hour >= quiet.from && hour < quiet.to : hour >= quiet.from || hour < quiet.to;
}

/** "1,000만원 굴리면 +42,000원" — 퍼센트만 보면 체감이 안 온다. */
export function notionalLine(valuePct, notional) {
  const gain = Math.round((notional * valuePct) / 100);
  return `${compactWon(notional)} 기준 ${gain >= 0 ? "+" : ""}${gain.toLocaleString("ko-KR")}원`;
}

export function compactWon(value) {
  if (value >= 100_000_000) return `${trim(value / 100_000_000)}억원`;
  if (value >= 10_000) return `${trim(value / 10_000)}만원`;
  return `${value.toLocaleString("ko-KR")}원`;
}

const trim = (value) => Number(value.toFixed(2)).toLocaleString("ko-KR");

function legLine(leg) {
  const unit = leg.unit === "%" ? "%" : ` ${leg.unit}`;
  const value = leg.unit === "%" ? signedPct(leg.value) : won(leg.value);
  const note = leg.note ? ` <i>(${escapeHtml(leg.note)})</i>` : "";
  return `· ${escapeHtml(leg.label)} — <b>${value}${leg.unit === "%" ? "" : unit}</b>${note}`;
}

/**
 * 급변동 신호의 `value` 는 방향을 지운 절대값이다(재알림 판단용). 화면에는
 * 부호가 살아 있는 `signed` 를 보여야 한다 — "급락"인데 +0.47% 라고 찍히면
 * 제목과 숫자가 서로 다른 말을 한다.
 *
 * 적합성 신호는 `value` 가 밴드 랭크(0~3)라 퍼센트가 아니라 점수를 보여준다.
 */
const displayValue = (signal) => signal.signed ?? signal.value;

const headValue = (signal) => {
  if (signal.kind === "suitability") return `${signal.score}/${signal.maxScore} ${signal.band}`;
  return signedPct(displayValue(signal));
};

export function signalBlock(signal, config) {
  const lines = [
    `${signal.emoji} <b>${escapeHtml(signal.title)}</b>  ${escapeHtml(headValue(signal))}`,
    escapeHtml(signal.subtitle),
    ...signal.legs.map(legLine),
  ];
  if (signal.kind === "arb" && signal.value > 0) lines.push(notionalLine(signal.value, config.notional));
  if (signal.note) lines.push(`<i>${escapeHtml(signal.note)}</i>`);
  return lines.join("\n");
}

/** 모든 메시지 아래에 붙는 시세 꼬리표. 판단 근거를 매번 같이 남긴다. */
export function marketFooter(market, quotes) {
  const forex = market.forex;
  const change =
    forex.changePct != null
      ? ` (${forex.changePrice != null ? `${forex.changePrice >= 0 ? "▲" : "▼"}${won(Math.abs(forex.changePrice))} · ` : ""}${signedPct(forex.changePct)})`
      : "";
  const lines = [
    `매매기준율 <b>${won(forex.base)}</b>${change} · ${escapeHtml(forex.provider)}`,
    quotes.exchanges.map((ex) => `${escapeHtml(ex.label)} ${won(ex.bid, 1)}/${won(ex.ask, 1)}`).join(" · "),
  ];
  if (market.jpy) {
    const yen = market.jpy;
    const jpyc = market.jpyc;
    const detail = jpyc ? `업비트 JPYC ${won(jpyc.bid, 2)}/${won(jpyc.ask, 2)}` : escapeHtml(yen.provider);
    lines.push(`엔 고시 <b>${won(yen.base, 2)}</b> · ${detail}`);
  }
  if (market.errors?.length) lines.push(`⚠️ ${escapeHtml(market.errors.join(" / "))}`);
  lines.push(kstTime(market.at));
  return lines.join("\n");
}

const RULE = "━━━━━━━━━━━━";

export function formatAlert({ signals, market, quotes, config }) {
  return [signals.map((signal) => signalBlock(signal, config)).join(`\n\n`), RULE, marketFooter(market, quotes)].join(
    "\n",
  );
}

export function formatRecovered({ signals, market, quotes }) {
  const body = signals
    .map((signal) => {
      const now = signal.kind === "suitability" ? `${signal.score}/${signal.maxScore} ${signal.band}` : signedPct(displayValue(signal));
      return `☑️ <b>${escapeHtml(signal.title)}</b> 해제 — 현재 ${escapeHtml(now)}`;
    })
    .join("\n");
  return [body, RULE, marketFooter(market, quotes)].join("\n");
}

/** 정기 요약 — 신호가 없어도 "지금 어디쯤인지"는 알고 있어야 한다. */
export function formatDigest({ signals, market, quotes, config, since }) {
  const rows = signals
    .filter((signal) => signal.kind === "arb")
    .map((signal) => {
      const mark = signal.fired ? "🔔" : signal.value >= signal.threshold - 0.1 ? "👀" : "·";
      return `${mark} ${escapeHtml(signal.title)} <b>${signedPct(signal.value)}</b> <i>(기준 ${signal.threshold}%)</i>`;
    });

  const moveSignal = signals.find((signal) => signal.id === "move");
  const suitRows = signals
    .filter((signal) => signal.kind === "suitability")
    .map((signal) => `${signal.emoji} ${escapeHtml(signal.title)} <b>${signal.score}/${signal.maxScore}</b> <i>(${escapeHtml(signal.band)})</i>`);
  const head = [`📊 <b>정기 요약</b>`, ...(since ? [`<i>직전 요약 ${kstTime(since)}</i>`] : [])];

  return [
    head.join("\n"),
    rows.join("\n"),
    moveSignal ? `${moveSignal.emoji} ${escapeHtml(moveSignal.subtitle)}` : "",
    ...suitRows,
    RULE,
    bankTable(quotes),
    RULE,
    marketFooter(market, quotes),
  ]
    .filter(Boolean)
    .join("\n");
}

export function bankTable(quotes) {
  const rows = quotes.banks.map((bank) => {
    const best = [];
    if (bank.id === quotes.bestBankBuy?.id) best.push("최저매수");
    if (bank.id === quotes.bestBankSell?.id) best.push("최고매도");
    const tag = best.length ? ` ⭐${best.join("·")}` : "";
    const manual = bank.manual ? " 📝" : "";
    return `${escapeHtml(bank.label)}${manual} 매수 ${won(bank.buy)} / 매도 ${won(bank.sell)}${tag}`;
  });
  return ["<b>은행·핀테크 (모형)</b>", ...rows].join("\n");
}

export function formatRates({ market, quotes, config, signals }) {
  const exchangeRows = quotes.exchanges.map(
    (ex) =>
      `${escapeHtml(ex.label)} 매수 ${won(ex.buyCost)} / 매도 ${won(ex.sellProceeds)} <i>(수수료 ${(ex.fee * 100).toFixed(3)}%)</i>`,
  );
  const arbRows = signals
    .filter((signal) => signal.kind === "arb")
    .map((signal) => `${signal.emoji} ${escapeHtml(signal.title)} <b>${signedPct(signal.value)}</b>`);

  // 엔화·JPYC 블록 — 데이터가 살아 있을 때만 나온다.
  const yen = quotes.yen;
  const yenRows = [];
  if (yen) {
    if (yen.bestBankBuy && yen.bestBankSell) {
      yenRows.push(
        `${escapeHtml(yen.bestBankBuy.label)} 엔 매수 ${won(yen.bestBankBuy.buy, 2)} / ${escapeHtml(yen.bestBankSell.label)} 엔 매도 ${won(yen.bestBankSell.sell, 2)} <i>(모형)</i>`,
      );
    }
    if (yen.jpyc) {
      yenRows.push(
        `업비트 JPYC 매수 ${won(yen.jpyc.buyCost, 4)} / 매도 ${won(yen.jpyc.sellProceeds, 4)} <i>(수수료 ${(yen.jpyc.fee * 100).toFixed(3)}%)</i>`,
      );
    }
  }

  return [
    "💱 <b>현재 시세</b>",
    bankTable(quotes),
    "",
    "<b>거래소 테더 (수수료 반영)</b>",
    ...exchangeRows,
    ...(yenRows.length ? ["", "<b>엔화·JPYC (수수료 반영)</b>", ...yenRows] : []),
    "",
    arbRows.join("\n"),
    RULE,
    marketFooter(market, quotes),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function formatSignals({ signals, market, quotes, config }) {
  const rows = signals.map((signal) => {
    if (signal.kind === "suitability") {
      return `${signal.emoji} <b>${escapeHtml(signal.title)}</b> ${signal.score}/${signal.maxScore} — ${escapeHtml(signal.band)} (${signal.threshold}점 이상 적합)`;
    }
    // 기준까지 남은 폭은 절대값(value)으로 재고, 보여주는 숫자는 부호를 살린다.
    const gap = signal.threshold - signal.value;
    const mark = signal.fired ? "🔔 발동" : `${gap.toFixed(2)}%p 부족`;
    return `${signal.emoji} <b>${escapeHtml(signal.title)}</b> ${signedPct(displayValue(signal))} / 기준 ${signal.threshold}% — ${mark}`;
  });
  return ["🎯 <b>트리거 현황</b>", ...rows, RULE, marketFooter(market, quotes)].join("\n");
}

/**
 * /적합 — 앱 화면처럼 기간별 3조건 O/X 표. 괄호 % 는 (현재 − 기준) ÷ 현재 × 100
 * 이고, 부호만으로도 판정이 읽힌다 (환율·강도·갭: 규칙 상이 → O/X 규칙은
 * suitability.mjs 주석 참조).
 */
export function formatSuitability({ signals }) {
  const suits = signals.filter((signal) => signal.kind === "suitability");
  if (!suits.length) {
    return "🧭 <b>매수 적합성</b>\n일별 시세를 못 받아 판정을 만들 수 없습니다. 잠시 뒤 다시 시도하세요.";
  }

  const blocks = suits.map((signal) => {
    const rows = signal.legs.length
      ? signal.legs.map((leg) => `· ${escapeHtml(leg.label)} ${leg.value}/3`)
      : [];
    return [`${signal.emoji} <b>${escapeHtml(signal.title)}</b> — ${signal.score}/${signal.maxScore} (${escapeHtml(signal.band)})`, ...rows].join(
      "\n",
    );
  });

  return [
    "🧭 <b>매수 적합성</b>",
    "<i>3조건(환율·국제강도·갭) × 4기간 = 12점. 세븐스플릿 방식, 기준값은 최저/최고 중간값·평균.</i>",
    "",
    ...blocks,
    RULE,
    "<i>갭의 O 는 환율이 오를 여지이지 보장이 아닙니다. 극단값 하루가 기준값을 좌우할 수 있습니다.</i>",
  ].join("\n");
}

export function formatConfig(config, state) {
  const thresholds = Object.entries(config.thresholds).map(
    ([key, value]) => `· thresholds.${key} = <b>${value === null ? "꺼짐" : value}</b>`,
  );
  const banks = Object.entries(config.banks).map(
    ([id, bank]) =>
      `· ${escapeHtml(bank.label)} 매수우대 ${(bank.prefBuy * 100).toFixed(0)}% / 매도우대 ${(bank.prefSell * 100).toFixed(0)}%`,
  );
  const muted = state.mutedUntil > Date.now() ? `🔕 ${kstTime(state.mutedUntil)} 까지 음소거` : "🔔 알림 켜짐";
  return [
    "⚙️ <b>설정</b>",
    muted,
    `· 기준금액 ${compactWon(config.notional)}`,
    `· 확인 주기 ${config.pollSeconds}초 · 요약 ${config.digest.everyMinutes}분`,
    `· 쿨다운 ${config.alerts.cooldownMinutes}분 · 재알림 +${config.alerts.escalationPct}%p`,
    `· 조용한 시간 ${config.digest.quietHours.from}시~${config.digest.quietHours.to}시`,
    "",
    "<b>임계값</b>",
    ...thresholds,
    "",
    "<b>우대율</b>",
    ...banks,
    "",
    "<i>바꾸기: /임계 toTetherPct 0.25 · /설정값 notional 20000000</i>",
  ].join("\n");
}

export function formatHelp() {
  return [
    "🤖 <b>환율·테더·엔화 알림 봇</b>",
    "",
    "<b>조회</b>",
    "/시세 — 은행·거래소·엔화/JPYC 현재가",
    "/신호 — 트리거별 현재 수치와 남은 폭",
    "/적합 — 달러·엔화 매수 적합성 (3조건×4기간)",
    "/설정 — 임계값·우대율 보기",
    "",
    "<b>바꾸기</b>",
    "/임계 toTetherPct 0.5 — 임계값 변경 (엔화: toJpycPct·toYenPct)",
    "/설정값 notional 20000000 — 기준금액 등 변경",
    "/설정값 alerts.escalationPct 0.5 — 재알림 폭 조절 (기본 0.1%p)",
    "/설정값 alerts.cooldownMinutes 60 — 같은 신호 재알림 간격(분)",
    "/지정가 매수 1380 · /지정가 매도 1400 · /지정가 해제",
    "/시세입력 토스 매수 1391.2 — 앱에 찍힌 실제 환율 반영 (USD 전용)",
    "/우대 스위치원 매수 0.9 — 우대율 조정",
    "",
    "<b>알림</b>",
    "/음소거 60 — 60분간 조용히",
    "/해제 — 음소거 풀기",
    "/도움 — 이 화면",
    "",
    "<i>채팅창에 / 를 치면 명령 메뉴가 뜹니다 (영문: /rate /signals …).</i>",
    "<i>은행 환율은 매매기준율 + 우대율 모형입니다. 앱 화면과 다르면 /시세입력 으로 맞추세요.</i>",
  ].join("\n");
}
