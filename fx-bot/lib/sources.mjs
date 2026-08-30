/**
 * 시세 수집 — 매매기준율(USD/KRW)과 거래소 테더 호가
 *
 * 네트워크 호출부와 **파싱부를 분리**했다. 파싱 함수(parse*)는 순수 함수라
 * `npm run test-fx` 에서 실제 응답 모양 그대로 검증한다. 시세를 잘못 읽으면
 * 없는 차익을 있다고 알리게 되는데, 그건 알림이 안 오는 것보다 나쁘다.
 *
 * 출처
 *   - 매매기준율: 두나무 CDN (하나은행 고시). 실패하면 네이버 금융으로 대체.
 *   - 테더 호가: 업비트 / 빗썸 공개 호가창 (인증 불필요).
 */

// 저장소 이름은 바뀔 수 있으니 UA 에 박지 않는다. 봇 이름과 계정만 밝힌다.
const UA = "fx-alert-bot/1.0 (+https://github.com/dawunkim93-eng)";

const DUNAMU_URL = "https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD";
const NAVER_URL = "https://api.stock.naver.com/marketindex/exchange/FX_USDKRW";
const YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1m&range=1d";
const ER_API_URL = "https://open.er-api.com/v6/latest/USD";
const UPBIT_ORDERBOOK_URL = "https://api.upbit.com/v1/orderbook?markets=KRW-USDT";
const UPBIT_TICKER_URL = "https://api.upbit.com/v1/ticker?markets=KRW-USDT";
/** 빗썸은 2.0(업비트 호환)과 1.0이 함께 살아 있다. 2.0을 먼저 보고 실패하면 1.0으로 내려간다. */
const BITHUMB_ORDERBOOK_V2_URL = "https://api.bithumb.com/v1/orderbook?markets=KRW-USDT";
const BITHUMB_ORDERBOOK_V1_URL = "https://api.bithumb.com/public/orderbook/USDT_KRW";
const COINONE_ORDERBOOK_URL = "https://api.coinone.co.kr/public/v2/orderbook/KRW/USDT";

export async function fetchJson(url, { timeoutMs = 7000, retries = 2, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": UA },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      // 마지막 시도였으면 더 기다릴 이유가 없다.
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url} 요청 실패: ${lastError?.message ?? lastError}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 두나무 forex 응답 → 정규화. 매매기준율과 전신환 매매율(은행이 파는 값/사는 값). */
export function parseDunamuForex(payload) {
  const row = Array.isArray(payload) ? payload[0] : payload;
  const base = num(row?.basePrice);
  if (!base) throw new Error("두나무 응답에 basePrice 가 없습니다.");
  return {
    base,
    ttSelling: num(row?.ttSellingPrice) || null, // 내가 살 때(전신환) 은행 고시
    ttBuying: num(row?.ttBuyingPrice) || null, // 내가 팔 때
    cashSelling: num(row?.cashSellingPrice) || null,
    cashBuying: num(row?.cashBuyingPrice) || null,
    changePct: typeof row?.signedChangeRate === "number" ? row.signedChangeRate * 100 : null,
    changePrice: typeof row?.signedChangePrice === "number" ? row.signedChangePrice : null,
    provider: row?.provider ?? "하나은행",
    quotedAt: num(row?.timestamp) || null,
    source: "dunamu",
  };
}

/**
 * 네이버 금융의 하나은행 고시 (`exchangeInfo.closePrice` 가 매매기준율).
 *
 * 두나무 CDN 이 막힌 곳(GitHub Actions 러너가 그렇다)에서 **매매기준율을 그대로
 * 주는 유일한 경로**라 1순위 대체다. 값은 "1,381.00" 처럼 쉼표가 붙어 온다.
 * 전신환 고시는 주지 않으므로 스프레드는 설정값(기본 1%)으로 메운다.
 */
export function parseNaverExchange(payload) {
  const info = payload?.exchangeInfo ?? payload;
  const base = num(info?.closePrice);
  if (!base) throw new Error("네이버 응답에서 환율을 읽지 못했습니다.");
  return {
    base,
    ttSelling: null,
    ttBuying: null,
    cashSelling: null,
    cashBuying: null,
    changePct: num(info?.fluctuationsRatio),
    changePrice: num(info?.fluctuations),
    provider: `${info?.stockExchangeType?.nameKor ?? "하나은행"} 고시`,
    quotedAt: info?.localTradedAt ? Date.parse(info.localTradedAt) || null : null,
    source: "naver",
  };
}

/**
 * 야후 파이낸스 KRW=X — 은행 고시가 아니라 **시장 중간값**이다.
 *
 * 고시가 멈추는 주말·야간에도 움직이고 어디서든 열린다. 다만 은행이 실제로
 * 적용하는 값과는 몇 원 차이가 나므로, 고시를 못 구했을 때만 쓴다.
 */
export function parseYahooChart(payload) {
  const meta = payload?.chart?.result?.[0]?.meta;
  const base = num(meta?.regularMarketPrice);
  if (!base) throw new Error("야후 응답에서 환율을 읽지 못했습니다.");
  const previous = num(meta?.chartPreviousClose ?? meta?.previousClose);
  return {
    base,
    ttSelling: null,
    ttBuying: null,
    cashSelling: null,
    cashBuying: null,
    changePct: previous ? ((base - previous) / previous) * 100 : null,
    changePrice: previous ? base - previous : null,
    provider: "야후 시장중간값",
    quotedAt: num(meta?.regularMarketTime) ? num(meta.regularMarketTime) * 1000 : null,
    source: "yahoo",
  };
}

/** 최후의 보루. 하루 한 번 갱신이라 장중 판단에는 못 쓰지만 "값이 아예 없음"보다는 낫다. */
export function parseErApi(payload) {
  const base = num(payload?.rates?.KRW);
  if (!base) throw new Error("er-api 응답에서 환율을 읽지 못했습니다.");
  return {
    base,
    ttSelling: null,
    ttBuying: null,
    cashSelling: null,
    cashBuying: null,
    changePct: null,
    changePrice: null,
    provider: "open.er-api (일일)",
    quotedAt: num(payload?.time_last_update_unix) ? num(payload.time_last_update_unix) * 1000 : null,
    source: "er-api",
  };
}

/** 업비트/빗썸 2.0 호가창 → 최우선 매도호가(ask)·매수호가(bid). */
export function parseUpbitStyleOrderbook(payload) {
  const row = Array.isArray(payload) ? payload[0] : payload;
  const unit = row?.orderbook_units?.[0];
  const ask = num(unit?.ask_price);
  const bid = num(unit?.bid_price);
  if (!ask || !bid) throw new Error("호가창에서 ask/bid 를 읽지 못했습니다.");
  return { ask, bid, at: num(row?.timestamp) || null };
}

/** 빗썸 1.0 호가창. asks 는 오름차순, bids 는 내림차순이라 각각 0번이 최우선이다. */
export function parseBithumbLegacyOrderbook(payload) {
  if (payload?.status && payload.status !== "0000") {
    throw new Error(`빗썸 오류 status=${payload.status}`);
  }
  const data = payload?.data ?? payload;
  const ask = num(data?.asks?.[0]?.price);
  const bid = num(data?.bids?.[0]?.price);
  if (!ask || !bid) throw new Error("빗썸 호가창에서 ask/bid 를 읽지 못했습니다.");
  return { ask, bid, at: num(data?.timestamp) || null };
}

/** 호가창이 죽었을 때의 최후 수단. 체결가 하나로 양쪽을 채운다(스프레드 0 가정). */
export function parseUpbitTicker(payload) {
  const row = Array.isArray(payload) ? payload[0] : payload;
  const price = num(row?.trade_price);
  if (!price) throw new Error("업비트 체결가를 읽지 못했습니다.");
  return { ask: price, bid: price, at: num(row?.timestamp) || null };
}

/** "1,390.50" 같은 문자열도 숫자로. 못 읽으면 null. */
function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 매매기준율 출처 — **위에서부터 되는 것**을 쓴다.
 *
 * 순서는 취향이 아니라 측정 결과다 (`node fx-bot/diagnose.mjs`).
 * GitHub Actions 러너에서는 두나무가 100ms 대에 `fetch failed` 로 끊긴다
 * (해외 IP 차단). 반면 국내에서 돌리면 두나무가 전신환 고시까지 줘서 제일 좋다.
 * 그래서 둘 다 남겨두고 순서로 해결한다.
 *
 * 아래로 갈수록 "은행이 실제로 적용하는 값"에서 멀어진다. 야후·er-api 는
 * 시장 중간값이라 몇 원 어긋나므로, 알림에 출처를 항상 같이 찍는다.
 */
const FOREX_SOURCES = [
  { name: "두나무(하나은행 고시)", url: DUNAMU_URL, parse: parseDunamuForex },
  { name: "네이버(하나은행 고시)", url: NAVER_URL, parse: parseNaverExchange },
  { name: "야후(시장중간값)", url: YAHOO_URL, parse: parseYahooChart },
  { name: "open.er-api(일일)", url: ER_API_URL, parse: parseErApi },
];

export async function fetchForex(options = {}) {
  const failures = [];
  for (const source of FOREX_SOURCES) {
    try {
      // 뒤에 대안이 있으니 재시도로 시간을 끌지 않는다. 막힌 곳은 대개
      // 100ms 안에 끊기고, 살아 있는 곳으로 빨리 넘어가는 편이 낫다.
      return source.parse(await fetchJson(source.url, { retries: 0, ...options }));
    } catch (error) {
      failures.push(`${source.name}: ${error.message}`);
    }
  }
  throw new Error(`매매기준율 수집 실패 — ${failures.join(" / ")}`);
}

export async function fetchUpbit(options = {}) {
  try {
    return parseUpbitStyleOrderbook(await fetchJson(UPBIT_ORDERBOOK_URL, options));
  } catch {
    return parseUpbitTicker(await fetchJson(UPBIT_TICKER_URL, options));
  }
}

export async function fetchBithumb(options = {}) {
  try {
    return parseUpbitStyleOrderbook(await fetchJson(BITHUMB_ORDERBOOK_V2_URL, options));
  } catch {
    return parseBithumbLegacyOrderbook(await fetchJson(BITHUMB_ORDERBOOK_V1_URL, options));
  }
}

/** 코인원 호가창. asks/bids 는 {price, qty} 문자열 배열이다. */
export function parseCoinoneOrderbook(payload) {
  const ask = num(payload?.asks?.[0]?.price);
  const bid = num(payload?.bids?.[0]?.price);
  if (!ask || !bid) throw new Error("코인원 호가창에서 ask/bid 를 읽지 못했습니다.");
  return { ask, bid, at: num(payload?.timestamp) || null };
}

export async function fetchCoinone(options = {}) {
  return parseCoinoneOrderbook(await fetchJson(COINONE_ORDERBOOK_URL, options));
}

/**
 * 한 번의 시세 스냅샷.
 *
 * 거래소 하나가 죽어도 나머지로 계속 간다 — 업비트만 살아 있어도 역프 판단은
 * 가능하다. 반면 **매매기준율이 없으면 전부 무의미**하므로 그때만 던진다.
 */
export async function fetchMarket({ config, options = {} } = {}) {
  const enabled = Object.entries(config?.exchanges ?? {}).filter(([, ex]) => ex.enabled !== false);
  const fetchers = { upbit: fetchUpbit, bithumb: fetchBithumb, coinone: fetchCoinone };

  const [forexResult, ...exchangeResults] = await Promise.allSettled([
    fetchForex(options),
    ...enabled.map(([id]) => (fetchers[id] ? fetchers[id](options) : Promise.reject(new Error(`모르는 거래소: ${id}`)))),
  ]);

  const exchanges = {};
  const errors = [];
  enabled.forEach(([id], index) => {
    const result = exchangeResults[index];
    if (result.status === "fulfilled") exchanges[id] = result.value;
    else errors.push(`${config.exchanges[id].label ?? id}: ${result.reason?.message ?? result.reason}`);
  });

  // 환율을 못 받으면 어차피 계산이 안 되지만, 거래소 쪽 결과도 함께 알려준다.
  // "환율만 막힌 것"과 "네트워크가 통째로 막힌 것"은 원인이 전혀 다르다.
  if (forexResult.status !== "fulfilled") {
    const exchangeNote = errors.length
      ? ` (거래소도 실패 — ${errors.join(" / ")})`
      : ` (거래소는 정상: ${Object.keys(exchanges).join(", ") || "없음"})`;
    throw new Error(`${forexResult.reason?.message ?? forexResult.reason}${exchangeNote}`);
  }

  return { forex: forexResult.value, exchanges, errors, at: Date.now() };
}
