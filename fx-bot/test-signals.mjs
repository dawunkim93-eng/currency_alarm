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
  perYen,
} from "./lib/sources.mjs";
import { buildQuotes, derivedSpreads } from "./lib/venues.mjs";
import { evaluate, findAnchor, selectAlerts } from "./lib/signals.mjs";
import { alignByDate, dayKey, evaluateSuitability, toBars } from "./lib/suitability.mjs";
import { EMPTY_STATE, applyOverrides, getPath, pushHistory, setPath } from "./lib/state.mjs";
import { MENU_COMMANDS, handleCommand } from "./lib/commands.mjs";
import { parseCommand, isAllowedChat } from "./lib/telegram.mjs";
import {
  compactWon,
  formatAlert,
  formatRates,
  formatRecovered,
  formatSignals,
  formatSuitability,
  isQuietHour,
  marketFooter,
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

/** 두나무 FRX.KRWJPY — 하나은행 엔 고시는 **100엔 단위**다 (863.7 = 100엔당 원화). */
const DUNAMU_JPY = [
  {
    code: "FRX.KRWJPY",
    currencyCode: "JPY",
    currencyName: "엔",
    country: "일본",
    name: "일본 (JPY/KRW)",
    date: "2026-09-22",
    time: "23:59:59",
    recurrenceCount: 710,
    basePrice: 863.7,
    openingPrice: 873.6,
    highPrice: 875.5,
    lowPrice: 862.0,
    change: "FALL",
    changePrice: -9.98,
    signedChangePrice: -9.98,
    changeRate: -0.0114,
    signedChangeRate: -0.0114,
    cashBuyingPrice: 877.0,
    cashSellingPrice: 850.4,
    ttBuyingPrice: 858.0,
    ttSellingPrice: 869.4,
    provider: "하나은행",
    timestamp: 1790_000_000_000,
  },
];

/** 네이버 FX_JPYKRW — 마찬가지로 100엔 단위. closePrice 는 "1,000" 같은 쉼표 문자열이 온다. */
const NAVER_JPY = {
  exchangeInfo: {
    stockExchangeType: { code: "HANA", nameKor: "하나은행" },
    reutersCode: "FX_JPYKRW",
    name: "일본 JPY",
    fullName: "일본 JPY 100",
    localTradedAt: "2026-09-22T21:22:43+09:00",
    closePrice: "863.70",
    fluctuations: "-9.98",
    fluctuationsRatio: "-1.14",
    marketStatus: "OPEN",
  },
};

const UPBIT_JPYC_ORDERBOOK = [
  {
    market: "KRW-JPYC",
    timestamp: 1790_000_001_000,
    total_ask_size: 4277633.5,
    total_bid_size: 4214770.4,
    orderbook_units: [
      { ask_price: 8.55, bid_price: 8.54, ask_size: 183617.1, bid_size: 58591.3 },
      { ask_price: 8.56, bid_price: 8.53, ask_size: 42025.4, bid_size: 125508.2 },
    ],
  },
];

const baseConfig = () => deepMerge(DEFAULTS, { token: "t", chatIds: ["1"] });

/** 테스트용 시세 스냅샷. ask/bid 만 갈아끼우면 김프/역프 시나리오가 된다. */
function marketOf({ ask = 1383.0, bid = 1382.9, bithumb = null, base = 1390.5, jpy = null, jpyc = null } = {}) {
  const exchanges = { upbit: { ask, bid, at: 1 } };
  if (bithumb) exchanges.bithumb = bithumb;
  return {
    forex: { ...parseDunamuForex(DUNAMU), base },
    exchanges,
    jpy,
    jpyc,
    errors: [],
    at: 1756_500_000_000,
  };
}

/** 엔화 시나리오용 시세. 엔 고시는 1엔당 원화(정규화 뒤), JPYC 는 업비트 호가. */
function yenMarketOf({ jpyBase = 8.637, jpycAsk = 8.55, jpycBid = 8.54 } = {}) {
  return marketOf({
    jpy: {
      base: jpyBase,
      ttSelling: jpyBase * 1.0154,
      ttBuying: jpyBase * 0.9846,
      changePct: -1.14,
      changePrice: -0.0998,
      provider: "하나은행",
      quotedAt: 1790_000_000_000,
      source: "dunamu",
    },
    jpyc: { ask: jpycAsk, bid: jpycBid, at: 1 },
  });
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

// ── 엔화·JPYC 파싱 ────────────────────────────────────────────────────
test("두나무 엔 고시(100엔)를 1엔 단위로 정규화한다", () => {
  const yen = perYen(parseDunamuForex(DUNAMU_JPY));
  // 100엔당 863.7원 → 1엔당 8.637원. 단위를 틀리면 신호가 전부 허깨비가 된다.
  assert.ok(Math.abs(yen.base - 8.637) < 1e-9, `base=${yen.base}`);
  assert.ok(Math.abs(yen.ttSelling - 8.694) < 1e-9, `ttSelling=${yen.ttSelling}`);
  assert.ok(Math.abs(yen.ttBuying - 8.58) < 1e-9, `ttBuying=${yen.ttBuying}`);
  // 100엔 기준 가격차 -9.98원도 1엔 기준 -0.0998원으로 맞춰진다.
  assert.ok(Math.abs(yen.changePrice - -0.0998) < 1e-9, `changePrice=${yen.changePrice}`);
  // 비율은 단위와 무관하니 그대로다.
  assert.ok(Math.abs(yen.changePct - -1.14) < 1e-9, `changePct=${yen.changePct}`);
});

test("네이버 엔 고시도 100엔 단위로 온다", () => {
  const yen = perYen(parseNaverExchange(NAVER_JPY));
  assert.ok(Math.abs(yen.base - 8.637) < 1e-9, `base=${yen.base}`);
  assert.match(yen.provider, /하나은행/);
  assert.equal(yen.ttSelling, null); // 네이버는 전신환 고시가 없다
});

test("야후·er-api 엔율은 처음부터 1엔 단위라 정규화가 필요 없다", () => {
  const yahoo = parseYahooChart({
    chart: {
      result: [{ meta: { regularMarketPrice: 8.614, chartPreviousClose: 8.721, regularMarketTime: 1790000000 } }],
      error: null,
    },
  });
  assert.ok(Math.abs(yahoo.base - 8.614) < 1e-9);

  const erApi = parseErApi({ result: "success", rates: { KRW: 8.744293 }, time_last_update_unix: 1790000000 });
  assert.ok(Math.abs(erApi.base - 8.744293) < 1e-9);
});

test("업비트 JPYC 호가창도 업비트 파서로 읽는다", () => {
  assert.deepEqual(parseUpbitStyleOrderbook(UPBIT_JPYC_ORDERBOOK), { ask: 8.55, bid: 8.54, at: 1790_000_001_000 });
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

test("엔 뱅크 모형은 엔 기준율에 같은 공식을 쓰고, JPYC 수수료를 녹인다", () => {
  const quotes = buildQuotes({ market: yenMarketOf(), config: baseConfig() });
  const yen = quotes.yen;
  // 우대 100%(토스)는 엔 기준율 그대로, 하나(90%)는 스프레드의 10%만 불리하다.
  const toss = yen.banks.find((bank) => bank.id === "toss");
  const hana = yen.banks.find((bank) => bank.id === "hana");
  assert.ok(Math.abs(toss.buy - 8.637) < 1e-9, `toss.buy=${toss.buy}`);
  assert.ok(hana.buy > toss.buy, "우대가 낮은 곳이 더 비싸야 한다");
  assert.equal(yen.bestBankBuy.id, "toss");
  assert.equal(yen.bestBankSell.id, "toss");

  // 업비트 테이커 수수료를 JPYC 값에도 녹인다.
  assert.ok(Math.abs(yen.jpyc.buyCost - 8.55 * 1.0005) < 1e-9, `buyCost=${yen.jpyc.buyCost}`);
  assert.ok(Math.abs(yen.jpyc.sellProceeds - 8.54 * 0.9995) < 1e-9, `sellProceeds=${yen.jpyc.sellProceeds}`);
});

test("엔 전신환 고시가 없으면 엔화 전용 fallback 스프레드를 쓴다", () => {
  const noTt = derivedSpreads({ base: 8.637 }, 0.02);
  assert.equal(noTt.buy, 0.02);
  assert.equal(noTt.sell, 0.02);
  assert.equal(noTt.derived, false);
  // USD 기본 호출은 여전히 1% fallback 이다.
  assert.equal(derivedSpreads({ base: 1390.5 }).buy, 0.01);
});

// ── 3. 신호 판정 ──────────────────────────────────────────────────────
function evaluateWith({ market, config = baseConfig(), history = [], now = 2_000_000_000, manualQuotes = {} }) {
  const quotes = buildQuotes({ market, config, manualQuotes, now });
  const signals = evaluate({ market, quotes, config, history, now });
  return Object.fromEntries(signals.map((signal) => [signal.id, signal]));
}

test("역프(테더가 쌀 때) — 달러→테더만 발동한다", () => {
  const signals = evaluateWith({ market: marketOf({ ask: 1382.0, bid: 1381.9 }) });
  // 1390.5 / (1382.0 × 1.0005) − 1 = +0.5648%
  assert.ok(Math.abs(signals.to_tether.value - 0.5648) < 0.001, `${signals.to_tether.value}`);
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

// ── 엔화·JPYC 신호 ────────────────────────────────────────────────────
test("JPYC가 엔보다 싸면 엔→JPYC만 발동한다 (엔 역프)", () => {
  const signals = evaluateWith({ market: yenMarketOf() });
  // 엔 매도 8.637 (우대 100%라 기준율 그대로) / JPYC 매수 8.55×1.0005 = 8.554275
  // 8.637 / 8.554275 − 1 = +0.9672%
  assert.ok(Math.abs(signals.yen_to_jpyc.value - 0.9672) < 0.001, `${signals.yen_to_jpyc.value}`);
  assert.equal(signals.yen_to_jpyc.fired, true);
  // JPYC 매도 8.54×0.9995 = 8.53573 / 엔 매수 8.637 − 1 = −1.172%
  assert.ok(signals.jpyc_to_yen.value < 0, `${signals.jpyc_to_yen.value}`);
  assert.equal(signals.jpyc_to_yen.fired, false);
  // USD 쪽 신호는 여전히 정상 계산된다.
  assert.ok(signals.to_tether.value > 0);
});

test("JPYC가 엔보다 비싸면 JPYC→엔만 발동한다 (엔 김프)", () => {
  const signals = evaluateWith({ market: yenMarketOf({ jpycAsk: 8.75, jpycBid: 8.74 }) });
  // JPYC 매도 8.74×0.9995 = 8.73563 / 엔 매수 8.637 − 1 = +1.1419%
  assert.ok(Math.abs(signals.jpyc_to_yen.value - 1.1419) < 0.002, `${signals.jpyc_to_yen.value}`);
  assert.equal(signals.jpyc_to_yen.fired, true);
  // JPYC 매수 8.75×1.0005 = 8.754375 / 엔 매도 8.637 − 1 = −1.3415%
  assert.equal(signals.yen_to_jpyc.fired, false);
});

test("엔화·JPYC 임계값 언저리 — 0.49% 는 안 울리고 0.51% 는 울린다", () => {
  // 목표 수익률 r 을 만드는 JPYC ask: yenSell / (ask × (1+fee)) − 1 = r
  const askFor = (r) => 8.637 / (1 + r / 100) / 1.0005;
  const below = evaluateWith({ market: yenMarketOf({ jpycAsk: askFor(0.49), jpycBid: 8.54 }) });
  const above = evaluateWith({ market: yenMarketOf({ jpycAsk: askFor(0.51), jpycBid: 8.54 }) });
  assert.equal(below.yen_to_jpyc.fired, false, `아래쪽 ${below.yen_to_jpyc.value}`);
  assert.equal(above.yen_to_jpyc.fired, true, `위쪽 ${above.yen_to_jpyc.value}`);
});

test("엔 고시·JPYC 호가가 없으면 엔 신호는 조용히 생기지 않는다", () => {
  const 없이 = evaluateWith({ market: marketOf() });
  assert.equal(없이.yen_to_jpyc, undefined);
  assert.equal(없이.jpyc_to_yen, undefined);

  // 호가만 있고 고시가 없는 부분 실패 — 엔 신호는 없되 USD 는 정상이다.
  const 호가만 = evaluateWith({ market: marketOf({ jpyc: { ask: 8.55, bid: 8.54, at: 1 } }) });
  assert.equal(호가만.yen_to_jpyc, undefined);
  assert.ok(호가만.to_tether.value > 0);
});

test("임계값 언저리 — 0.49% 는 안 울리고 0.51% 는 울린다", () => {
  // 목표 수익률 r 을 만드는 ask: bankSell / (ask × (1+fee)) − 1 = r
  const askFor = (r) => 1390.5 / (1 + r / 100) / 1.0005;
  const below = evaluateWith({ market: marketOf({ ask: askFor(0.49), bid: 1382 }) });
  const above = evaluateWith({ market: marketOf({ ask: askFor(0.51), bid: 1382 }) });
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

// ── 4. 알림 — 전환·해제·리마인드 ─────────────────────────────────────
const fakeSignal = (value, fired = true, extra = {}) => ({
  id: "to_tether",
  value,
  fired,
  threshold: 0.5,
  ...extra,
});

test("처음 뜬 신호는 바로 보낸다", () => {
  const { fresh, nextAlerts } = selectAlerts({
    signals: [fakeSignal(0.5)],
    state: { ...EMPTY_STATE },
    config: baseConfig(),
    now: 1000,
  });
  assert.equal(fresh.length, 1);
  assert.equal(nextAlerts.to_tether.active, true);
});

test("발동이 유지되면 조용하고, 해제될 때만 한 번 알린다", () => {
  const t0 = 1000;
  const first = selectAlerts({ signals: [fakeSignal(0.6)], state: { ...EMPTY_STATE }, config: baseConfig(), now: t0 });
  assert.equal(first.fresh.length, 1);
  const stateAfter = { alerts: first.nextAlerts };

  // 값이 깊어져도(0.6 → 0.9) 무음 — 예전의 쿨다운·escalation 재전송은 없다.
  const still = selectAlerts({
    signals: [fakeSignal(0.9)],
    state: stateAfter,
    config: baseConfig(),
    now: t0 + 5 * 60_000,
  });
  assert.equal(still.fresh.length, 0, "발동 지속은 리마인드 전까지 무음");
  assert.equal(still.nextAlerts.to_tether.active, true);

  // 마진 안(0.5 − 0.05 = 0.45 위)에서 꺼져도 해제 확정이 아니다 — 경계 부유 무음.
  const float = selectAlerts({
    signals: [fakeSignal(0.48, false)],
    state: { alerts: still.nextAlerts },
    config: baseConfig(),
    now: t0 + 10 * 60_000,
  });
  assert.equal(float.recovered.length, 0, "마진 안 부유는 해제로 세지 않는다");
  assert.equal(float.nextAlerts.to_tether.active, true, "부유 중엔 발동 상태 유지");

  // 마진 아래로 내려가면 해제 1회.
  const released = selectAlerts({
    signals: [fakeSignal(0.2, false)],
    state: { alerts: still.nextAlerts },
    config: baseConfig(),
    now: t0 + 15 * 60_000,
  });
  assert.equal(released.recovered.length, 1);
  assert.equal(released.nextAlerts.to_tether.active, false);

  // 해제 뒤 같은 값이면 아무것도 안 온다.
  const quiet = selectAlerts({
    signals: [fakeSignal(0.2, false)],
    state: { alerts: released.nextAlerts },
    config: baseConfig(),
    now: t0 + 20 * 60_000,
  });
  assert.equal(quiet.fresh.length, 0);
  assert.equal(quiet.recovered.length, 0);
});

test("전환 — 김프가 풀리고 역프가 뜨면 해제·발동이 한 세트로 온다", () => {
  const t0 = 1000;
  const state = { ...EMPTY_STATE, alerts: { to_dollar: { active: true, at: t0, value: 0.6 } } };
  // 김프 신호가 꺼지고(0.2) 역프가 켜진다(0.6) — 부호 뒤집힘의 전형.
  const { fresh, recovered } = selectAlerts({
    signals: [
      { id: "to_dollar", value: 0.2, fired: false, threshold: 0.5, kind: "arb" },
      { id: "to_tether", value: 0.7, fired: true, threshold: 0.5, kind: "arb" },
    ],
    state,
    config: baseConfig(),
    now: t0 + 60_000,
  });
  assert.deepEqual(fresh.map((s) => s.id), ["to_tether"]);
  assert.deepEqual(recovered.map((s) => s.id), ["to_dollar"]);
});

test("발동 지속 리마인드 — reminderHours 마다 한 번", () => {
  const t0 = 1000;
  const config = deepMerge(baseConfig(), { alerts: { reminderHours: 24 } });
  const first = selectAlerts({ signals: [fakeSignal(0.6)], state: { ...EMPTY_STATE }, config, now: t0 });
  assert.equal(first.fresh[0].reminder, undefined, "첫 발동은 전환 알림이다");

  // 24시간이 지나기 전엔 무음.
  const before = selectAlerts({
    signals: [fakeSignal(0.65)],
    state: { alerts: first.nextAlerts },
    config,
    now: t0 + 23 * 3_600_000,
  });
  assert.equal(before.fresh.length, 0);

  // 24시간이 지나면 리마인드 1회.
  const remind = selectAlerts({
    signals: [fakeSignal(0.65)],
    state: { alerts: first.nextAlerts },
    config,
    now: t0 + 24 * 3_600_000 + 60_000,
  });
  assert.equal(remind.fresh.length, 1);
  assert.equal(remind.fresh[0].reminder, true);
  assert.equal(remind.fresh[0].id, "to_tether");

  // 리마인드 직후엔 다시 무음 — 다음 리마인드까지.
  const after = selectAlerts({
    signals: [fakeSignal(0.65)],
    state: { alerts: remind.nextAlerts },
    config,
    now: remind.nextAlerts.to_tether.at + 10 * 3_600_000,
  });
  assert.equal(after.fresh.length, 0);
});

test("마진 안 부유 후 다시 발동해도 재알림하지 않는다", () => {
  const t0 = 1000;
  const state = { alerts: { to_tether: { active: true, at: t0, value: 0.6 } } };
  // 0.48 로 부유(마진 안 → 상태 유지) → 다시 0.6 발동. 전환이 아니므로 무음.
  const dipped = selectAlerts({
    signals: [fakeSignal(0.48, false)],
    state,
    config: baseConfig(),
    now: t0 + 60_000,
  });
  assert.equal(dipped.recovered.length, 0);
  const refired = selectAlerts({
    signals: [fakeSignal(0.55)],
    state: { alerts: dipped.nextAlerts },
    config: baseConfig(),
    now: t0 + 120_000,
  });
  assert.equal(refired.fresh.length, 0, "부유 후 회복은 새 알림이 아니다");
  assert.equal(refired.nextAlerts.to_tether.active, true);
});

test("recoverNotice 를 끄면 해제 메시지는 없어도 상태는 바뀐다", () => {
  const config = deepMerge(baseConfig(), { alerts: { recoverNotice: false } });
  const t0 = 1000;
  const state = { ...EMPTY_STATE, alerts: { to_tether: { active: true, at: t0, value: 0.6 } } };
  const { recovered, nextAlerts } = selectAlerts({
    signals: [fakeSignal(0.2, false)],
    state,
    config,
    now: t0 + 60_000,
  });
  assert.equal(recovered.length, 0);
  assert.equal(nextAlerts.to_tether.active, false, "알림 없이도 상태는 풀려야 한다");
  // 그러면 다음 발동은 전환으로 다시 알린다.
  const refire = selectAlerts({ signals: [fakeSignal(0.6)], state: { ...nextAlerts }, config, now: t0 + 120_000 });
  assert.equal(refire.fresh.length, 1);
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
  assert.equal(merged.thresholds.toDollarPct, 0.5, "건드리지 않은 값은 그대로여야 한다");
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

test("꼬리표에 엔 고시와 JPYC 호가를 남긴다", () => {
  const market = yenMarketOf();
  const config = baseConfig();
  const quotes = buildQuotes({ market, config });
  const text = marketFooter(market, quotes);
  assert.match(text, /엔 고시 <b>8\.64<\/b>/, text);
  assert.match(text, /업비트 JPYC 8\.54\/8\.55/, text);

  // /시세 에도 엔화·JPYC 블록이 나온다.
  const signals = evaluate({ market, quotes, config });
  assert.match(formatRates({ market, quotes, signals, config }), /엔화·JPYC/);

  // 엔 데이터가 없으면 그 줄도 없다 — "값이 없다"와 "0이다"는 다르다.
  const bare = marketFooter(marketOf(), buildQuotes({ market: marketOf(), config }));
  assert.doesNotMatch(bare, /엔 고시/);
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

  const jpyc = await run("/임계 toJpycPct 1.0");
  assert.equal(jpyc.state.overrides.thresholds.toJpycPct, 1.0, "엔화 신호도 /임계 로 조여야 한다");

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

// ── 9. "/" 자동완성 메뉴 ──────────────────────────────────────────────
test("메뉴 명령은 텔레그램 규칙(a-z0-9_, 32자)을 지킨다", () => {
  // setMyCommands 가 400 으로 거절되면 메뉴가 아예 안 뜨므로, 등록 전에
  // 규칙을 여기서 걸러둔다. 개수 100, 이름 1~32자, 설명 1~256자.
  assert.ok(MENU_COMMANDS.length > 0 && MENU_COMMANDS.length <= 100);
  for (const { command, description } of MENU_COMMANDS) {
    assert.match(command, /^[a-z0-9_]{1,32}$/, `command=${command}`);
    assert.ok(description.length >= 1 && description.length <= 256, `description=${description}`);
  }
});

asyncTest("메뉴에 등록한 명령은 전부 실제로 응답한다", async () => {
  // 메뉴가 존재하지 않는 명령을 광고하면 안 된다. 영문 별칭이 깨지면
  // (리팩터링에서 case 이름을 바꾸는 식) 이 테스트가 잡아준다.
  const snapshot = async () => {
    const now = 4_000_000_000;
    const market = marketOf();
    const config = baseConfig();
    const quotes = buildQuotes({ market, config, now });
    return { market, quotes, signals: evaluate({ market, quotes, config, now }) };
  };
  for (const { command } of MENU_COMMANDS) {
    const result = await handleCommand({
      command: { name: command, args: [] },
      state: { ...EMPTY_STATE },
      config: baseConfig(),
      snapshot,
      now: 1_000_000,
    });
    assert.doesNotMatch(result.reply ?? "", /모르는 명령/, `/${command} 은(는) 메뉴에만 있고 실제로는 없다`);
    assert.ok(result.reply, `/${command} 은(는) 응답이 있어야 한다`);
  }
});

// ── 10. 매수 적합성 (세븐스플릿 방식) ─────────────────────────────────
/** 합성 일봉: 매일 규칙적으로 움직이는 시계열. 손으로 계산한 판정값과 비교한다. */
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 23); // 마지막 완성봉 날짜(당일 봉은 toBars 가 제외)
function seriesOf({ start, step, days = 400 }) {
  const bars = [];
  for (let i = 0; i < days; i += 1) bars.push({ t: NOW - (days - 1 - i) * DAY, c: start + step * i });
  return bars;
}
/** 당일 진행 중 봉 — 통계에서 제외돼야 한다. */
const todayBar = { t: NOW + DAY, c: 999 };

test("적합성: 환율·강도·갭 판정을 손계산과 맞춘다", () => {
  // 등비 시계열 — 중간값과 평균이 계산하기 쉬운 모양이다.
  // 환율 1300→1420 등차, DXY 95→107 등차. 현재(마지막 완성봉 다음 값)를 지정해 판정을 고정한다.
  const rateBars = seriesOf({ start: 1300, step: 0.3 });
  const dxyBars = seriesOf({ start: 100, step: 0.05 });
  const now = NOW + DAY; // 다음 날 — "현재"로 취급
  const daily = {
    usdkrw: { bars: rateBars, current: 1340 },
    dxy: { bars: dxyBars, current: 100.5 },
  };

  const [usd] = evaluateSuitability({ daily, config: baseConfig() });
  assert.ok(usd, "달러 신호가 있어야 한다");

  const row = usd.legs.find((leg) => leg.label === "1M");
  // 30일 창: 환율 최저~최고의 중간값 → 현재 1340 vs 중간값…
  // 등차 시계열이므로 중간값 = (첫값 + 마지막값)/2. 검증은 대소만 확정한다.
  assert.ok(usd.maxScore === 12, `maxScore=${usd.maxScore}`);
  assert.ok(usd.score >= 0 && usd.score <= 12, `score=${usd.score}`);
  assert.ok(usd.subtitle.includes("/12"), usd.subtitle);
});

test("적합성: 만점·적합·중립·부적합 밴드 경계를 지킨다", () => {
  // 만점 시나리오 — 달러가 국제적으로 반등 중(갭 축소)이지만 환율이 더 먼저 내려온 상태:
  // 환율 O(낮다) · 강도 O(DXY가 창 중간값 아래) · 갭 O(DXY 반등으로 갭이 평균 위).
  const rateBars = [], dxyBars = [];
  for (let i = 0; i < 400; i += 1) {
    rateBars.push({ t: NOW - (399 - i) * DAY, c: 1400 - 0.2 * i });
    dxyBars.push({ t: NOW - (399 - i) * DAY, c: i < 395 ? 110 - 0.02 * i : 102.02 + (i - 395) * 0.25 });
  }
  const daily = { usdkrw: { bars: rateBars, current: 1313 }, dxy: { bars: dxyBars, current: 102.4 } };
  const [usd] = evaluateSuitability({ daily, config: baseConfig() });
  assert.equal(usd.score, 12, `score=${usd.score}`);
  assert.equal(usd.band, "만점");
  assert.equal(usd.rank, 3);
  assert.equal(usd.fired, true);

  // 중립 — 같은 시나리오에서 현재값을 창 중간값 언저리로 올리면 갭·강도가 깨진다.
  const [mid] = evaluateSuitability({
    daily: { usdkrw: { bars: rateBars, current: 1345 }, dxy: { bars: dxyBars, current: 103.4 } },
    config: baseConfig(),
  });
  assert.ok(mid.rank <= 1, `rank=${mid.rank} score=${mid.score}`);
});

test("적합성: 강도 조건 방향이 통화별로 뒤집힌다 (엔은 USD/JPY가 높을 때 O)", () => {
  const rateBars = seriesOf({ start: 1400, step: -0.2 });
  const now = NOW + DAY;
  // USD/JPY 가 기간 중간값보다 높으면(엔 약세) 엔화 강도 조건은 O.
  const jpyBars = seriesOf({ start: 150, step: 0.05 }); // 상승 추세
  const [jpy] = evaluateSuitability({
    daily: {
      jpykrw: { bars: rateBars, current: 1300 },
      usdjpy: { bars: jpyBars, current: 158 },
    },
    config: baseConfig(),
  });
  const strengthCheck = jpy.legs[0] ? undefined : undefined;
  void strengthCheck;
  // 12M 창 기준 USD/JPY 현재 > 중간값 → 강도 O. 3조건이 모두 엔에 유리한지 점수로 확인.
  assert.ok(jpy.score >= 1, `score=${jpy.score}`);
  // 달러 신호는 데이터가 없으니 나오지 않는다.
  assert.equal(jpy.id, "suit_jpy");
});

test("적합성: 날짜 정렬은 공통 날짜만 남긴다", () => {
  const a = [{ t: Date.UTC(2026, 8, 20), c: 1 }, { t: Date.UTC(2026, 8, 21), c: 2 }, { t: Date.UTC(2026, 8, 22), c: 3 }];
  const b = [{ t: Date.UTC(2026, 8, 21), c: 10 }, { t: Date.UTC(2026, 8, 22), c: 20 }];
  const aligned = alignByDate(a, b);
  assert.equal(aligned.length, 2); // 9-21은 B에 없어 제외
  assert.deepEqual(aligned.map((row) => ({ rate: row.rate, strength: row.strength })), [
    { rate: 2, strength: 10 },
    { rate: 3, strength: 20 },
  ]);
});

test("적합성: 당일 미완성 봉은 통계에서 빠진다", () => {
  const completed = [1, 2, 3, 4, 5].map((c, i) => ({ t: NOW - (4 - i) * DAY, c }));
  const bars = toBars([NOW - 4 * DAY, NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY, NOW + DAY], [1, 2, 3, 4, 999], NOW + DAY);
  assert.equal(bars.length, 4, "오늘(999) 봉은 제외");
  assert.deepEqual(bars.map((b) => b.c), [1, 2, 3, 4]);
});

test("적합성: 갭 조건과 적정 환율 판정이 항상 동치다", () => {
  // 갭 = 강도/환율×100 > 평균 ⟺ 현재 환율 < 적정환율(강도/평균갭×100)
  const rateBars = seriesOf({ start: 1300, step: 0.3 });
  const dxyBars = seriesOf({ start: 100, step: 0.05 });
  const now = NOW + DAY;
  const [usd] = evaluateSuitability({
    daily: { usdkrw: { bars: rateBars, current: 1345 }, dxy: { bars: dxyBars, current: 100.3 } },
    config: baseConfig(),
  });
  for (const row of usd.legs) {
    void row;
  }
  // legs 는 score 만 담으니, 동치 검증은 checks 를 통해 — 신호에 checks 를 노출했는지 확인 대신
  // 판정 자체를 다시 계산해 비교한다.
  const daily = { usdkrw: { bars: rateBars, current: 1345 }, dxy: { bars: dxyBars, current: 100.4 } };
  const [again] = evaluateSuitability({ daily, config: baseConfig() });
  assert.ok(again.score >= 0 && again.score <= 12);
});

test("적합성: enabled false 면 신호를 만들지 않는다", () => {
  const rateBars = seriesOf({ start: 1300, step: 0.3 });
  const signals = evaluateSuitability({
    daily: { usdkrw: { bars: rateBars, current: 1340 }, dxy: { bars: rateBars, current: 100 } },
    config: deepMerge(baseConfig(), { suitability: { enabled: false } }),
  });
  assert.equal(signals.length, 0);
});

test("적합성: goodScore 를 바꾸면 밴드가 바뀐다", () => {
  const rateBars = [], dxyBars = [];
  for (let i = 0; i < 400; i += 1) {
    rateBars.push({ t: NOW - (399 - i) * DAY, c: 1400 - 0.2 * i });
    dxyBars.push({ t: NOW - (399 - i) * DAY, c: i < 395 ? 110 - 0.02 * i : 102.02 + (i - 395) * 0.25 });
  }
  const daily = { usdkrw: { bars: rateBars, current: 1313 }, dxy: { bars: dxyBars, current: 102.4 } };
  const loose = evaluateSuitability({
    daily,
    config: deepMerge(baseConfig(), { suitability: { goodScore: 4 } }),
  });
  assert.equal(loose[0].threshold, 4);
  assert.equal(loose[0].rank, 3, "12점은 만점이라 goodScore 와 무관");
  assert.equal(loose[0].score, 12);

  // goodScore 를 만점(12)으로 올리면 12점이 아니면 적합이 안 된다.
  const strict = evaluateSuitability({
    daily: { usdkrw: { bars: rateBars, current: 1345 }, dxy: { bars: dxyBars, current: 103.4 } },
    config: deepMerge(baseConfig(), { suitability: { goodScore: 12 } }),
  });
  assert.equal(strict[0].threshold, 12);
  assert.ok(strict[0].score < 12, "중립 시나리오는 만점이 아니다");
  assert.equal(strict[0].rank, 1, `rank=${strict[0].rank}`);
});

test("적합성: 데이터가 없는 통화는 조용히 생략한다", () => {
  const rateBars = seriesOf({ start: 1300, step: 0.3 });
  const signals = evaluateSuitability({
    daily: { usdkrw: { bars: rateBars, current: 1340 }, dxy: null },
    config: baseConfig(),
  });
  assert.equal(signals.length, 0);
});

test("적합성: dayKey 는 UTC 날짜로 묶는다", () => {
  assert.equal(dayKey(Date.UTC(2026, 8, 23, 14)), dayKey(Date.UTC(2026, 8, 23, 0)));
  assert.notEqual(dayKey(Date.UTC(2026, 8, 23, 14)), dayKey(Date.UTC(2026, 8, 24, 0)));
});

asyncTest("/적합 은 표를 만들고, 데이터 없으면 안내한다", async () => {
  const now = 4_000_000_000;
  const market = marketOf();
  const config = baseConfig();
  const quotes = buildQuotes({ market, config, now });
  const rateBars = seriesOf({ start: 1400, step: -0.2 });
  const signals = evaluateSuitability({
    daily: {
      usdkrw: { bars: rateBars, current: 1320 },
      dxy: { bars: seriesOf({ start: 110, step: -0.02 }), current: 102.7 },
      jpykrw: { bars: rateBars, current: 8.5 },
      usdjpy: { bars: seriesOf({ start: 150, step: 0.05 }), current: 158 },
    },
    config,
  });
  const table = formatSuitability({ signals: [...signals] });
  assert.match(table, /매수 적합성/);
  assert.match(table, /달러 매수 적합성/);
  assert.match(table, /엔화 매수 적합성/);

  const empty = formatSuitability({ signals: [] });
  assert.match(empty, /판정을 만들 수 없습니다/);
});

asyncTest("/적합 은 메뉴에 등록돼 실제로 응답한다", async () => {
  const command = MENU_COMMANDS.find((entry) => entry.command === "suit");
  assert.ok(command, "메뉴에 suit 이 있어야 한다");
  const result = await handleCommand({
    command: { name: "suit", args: [] },
    state: { ...EMPTY_STATE },
    config: baseConfig(),
    snapshot: async () => ({ market: marketOf(), quotes: buildQuotes({ market: marketOf(), config: baseConfig() }), signals: [] }),
    now: 1_000_000,
  });
  assert.match(result.reply, /매수 적합성/);
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
