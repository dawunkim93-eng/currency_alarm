/**
 * 봇 회귀 테스트 — 네트워크 없이 전부 돈다
 *
 *   npm run test-fx
 *
 * 이 봇이 틀리는 방식은 둘 뿐이다.
 *   (1) 시세를 잘못 읽는다  → parse* 함수를 실제 응답 모양 그대로 검증한다
 *   (2) 없는 차익을 있다고 한다 → 수수료·스프레드를 녹인 수익률을 손으로 계산해 맞춘다
 *
 * (2)가 특히 무섭다. 알림이 안 오면 기회를 놓칠 뿐이지만, 틀린 알림은 돈을
 * 넣게 만든다. 그래서 임계값 언저리(0.29% / 0.31%)를 일부러 찔러 본다.
 */
import assert from "node:assert/strict";
import { DEFAULTS, deepMerge, validateConfig } from "./lib/config.mjs";
import {
  parseBithumbLegacyOrderbook,
  parseCoinoneOrderbook,
  parseDunamuForex,
  parseErApi,
  parseNaverExchange,
  parseUpbitStyleOrderbook,
  parseUpbitTicker,
  parseYahooChart,
} from "./lib/sources.mjs";
import { buildQuotes, derivedSpreads } from "./lib/venues.mjs";
import { evaluate, findAnchor, selectAlerts } from "./lib/signals.mjs";
import { EMPTY_STATE, applyOverrides, getPath, pushHistory, setPath } from "./lib/state.mjs";
import { handleCommand } from "./lib/commands.mjs";
import { parseCommand, isAllowedChat } from "./lib/telegram.mjs";
import {
  compactWon,
  formatAlert,
  formatRecovered,
  formatSignals,
  isQuietHour,
  notionalLine,
} from "./lib/format.mjs";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}
const tests = [];
function asyncTest(name, fn) {
  tests.push({ name, fn });
}

// ── 픽스처: 실제 응답 모양 그대로 ──────────────────────────────────────
/** 두나무 CDN /v1/forex/recent (하나은행 고시) */
const DUNAMU = [
  {
    code: "FRX.KRWUSD",
    currencyCode: "USD",
    currencyName: "달러",
    country: "미국",
    name: "미국 (USD/KRW)",
    date: "2026-08-29",
    time: "23:59:59",
    recurrenceCount: 710,
    basePrice: 1390.5,
    openingPrice: 1392.0,
    highPrice: 1395.0,
    lowPrice: 1388.0,
    change: "FALL",
    changePrice: 2.1,
    signedChangePrice: -2.1,
    changeRate: 0.0015,
    signedChangeRate: -0.0015,
    cashBuyingPrice: 1414.83,
    cashSellingPrice: 1366.17,
    ttBuyingPrice: 1376.7,
    ttSellingPrice: 1404.3,
    provider: "하나은행",
    timestamp: 1756_500_000_000,
  },
];

const UPBIT_ORDERBOOK = [
  {
    market: "KRW-USDT",
    timestamp: 1756_500_001_000,
    total_ask_size: 12345.6,
    total_bid_size: 23456.7,
    orderbook_units: [
      { ask_price: 1383.0, bid_price: 1382.9, ask_size: 1000.0, bid_size: 2000.0 },
      { ask_price: 1383.1, bid_price: 1382.8, ask_size: 500.0, bid_size: 800.0 },
    ],
  },
];

const BITHUMB_LEGACY = {
  status: "0000",
  data: {
    timestamp: "1756500002000",
    order_currency: "USDT",
    payment_currency: "KRW",
    bids: [
      { quantity: "1500.0", price: "1382.5" },
      { quantity: "900.0", price: "1382.4" },
    ],
    asks: [
      { quantity: "1200.0", price: "1383.4" },
      { quantity: "700.0", price: "1383.5" },
    ],
  },
};

const baseConfig = () => deepMerge(DEFAULTS, { token: "t", chatIds: ["1"] });

/** 테스트용 시세 스냅샷. ask/bid 만 갈아끼우면 김프/역프 시나리오가 된다. */
function marketOf({ ask = 1383.0, bid = 1382.9, bithumb = null, base = 1390.5 } = {}) {
  const exchanges = { upbit: { ask, bid, at: 1 } };
  if (bithumb) exchanges.bithumb = bithumb;
  return {
    forex: { ...parseDunamuForex(DUNAMU), base },
    exchanges,
    errors: [],
    at: 1756_500_000_000,
  };
}

// ── 1. 시세 파싱 ──────────────────────────────────────────────────────
test("두나무 응답에서 기준율·전신환·등락을 읽는다", () => {
  const forex = parseDunamuForex(DUNAMU);
  assert.equal(forex.base, 1390.5);
  assert.equal(forex.ttSelling, 1404.3);
  assert.equal(forex.ttBuying, 1376.7);
  assert.equal(forex.provider, "하나은행");
  // signedChangeRate 는 비율(-0.0015)로 온다. 퍼센트로 바꿔 저장해야 표시가 맞는다.
  assert.ok(Math.abs(forex.changePct - -0.15) < 1e-9, `changePct=${forex.changePct}`);
});

test("basePrice 가 없으면 조용히 0 을 쓰지 않고 던진다", () => {
  assert.throws(() => parseDunamuForex([{ currencyCode: "USD" }]), /basePrice/);
});

// 아래 세 픽스처는 GitHub Actions 러너에서 실제로 받아온 응답이다
// (`node fx-bot/diagnose.mjs`, 2026-08-31). 손으로 지어낸 모양으로 검증하다
// 필드를 잘못 짚어 "값 없음"으로 돌던 적이 있어서, 원문을 그대로 박아둔다.
test("네이버 하나은행 고시에서 매매기준율을 읽는다", () => {
  const forex = parseNaverExchange({
    exchangeInfo: {
      stockExchangeType: { code: "HANA", nameKor: "하나은행", nationType: "KOR" },
      categoryType: "exchange",
      reutersCode: "FX_USDKRW",
      description: "하나은행 고시회차",
      localTradedAt: "2026-08-31T07:38:01+09:00",
      closePrice: "1,381.00", // 쉼표가 붙어 온다
      fluctuations: "-1.00",
      fluctuationsRatio: "-0.07",
      marketStatus: "OPEN",
    },
  });
  assert.equal(forex.base, 1381);
  assert.equal(forex.changePct, -0.07);
  assert.equal(forex.changePrice, -1);
  assert.match(forex.provider, /하나은행/);
  assert.equal(forex.ttSelling, null); // 전신환 고시가 없으니 스프레드는 설정값으로 메운다
});

test("야후 KRW=X 에서 시장 중간값과 등락을 읽는다", () => {
  const forex = parseYahooChart({
    chart: {
      result: [{ meta: { regularMarketPrice: 1377.66, chartPreviousClose: 1380.0, regularMarketTime: 1788131691 } }],
      error: null,
    },
  });
  assert.equal(forex.base, 1377.66);
  assert.ok(Math.abs(forex.changePct - -0.1696) < 0.001, `${forex.changePct}`);
  assert.equal(forex.source, "yahoo");
});

test("er-api 는 값만 주고 등락은 없다", () => {
  const forex = parseErApi({ result: "success", rates: { KRW: 1377.900275 }, time_last_update_unix: 1788100000 });
  assert.equal(forex.base, 1377.900275);
  assert.equal(forex.changePct, null);
});

test("환율 출처가 하나라도 값을 못 주면 던진다", () => {
  assert.throws(() => parseNaverExchange({ exchangeInfo: { closePrice: null } }), /환율/);
  assert.throws(() => parseYahooChart({ chart: { result: [] } }), /환율/);
  assert.throws(() => parseErApi({ rates: {} }), /환율/);
});

test("코인원 호가창은 {price, qty} 문자열 배열이다", () => {
  const book = parseCoinoneOrderbook({
    result: "success",
    timestamp: 1788131691211,
    asks: [{ price: "1390", qty: "1000" }],
    bids: [{ price: "1389", qty: "2000" }],
  });
  assert.equal(book.ask, 1390);
  assert.equal(book.bid, 1389);
});

test("업비트/빗썸2.0 호가창에서 최우선 호가를 고른다", () => {
  assert.deepEqual(parseUpbitStyleOrderbook(UPBIT_ORDERBOOK), { ask: 1383.0, bid: 1382.9, at: 1756_500_001_000 });
});

test("빗썸 1.0 호가창은 문자열 가격이고 asks[0]/bids[0] 가 최우선이다", () => {
  const book = parseBithumbLegacyOrderbook(BITHUMB_LEGACY);
  assert.equal(book.ask, 1383.4);
  assert.equal(book.bid, 1382.5);
});

test("빗썸이 오류 status 를 주면 던진다", () => {
  assert.throws(() => parseBithumbLegacyOrderbook({ status: "5600", message: "error" }), /5600/);
});

test("호가창이 죽으면 체결가 하나로 버틴다", () => {
  assert.deepEqual(parseUpbitTicker([{ trade_price: 1391.0, timestamp: 5 }]), { ask: 1391, bid: 1391, at: 5 });
});

// ── 2. 거래처별 적용 환율 ─────────────────────────────────────────────
test("스프레드를 전신환 고시에서 역산한다", () => {
  const spreads = derivedSpreads(parseDunamuForex(DUNAMU));
  assert.ok(Math.abs(spreads.buy - 13.8 / 1390.5) < 1e-12);
  assert.ok(Math.abs(spreads.sell - 13.8 / 1390.5) < 1e-12);
  assert.equal(spreads.derived, true);
});

test("전신환 고시가 없으면 1% 를 가정한다", () => {
  const spreads = derivedSpreads({ base: 1390.5, ttSelling: null, ttBuying: null });
  assert.equal(spreads.buy, 0.01);
  assert.equal(spreads.derived, false);
});

test("우대율 100% 면 기준율 그대로, 90% 면 스프레드의 10% 만 얹는다", () => {
  const quotes = buildQuotes({ market: marketOf(), config: baseConfig() });
  const toss = quotes.banks.find((bank) => bank.id === "toss");
  const hana = quotes.banks.find((bank) => bank.id === "hana");

  assert.equal(toss.buy, 1390.5);
  assert.equal(toss.sell, 1390.5);

  const expectedHanaBuy = 1390.5 * (1 + (13.8 / 1390.5) * 0.1);
  assert.ok(Math.abs(hana.buy - expectedHanaBuy) < 1e-9, `${hana.buy} != ${expectedHanaBuy}`);
  assert.ok(hana.sell < hana.buy, "매도가는 매수가보다 낮아야 한다");
});

test("최저 매수처·최고 매도처를 고른다", () => {
  const quotes = buildQuotes({ market: marketOf(), config: baseConfig() });
  assert.ok(quotes.banks.every((bank) => bank.buy >= quotes.bestBankBuy.buy));
  assert.ok(quotes.banks.every((bank) => bank.sell <= quotes.bestBankSell.sell));
});

test("거래소 가격에 테이커 수수료를 녹인다", () => {
  const quotes = buildQuotes({ market: marketOf(), config: baseConfig() });
  const upbit = quotes.exchanges[0];
  assert.ok(Math.abs(upbit.buyCost - 1383.0 * 1.0005) < 1e-9);
  assert.ok(Math.abs(upbit.sellProceeds - 1382.9 * 0.9995) < 1e-9);
  // 수수료를 안 녹이면 매수·매도가 뒤집혀 없는 차익이 생긴다.
  assert.ok(upbit.buyCost > upbit.sellProceeds);
});

test("수동 입력 환율이 모형을 덮어쓰고, 유효시간이 지나면 모형으로 돌아온다", () => {
  const now = 1_000_000_000;
  const manual = { switchen: { sell: 1395.0, at: now } };
  const config = baseConfig();

  const fresh = buildQuotes({ market: marketOf(), config, manualQuotes: manual, now });
  const freshSwitchen = fresh.banks.find((bank) => bank.id === "switchen");
  assert.equal(freshSwitchen.sell, 1395.0);
  assert.equal(fresh.bestBankSell.id, "switchen");

  const later = now + (config.manualQuoteTtlMinutes + 1) * 60_000;
  const stale = buildQuotes({ market: marketOf(), config, manualQuotes: manual, now: later });
  const staleSwitchen = stale.banks.find((bank) => bank.id === "switchen");
  assert.ok(staleSwitchen.sell < 1391, "유효시간이 지난 실측값은 버려야 한다");
  assert.equal(staleSwitchen.manual, null);
});

// ── 3. 신호 판정 ──────────────────────────────────────────────────────
function evaluateWith({ market, config = baseConfig(), history = [], now = 2_000_000_000, manualQuotes = {} }) {
  const quotes = buildQuotes({ market, config, manualQuotes, now });
  const signals = evaluate({ market, quotes, config, history, now });
  return Object.fromEntries(signals.map((signal) => [signal.id, signal]));
}

test("역프(테더가 쌀 때) — 달러→테더만 발동한다", () => {
  const signals = evaluateWith({ market: marketOf({ ask: 1383.0, bid: 1382.9 }) });
  // 1390.5 / (1383.0 × 1.0005) − 1 = +0.4922%
  assert.ok(Math.abs(signals.to_tether.value - 0.4922) < 0.001, `${signals.to_tether.value}`);
  assert.equal(signals.to_tether.fired, true);
  assert.equal(signals.to_dollar.fired, false);
  assert.equal(signals.round_trip.fired, false);
});

test("김프(테더가 비쌀 때) — 테더→달러만 발동한다", () => {
  const signals = evaluateWith({ market: marketOf({ ask: 1400.5, bid: 1400.4 }) });
  // 1400.4 × 0.9995 / 1390.5 − 1 = +0.6616%
  assert.ok(Math.abs(signals.to_dollar.value - 0.6616) < 0.001, `${signals.to_dollar.value}`);
  assert.equal(signals.to_dollar.fired, true);
  assert.equal(signals.to_tether.fired, false);
});

test("가격이 붙어 있으면 아무것도 발동하지 않는다", () => {
  const signals = evaluateWith({ market: marketOf({ ask: 1391.0, bid: 1390.9 }) });
  assert.equal(signals.to_tether.fired, false);
  assert.equal(signals.to_dollar.fired, false);
  assert.ok(signals.to_tether.value < 0 && signals.to_dollar.value < 0, "수수료·스프레드 때문에 둘 다 음수여야 한다");
});

test("임계값 언저리 — 0.29% 는 안 울리고 0.31% 는 울린다", () => {
  // 목표 수익률 r 을 만드는 ask: bankSell / (ask × (1+fee)) − 1 = r
  const askFor = (r) => 1390.5 / (1 + r / 100) / 1.0005;
  const below = evaluateWith({ market: marketOf({ ask: askFor(0.29), bid: 1382 }) });
  const above = evaluateWith({ market: marketOf({ ask: askFor(0.31), bid: 1382 }) });
  assert.equal(below.to_tether.fired, false, `아래쪽 ${below.to_tether.value}`);
  assert.equal(above.to_tether.fired, true, `위쪽 ${above.to_tether.value}`);
});

test("같은 은행이 최저매수이자 최고매도면 은행 간 차익 신호를 만들지 않는다", () => {
  const signals = evaluateWith({ market: marketOf() });
  assert.equal(signals.bank_gap, undefined);
});

test("실측 입력으로 은행이 갈리면 은행 간 차익이 잡힌다", () => {
  const now = 3_000_000_000;
  const signals = evaluateWith({
    market: marketOf(),
    now,
    manualQuotes: { switchen: { sell: 1395.0, at: now } },
  });
  // 1395 / 1390.5 − 1 = +0.3236% ≥ 0.2%
  assert.ok(Math.abs(signals.bank_gap.value - 0.3236) < 0.001, `${signals.bank_gap.value}`);
  assert.equal(signals.bank_gap.fired, true);
});

test("거래소가 둘일 때 교차 차익을 잡는다", () => {
  const market = marketOf({ ask: 1383.0, bid: 1382.9, bithumb: { ask: 1390.0, bid: 1389.5 } });
  const signals = evaluateWith({ market });
  // 빗썸 매도 1389.5×0.9996 = 1388.944 / 업비트 매수 1383.0×1.0005 = 1383.6915 → +0.3796%
  assert.ok(Math.abs(signals.exchange_gap.value - 0.3796) < 0.002, `${signals.exchange_gap.value}`);
  assert.equal(signals.exchange_gap.fired, true);
});

test("지정가는 설정했을 때만 생기고, 도달하면 발동한다", () => {
  const off = evaluateWith({ market: marketOf() });
  assert.equal(off.level_buy, undefined);

  const config = deepMerge(baseConfig(), { thresholds: { usdBuyBelow: 1395, usdSellAbove: 1400 } });
  const on = evaluateWith({ market: marketOf(), config });
  assert.equal(on.level_buy.fired, true, "최저 매수 1390.5 는 1395 아래");
  assert.equal(on.level_sell.fired, false, "최고 매도 1390.5 는 1400 아래");
});

test("급변동은 창 안의 가장 오래된 기록과 비교한다", () => {
  const now = 2_000_000_000;
  const history = [
    { t: now - 90 * 60_000, base: 1300 }, // 창(30분) 밖 — 무시돼야 한다
    { t: now - 25 * 60_000, base: 1385 },
    { t: now - 10 * 60_000, base: 1388 },
  ];
  const signals = evaluateWith({ market: marketOf(), history, now });
  // 1390.5 / 1385 − 1 = +0.397% → 기본 임계 0.4% 에 아슬하게 못 미친다
  assert.ok(Math.abs(signals.move.value - 0.397) < 0.002, `${signals.move.value}`);
  assert.equal(signals.move.fired, false);

  const looser = deepMerge(baseConfig(), { thresholds: { movePct: 0.3 } });
  assert.equal(evaluateWith({ market: marketOf(), history, now, config: looser }).move.fired, true);
});

test("급락도 같은 크기로 잡고 방향은 부호로 남긴다", () => {
  const now = 2_000_000_000;
  const history = [
    { t: now - 20 * 60_000, base: 1400 },
    { t: now - 5 * 60_000, base: 1395 },
  ];
  const signals = evaluateWith({ market: marketOf(), history, now });
  assert.ok(signals.move.signed < 0);
  assert.ok(signals.move.value > 0, "재알림 판단은 절대값으로 한다");
  assert.equal(signals.move.fired, true); // 1390.5/1400 − 1 = −0.679%
  assert.equal(signals.move.emoji, "📉");
});

test("기록이 하나뿐이면 급변동을 판단하지 않는다", () => {
  const now = 2_000_000_000;
  assert.equal(findAnchor([{ t: now - 60_000, base: 1385 }], now, 30), null);
  assert.equal(evaluateWith({ market: marketOf(), history: [{ t: now - 60_000, base: 1385 }], now }).move, undefined);
});

// ── 4. 쿨다운·재알림 ──────────────────────────────────────────────────
const fakeSignal = (value, fired = true) => [{ id: "to_tether", value, fired }];

test("처음 뜬 신호는 바로 보낸다", () => {
  const { fresh, nextAlerts } = selectAlerts({
    signals: fakeSignal(0.5),
    state: { ...EMPTY_STATE },
    config: baseConfig(),
    now: 1000,
  });
  assert.equal(fresh.length, 1);
  assert.equal(nextAlerts.to_tether.active, true);
});

test("쿨다운 안에서 비슷한 값이면 조용히 넘어간다", () => {
  const state = { ...EMPTY_STATE, alerts: { to_tether: { active: true, at: 1000, value: 0.5 } } };
  const { fresh } = selectAlerts({
    signals: fakeSignal(0.55),
    state,
    config: baseConfig(),
    now: 1000 + 5 * 60_000,
  });
  assert.equal(fresh.length, 0);
});

test("쿨다운 중이라도 0.1%p 더 좋아지면 다시 알린다", () => {
  const state = { ...EMPTY_STATE, alerts: { to_tether: { active: true, at: 1000, value: 0.5 } } };
  const { fresh } = selectAlerts({
    signals: fakeSignal(0.61),
    state,
    config: baseConfig(),
    now: 1000 + 60_000,
  });
  assert.equal(fresh.length, 1, "0.5 → 0.61 은 재알림 대상");
});

test("쿨다운이 지나면 같은 값이어도 다시 알린다", () => {
  const state = { ...EMPTY_STATE, alerts: { to_tether: { active: true, at: 1000, value: 0.5 } } };
  const { fresh } = selectAlerts({
    signals: fakeSignal(0.5),
    state,
    config: baseConfig(),
    now: 1000 + 31 * 60_000,
  });
  assert.equal(fresh.length, 1);
});

test("신호가 풀리면 해제 알림을 한 번 보내고 다시 보내지 않는다", () => {
  const state = { ...EMPTY_STATE, alerts: { to_tether: { active: true, at: 1000, value: 0.5 } } };
  const first = selectAlerts({ signals: fakeSignal(0.1, false), state, config: baseConfig(), now: 2000 });
  assert.equal(first.recovered.length, 1);
  assert.equal(first.nextAlerts.to_tether.active, false);

  const second = selectAlerts({
    signals: fakeSignal(0.1, false),
    state: { ...state, alerts: first.nextAlerts },
    config: baseConfig(),
    now: 3000,
  });
  assert.equal(second.recovered.length, 0);
});

// ── 5. 상태 ───────────────────────────────────────────────────────────
test("기록은 24시간까지만 남긴다", () => {
  const now = 100 * 86_400_000;
  const history = pushHistory([{ t: now - 25 * 3_600_000, base: 1300 }], { t: now, base: 1390 }, now);
  assert.equal(history.length, 1);
  assert.equal(history[0].base, 1390);
});

test("점 경로로 설정을 읽고 쓴다", () => {
  const next = setPath({ thresholds: { toTetherPct: 0.3 } }, "thresholds.toTetherPct", 0.25);
  assert.equal(getPath(next, "thresholds.toTetherPct"), 0.25);
  assert.equal(getPath(setPath({}, "a.b.c", 1), "a.b.c"), 1);
});

test("텔레그램에서 바꾼 값이 설정 파일 위에 얹힌다", () => {
  const merged = applyOverrides(baseConfig(), { overrides: { thresholds: { toTetherPct: 0.15 } } });
  assert.equal(merged.thresholds.toTetherPct, 0.15);
  assert.equal(merged.thresholds.toDollarPct, 0.3, "건드리지 않은 값은 그대로여야 한다");
});

// ── 6. 설정 검증 ──────────────────────────────────────────────────────
test("퍼센트와 비율을 헷갈린 설정을 잡는다", () => {
  assert.ok(validateConfig(deepMerge(baseConfig(), { thresholds: { toTetherPct: 30 } })).length, "30% 는 실수다");
  assert.ok(validateConfig(deepMerge(baseConfig(), { exchanges: { upbit: { takerFee: 0.05 } } })).length, "5% 수수료");
  assert.ok(validateConfig(deepMerge(baseConfig(), { banks: { toss: { prefBuy: 90 } } })).length, "우대율 90");
  assert.equal(validateConfig(baseConfig()).length, 0, "기본값은 통과해야 한다");
});

test("토큰·챗ID 가 없으면 켜지지 않는다", () => {
  assert.ok(validateConfig({ ...DEFAULTS, token: "", chatIds: [] }).length >= 2);
});

// ── 7. 표시 ───────────────────────────────────────────────────────────
test("조용한 시간은 자정을 넘어도 이어진다", () => {
  const config = baseConfig(); // 23시 ~ 7시
  const at = (hour) => Date.UTC(2026, 7, 30, hour - 9, 0, 0); // KST = UTC+9
  assert.equal(isQuietHour(config, at(23)), true);
  assert.equal(isQuietHour(config, at(2)), true);
  assert.equal(isQuietHour(config, at(7)), false);
  assert.equal(isQuietHour(config, at(15)), false);
});

test("급락 알림은 제목과 숫자가 같은 말을 한다", () => {
  // value 는 재알림 판단용 절대값이라, 그대로 찍으면 "급락 +0.47%" 가 된다.
  const now = 2_000_000_000;
  const history = [
    { t: now - 30 * 60_000, base: 1390.5 },
    { t: now - 10 * 60_000, base: 1388.0 },
  ];
  const market = marketOf({ base: 1384.0 });
  const config = baseConfig();
  const quotes = buildQuotes({ market, config, now });
  const move = evaluate({ market, quotes, config, history, now }).find((signal) => signal.id === "move");

  assert.equal(move.fired, true);
  const text = formatAlert({ signals: [move], market, quotes, config });
  assert.match(text, /급락<\/b>\s+-0\.47%/, text.split("\n")[0]);
  assert.doesNotMatch(text.split("\n")[0], /\+/);
  // 해제·현황 표시도 같은 규칙을 따라야 한다.
  assert.match(formatRecovered({ signals: [move], market, quotes }), /-0\.47%/);
  assert.match(formatSignals({ signals: [move], market, quotes, config }), /-0\.47%/);
});

test("금액 환산이 사람 말로 나온다", () => {
  assert.equal(compactWon(10_000_000), "1,000만원");
  assert.equal(compactWon(150_000_000), "1.5억원");
  assert.equal(notionalLine(0.42, 10_000_000), "1,000만원 기준 +42,000원");
});

// ── 8. 텔레그램 명령 ──────────────────────────────────────────────────
test("명령을 파싱하고 남의 챗은 무시한다", () => {
  assert.deepEqual(parseCommand("/임계 toTetherPct 0.25"), { name: "임계", args: ["toTetherPct", "0.25"] });
  assert.deepEqual(parseCommand("/rate@my_fx_bot"), { name: "rate", args: [] });
  assert.equal(parseCommand("안녕"), null);
  assert.equal(isAllowedChat({ chat: { id: 123 } }, ["123"]), true);
  assert.equal(isAllowedChat({ chat: { id: 999 } }, ["123"]), false);
});

const run = (text, state = { ...EMPTY_STATE }, config = baseConfig(), now = 1_000_000) =>
  handleCommand({
    command: parseCommand(text),
    state,
    config,
    snapshot: async () => {
      throw new Error("이 명령은 시세를 받아오면 안 된다");
    },
    now,
  });

asyncTest("/임계 는 값을 바꾸고, 모르는 키는 거절한다", async () => {
  const ok = await run("/임계 toTetherPct 0.25");
  assert.equal(ok.state.overrides.thresholds.toTetherPct, 0.25);

  const bad = await run("/임계 없는키 0.25");
  assert.match(bad.reply, /모르는 임계값/);
  assert.deepEqual(bad.state.overrides, {});
});

asyncTest("/임계 는 말도 안 되는 값을 저장하지 않는다", async () => {
  const result = await run("/임계 toTetherPct 30");
  assert.match(result.reply, /적용하지 않았습니다/);
  assert.deepEqual(result.state.overrides, {});
});

asyncTest("/지정가 매수·해제", async () => {
  const set = await run("/지정가 매수 1,380");
  assert.equal(set.state.overrides.thresholds.usdBuyBelow, 1380);

  const cleared = await run("/지정가 해제", set.state);
  assert.equal(cleared.state.overrides.thresholds.usdBuyBelow, null);
  assert.equal(cleared.state.overrides.thresholds.usdSellAbove, null);
});

asyncTest("/시세입력 은 별칭을 알아듣고 시각을 남긴다", async () => {
  const result = await run("/시세입력 토스 매도 1391.2", { ...EMPTY_STATE }, baseConfig(), 555);
  assert.deepEqual(result.state.manualQuotes.toss, { sell: 1391.2, at: 555 });
  assert.match(result.reply, /토스뱅크/);
});

asyncTest("/우대 는 90 도 0.9 로 알아듣는다", async () => {
  const result = await run("/우대 스위치원 매수 90");
  assert.equal(result.state.overrides.banks.switchen.prefBuy, 0.9);
});

asyncTest("/음소거 와 /해제", async () => {
  const muted = await run("/음소거 30", { ...EMPTY_STATE }, baseConfig(), 1_000_000);
  assert.equal(muted.state.mutedUntil, 1_000_000 + 30 * 60_000);
  const unmuted = await run("/해제", muted.state);
  assert.equal(unmuted.state.mutedUntil, 0);
});

asyncTest("/시세 는 시세를 받아 표를 만든다", async () => {
  const now = 4_000_000_000;
  const market = marketOf({ bithumb: { ask: 1384.0, bid: 1383.5 } });
  const config = baseConfig();
  const quotes = buildQuotes({ market, config, now });
  const result = await handleCommand({
    command: parseCommand("/시세"),
    state: { ...EMPTY_STATE },
    config,
    snapshot: async () => ({ market, quotes, signals: evaluate({ market, quotes, config, now }) }),
    now,
  });
  assert.match(result.reply, /현재 시세/);
  assert.match(result.reply, /업비트/);
  assert.match(result.reply, /달러 → 테더/);
});

asyncTest("모르는 명령에는 안내를 준다", async () => {
  assert.match((await run("/없는명령")).reply, /모르는 명령/);
});

// ── 실행 ──────────────────────────────────────────────────────────────
const asyncFailures = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    asyncFailures.push({ name, error });
  }
}
failures.push(...asyncFailures);

for (const { name, error } of failures) {
  console.error(`✗ ${name}\n  ${error.message.split("\n")[0]}`);
}
console.log(`\n${passed}개 통과, ${failures.length}개 실패`);
process.exit(failures.length ? 1 : 0);
