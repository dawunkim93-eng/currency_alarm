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

const FOREX_URL = "https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD";
const FOREX_FALLBACK_URL =
  "https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW&page=1&pageSize=1";
const UPBIT_ORDERBOOK_URL = "https://api.upbit.com/v1/orderbook?markets=KRW-USDT";
const UPBIT_TICKER_URL = "https://api.upbit.com/v1/ticker?markets=KRW-USDT";
/** 빗썸은 2.0(업비트 호환)과 1.0이 함께 살아 있다. 2.0을 먼저 보고 실패하면 1.0으로 내려간다. */
const BITHUMB_ORDERBOOK_V2_URL = "https://api.bithumb.com/v1/orderbook?markets=KRW-USDT";
const BITHUMB_ORDERBOOK_V1_URL = "https://api.bithumb.com/public/orderbook/USDT_KRW";

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

/** 네이버 금융 대체 경로. 매매기준율(종가)만 준다 — 전신환 스프레드는 설정값으로 메운다. */
export function parseNaverForex(payload) {
  const rows = payload?.result?.marketIndexPrices ?? payload?.marketIndexPrices ?? payload?.result ?? payload;
  const row = Array.isArray(rows) ? rows[0] : rows;
  const base = num(row?.closePrice);
  if (!base) throw new Error("네이버 응답에서 환율을 읽지 못했습니다.");
  return {
    base,
    ttSelling: null,
    ttBuying: null,
    cashSelling: null,
    cashBuying: null,
    changePct: num(row?.fluctuationsRatio) ?? null,
    changePrice: num(row?.compareToPreviousClosePrice) ?? null,
    provider: "네이버 금융",
    quotedAt: null,
    source: "naver",
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

export async function fetchForex(options = {}) {
  try {
    return parseDunamuForex(await fetchJson(FOREX_URL, options));
  } catch (primaryError) {
    try {
      return parseNaverForex(await fetchJson(FOREX_FALLBACK_URL, options));
    } catch (fallbackError) {
      throw new Error(`매매기준율 수집 실패 (두나무: ${primaryError.message} / 네이버: ${fallbackError.message})`);
    }
  }
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

/**
 * 한 번의 시세 스냅샷.
 *
 * 거래소 하나가 죽어도 나머지로 계속 간다 — 업비트만 살아 있어도 역프 판단은
 * 가능하다. 반면 **매매기준율이 없으면 전부 무의미**하므로 그때만 던진다.
 */
export async function fetchMarket({ config, options = {} } = {}) {
  const enabled = Object.entries(config?.exchanges ?? {}).filter(([, ex]) => ex.enabled !== false);
  const fetchers = { upbit: fetchUpbit, bithumb: fetchBithumb };

  const [forexResult, ...exchangeResults] = await Promise.allSettled([
    fetchForex(options),
    ...enabled.map(([id]) => (fetchers[id] ? fetchers[id](options) : Promise.reject(new Error(`모르는 거래소: ${id}`)))),
  ]);

  if (forexResult.status !== "fulfilled") throw forexResult.reason;

  const exchanges = {};
  const errors = [];
  enabled.forEach(([id], index) => {
    const result = exchangeResults[index];
    if (result.status === "fulfilled") exchanges[id] = result.value;
    else errors.push(`${config.exchanges[id].label ?? id}: ${result.reason?.message ?? result.reason}`);
  });

  return { forex: forexResult.value, exchanges, errors, at: Date.now() };
}
