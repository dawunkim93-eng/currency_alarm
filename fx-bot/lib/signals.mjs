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
 *   엔→JPYC   : 은행에 엔 1을 판 원화로 JPYC 를 몇 개 사나 − 1
 *   JPYC→엔   : JPYC 1개를 판 원화로 엔을 몇 개 사나 − 1
 *
 * 두 값의 부호가 곧 김프/역프다. 테더가 달러보다 싸면(역프) 앞이 +,
 * 테더가 비싸면(김프) 뒤가 +. 둘 다 +면 즉시 왕복 차익이라 크게 알린다.
 * JPYC 는 원화를 경유해 갈아타므로 왕복이 성립하긴 하지만, 온체인 출금
 * 수수료·절차가 별도로 붙어 즉시 왕복 신호는 만들지 않는다.
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
  const { bestBankBuy, bestBankSell, bestExchangeBuy, bestExchangeSell, yen } = quotes;
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

  // ── 엔화·JPYC — 미러 구조. JPYC 1개는 1엔이니 단위가 그대로 맞물린다.
  // 업비트 단독 상장이라 거래소 간 비교는 없고, 왕복 신호도 만들지 않는다
  // (온체인 출금 수수료·절차가 별도라 "즉시"가 아니다).
  if (yen?.bestBankSell && yen?.jpyc) {
    const yenToJpyc = pct(yen.bestBankSell.sell / yen.jpyc.buyCost - 1);
    signals.push({
      id: "yen_to_jpyc",
      kind: "arb",
      emoji: "💴",
      title: "엔화 → JPYC 갈아타기",
      subtitle: yenToJpyc >= 0 ? "JPYC가 엔보다 싸다 (역프)" : "JPYC가 엔보다 비싸다",
      value: yenToJpyc,
      threshold: t.toJpycPct,
      fired: yenToJpyc >= t.toJpycPct,
      legs: [
        { label: `${yen.bestBankSell.label} 엔 매도`, value: yen.bestBankSell.sell, unit: "원/엔" },
        { label: `${yen.jpyc.label} JPYC 매수`, value: yen.jpyc.buyCost, unit: "원/JPYC", note: "수수료 포함" },
      ],
      note: "실현에는 온체인 출금 절차·수수료가 따로 붙는다.",
    });
  }

  if (yen?.bestBankBuy && yen?.jpyc) {
    const jpycToYen = pct(yen.jpyc.sellProceeds / yen.bestBankBuy.buy - 1);
    signals.push({
      id: "jpyc_to_yen",
      kind: "arb",
      emoji: "💴",
      title: "JPYC → 엔화 갈아타기",
      subtitle: jpycToYen >= 0 ? "JPYC가 엔보다 비싸다 (김프)" : "JPYC가 엔보다 싸다",
      value: jpycToYen,
      threshold: t.toYenPct,
      fired: jpycToYen >= t.toYenPct,
      legs: [
        { label: `${yen.jpyc.label} JPYC 매도`, value: yen.jpyc.sellProceeds, unit: "원/JPYC", note: "수수료 차감" },
        { label: `${yen.bestBankBuy.label} 엔 매수`, value: yen.bestBankBuy.buy, unit: "원/엔" },
      ],
      note: "실현에는 온체인 출금 절차·수수료가 따로 붙는다.",
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
 * 알림 판정 — 상태 **전환** 중심.
 *
 * 규칙은 셋뿐이다.
 *   1) 처음 뜬 신호는 바로 보낸다 (미발동 → 발동, 예: 김프 → 역프 전환)
 *   2) 풀린 신호는 한 번 해제 알림을 보낸다 (발동 → 미발동)
 *      단, 값이 임계 바로 아래에서 왔다갔다하면 발동↔해제가 도배된다.
 *      그래서 해제는 기준보다 `releaseMarginPct` 만큼 아래로 내려와야 확정한다 —
 *      경계 부유 구간은 조용히 유지된다.
 *   3) 발동이 오래 지속되면 `reminderHours` 마다 한 번 리마인드를 보낸다.
 *      전환이 없어도 "지금 역프 중"임을 잊지 않게 하기 위해서다.
 *
 * 예전의 쿨다운 재전송·escalation 재알림은 소음의 원인이라 없앴다. 발동이 유지
 * 되는 동안 값이 깊어져도 무음이다 — 현재 수치는 /신호 로 언제든 볼 수 있다.
 */
export function selectAlerts({ signals, state, config, now = Date.now() }) {
  const alerts = config.alerts ?? {};
  const reminderMs = (alerts.reminderHours ?? 24) * 3_600_000;
  const releaseMargin = alerts.releaseMarginPct ?? 0.05;
  const fresh = [];
  const recovered = [];
  const nextAlerts = { ...(state.alerts ?? {}) };

  for (const signal of signals) {
    const previous = nextAlerts[signal.id];

    if (signal.fired) {
      if (!previous?.active) {
        // 전환 (미발동 → 발동)
        fresh.push(signal);
        nextAlerts[signal.id] = { active: true, at: now, value: signal.value };
        continue;
      }
      if (now - (previous.at ?? now) >= reminderMs) {
        // 발동 지속 리마인드 — 전환은 아니지만 "아직 켜져 있다"를 하루 한 번 알린다.
        fresh.push({ ...signal, reminder: true });
        nextAlerts[signal.id] = { active: true, at: now, value: signal.value };
      }
      continue;
    }

    if (previous?.active) {
      // 발동 기준보다 마진만큼 아래로 내려왔을 때만 해제를 확정한다.
      const marginOk = signal.threshold == null || signal.value < signal.threshold - releaseMargin;
      if (marginOk) {
        if (config.alerts.recoverNotice) recovered.push(signal);
        nextAlerts[signal.id] = { active: false, at: now, value: signal.value };
      }
      // 마진 안(경계 부유)이면 상태를 유지한다 — 알림도 기록도 조용히.
    }
  }

  return { fresh, recovered, nextAlerts };
}

const pct = (ratio) => ratio * 100;
const fmt = (value) => value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
