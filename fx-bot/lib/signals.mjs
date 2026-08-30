/**
 * 트리거 판정 — 순수 함수
 *
 * 여기가 봇의 핵심이다. 네트워크도 상태 저장도 건드리지 않아서
 * `npm run test-fx` 로 전부 검증한다.
 *
 * 모든 신호의 `value` 는 **퍼센트**로 정규화한다. 그래야 "직전 알림보다
 * 0.1%p 더 좋아지면 다시 알린다" 같은 재알림 규칙을 신호 종류에 상관없이
 * 한 줄로 쓸 수 있다.
 *
 * 수익률 정의 (수수료·스프레드를 다 녹인 뒤)
 *   달러→테더 : 은행에 달러 1을 판 원화로 테더를 몇 개 사나 − 1
 *   테더→달러 : 테더 1개를 판 원화로 달러를 몇 개 사나 − 1
 *
 * 두 값의 부호가 곧 김프/역프다. 테더가 달러보다 싸면(역프) 앞이 +,
 * 테더가 비싸면(김프) 뒤가 +. 둘 다 +면 즉시 왕복 차익이라 크게 알린다.
 */

/** 창(window) 안에서 가장 오래된 기록을 찾는다. 없으면 null — 봇을 막 켠 직후가 그렇다. */
export function findAnchor(history, now, windowMinutes) {
  const from = now - windowMinutes * 60_000;
  const inWindow = history.filter((point) => point.t >= from);
  return inWindow.length >= 2 ? inWindow[0] : null;
}

export function evaluate({ market, quotes, config, history = [], now = Date.now() }) {
  const t = config.thresholds;
  const signals = [];
  const { bestBankBuy, bestBankSell, bestExchangeBuy, bestExchangeSell } = quotes;
  const base = market.forex.base;

  const toTether =
    bestBankSell && bestExchangeBuy ? pct(bestBankSell.sell / bestExchangeBuy.buyCost - 1) : null;
  const toDollar =
    bestExchangeSell && bestBankBuy ? pct(bestExchangeSell.sellProceeds / bestBankBuy.buy - 1) : null;

  if (toTether != null) {
    signals.push({
      id: "to_tether",
      kind: "arb",
      emoji: "🔵",
      title: "달러 → 테더 갈아타기",
      subtitle: toTether >= 0 ? "테더가 달러보다 싸다 (역프)" : "테더가 달러보다 비싸다",
      value: toTether,
      threshold: t.toTetherPct,
      fired: toTether >= t.toTetherPct,
      legs: [
        { label: `${bestBankSell.label} 달러 매도`, value: bestBankSell.sell, unit: "원/$" },
        { label: `${bestExchangeBuy.label} 테더 매수`, value: bestExchangeBuy.buyCost, unit: "원/USDT", note: "수수료 포함" },
      ],
    });
  }

  if (toDollar != null) {
    signals.push({
      id: "to_dollar",
      kind: "arb",
      emoji: "🟠",
      title: "테더 → 달러 갈아타기",
      subtitle: toDollar >= 0 ? "테더가 달러보다 비싸다 (김프)" : "테더가 달러보다 싸다",
      value: toDollar,
      threshold: t.toDollarPct,
      fired: toDollar >= t.toDollarPct,
      legs: [
        { label: `${bestExchangeSell.label} 테더 매도`, value: bestExchangeSell.sellProceeds, unit: "원/USDT", note: "수수료 차감" },
        { label: `${bestBankBuy.label} 달러 매수`, value: bestBankBuy.buy, unit: "원/$" },
      ],
    });
  }

  // 두 다리가 동시에 열리는 경우. 시장이 정상이면 음수라 거의 안 뜬다 —
  // 뜬다면 스프레드 설정이 현실과 어긋났을 가능성부터 의심하는 게 맞다.
  if (toTether != null && toDollar != null) {
    const roundTrip = toTether + toDollar;
    signals.push({
      id: "round_trip",
      kind: "arb",
      emoji: "🟣",
      title: "즉시 왕복 차익",
      subtitle: "달러 → 테더 → 달러 한 바퀴",
      value: roundTrip,
      threshold: t.roundTripPct,
      fired: roundTrip >= t.roundTripPct,
      legs: [
        { label: "달러→테더", value: toTether, unit: "%" },
        { label: "테더→달러", value: toDollar, unit: "%" },
      ],
      note: "설정한 우대율이 실제와 맞는지 먼저 확인하세요.",
    });
  }

  if (quotes.banks.length >= 2 && bestBankBuy.id !== bestBankSell.id) {
    const gap = pct(bestBankSell.sell / bestBankBuy.buy - 1);
    signals.push({
      id: "bank_gap",
      kind: "arb",
      emoji: "🏦",
      title: "은행 간 환율 차이",
      subtitle: `${bestBankBuy.label} 매수 ↔ ${bestBankSell.label} 매도`,
      value: gap,
      threshold: t.bankGapPct,
      fired: gap >= t.bankGapPct,
      legs: [
        { label: `${bestBankBuy.label} 매수`, value: bestBankBuy.buy, unit: "원/$" },
        { label: `${bestBankSell.label} 매도`, value: bestBankSell.sell, unit: "원/$" },
      ],
    });
  }

  if (quotes.exchanges.length >= 2 && bestExchangeBuy.id !== bestExchangeSell.id) {
    const gap = pct(bestExchangeSell.sellProceeds / bestExchangeBuy.buyCost - 1);
    signals.push({
      id: "exchange_gap",
      kind: "arb",
      emoji: "⚖️",
      title: "거래소 간 테더 가격차",
      subtitle: `${bestExchangeBuy.label} 매수 ↔ ${bestExchangeSell.label} 매도`,
      value: gap,
      threshold: t.exchangeGapPct,
      fired: gap >= t.exchangeGapPct,
      legs: [
        { label: `${bestExchangeBuy.label} 매수`, value: bestExchangeBuy.buyCost, unit: "원/USDT" },
        { label: `${bestExchangeSell.label} 매도`, value: bestExchangeSell.sellProceeds, unit: "원/USDT" },
      ],
      note: "거래소 간 이동은 전송 시간·출금 수수료가 붙습니다.",
    });
  }

  if (typeof t.usdBuyBelow === "number" && bestBankBuy) {
    const gap = pct((t.usdBuyBelow - bestBankBuy.buy) / t.usdBuyBelow);
    signals.push({
      id: "level_buy",
      kind: "level",
      emoji: "🟢",
      title: "지정가 도달 — 달러 매수",
      subtitle: `${fmt(t.usdBuyBelow)}원 아래`,
      value: gap,
      threshold: 0,
      fired: bestBankBuy.buy <= t.usdBuyBelow,
      legs: [{ label: `${bestBankBuy.label} 매수`, value: bestBankBuy.buy, unit: "원/$" }],
    });
  }

  if (typeof t.usdSellAbove === "number" && bestBankSell) {
    const gap = pct((bestBankSell.sell - t.usdSellAbove) / t.usdSellAbove);
    signals.push({
      id: "level_sell",
      kind: "level",
      emoji: "🔴",
      title: "지정가 도달 — 달러 매도",
      subtitle: `${fmt(t.usdSellAbove)}원 위`,
      value: gap,
      threshold: 0,
      fired: bestBankSell.sell >= t.usdSellAbove,
      legs: [{ label: `${bestBankSell.label} 매도`, value: bestBankSell.sell, unit: "원/$" }],
    });
  }

  const anchor = findAnchor(history, now, t.moveWindowMinutes);
  if (anchor?.base) {
    const move = pct(base / anchor.base - 1);
    const minutes = Math.max(1, Math.round((now - anchor.t) / 60_000));
    signals.push({
      id: "move",
      kind: "move",
      emoji: move >= 0 ? "📈" : "📉",
      title: `환율 급${move >= 0 ? "등" : "락"}`,
      subtitle: `최근 ${minutes}분 ${move >= 0 ? "+" : ""}${move.toFixed(2)}%`,
      // 방향과 무관하게 "얼마나 크게 움직였나"로 재알림을 판단한다.
      value: Math.abs(move),
      signed: move,
      threshold: t.movePct,
      fired: Math.abs(move) >= t.movePct,
      legs: [
        { label: `${minutes}분 전 기준율`, value: anchor.base, unit: "원/$" },
        { label: "현재 기준율", value: base, unit: "원/$" },
      ],
    });
  }

  return signals;
}

/**
 * 쿨다운·재알림 판정.
 *
 * 규칙은 셋뿐이다.
 *   1) 처음 뜬 신호는 바로 보낸다
 *   2) 쿨다운이 지났으면 다시 보낸다
 *   3) 쿨다운 중이라도 직전 알림보다 `escalationPct`(%p) 더 좋아졌으면 보낸다
 *
 * 3번이 없으면 0.3%에서 알림 한 번 받고 0.9%까지 벌어지는 걸 놓친다.
 */
export function selectAlerts({ signals, state, config, now = Date.now() }) {
  const cooldownMs = config.alerts.cooldownMinutes * 60_000;
  const escalation = config.alerts.escalationPct;
  const fresh = [];
  const recovered = [];
  const nextAlerts = { ...(state.alerts ?? {}) };

  for (const signal of signals) {
    const previous = nextAlerts[signal.id];

    if (signal.fired) {
      const first = !previous?.active;
      const cooledDown = previous ? now - previous.at >= cooldownMs : true;
      const escalated = previous ? signal.value >= previous.value + escalation : true;
      if (first || cooledDown || escalated) {
        fresh.push(signal);
        nextAlerts[signal.id] = { active: true, at: now, value: signal.value };
      }
      continue;
    }

    if (previous?.active) {
      if (config.alerts.recoverNotice) recovered.push(signal);
      nextAlerts[signal.id] = { active: false, at: now, value: signal.value };
    }
  }

  return { fresh, recovered, nextAlerts };
}

const pct = (ratio) => ratio * 100;
const fmt = (value) => value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
