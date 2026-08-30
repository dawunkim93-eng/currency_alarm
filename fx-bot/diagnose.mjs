#!/usr/bin/env node
/**
 * 시세 출처 도달성 진단
 *
 *   node fx-bot/diagnose.mjs
 *
 * 어디서 돌리느냐에 따라 열리는 곳이 다르다. 국내 시세 API 중에는 해외
 * IP(=GitHub Actions 러너)를 막는 곳이 있고, 반대로 러너에서만 되는 곳도 있다.
 * 짐작으로 출처를 고르면 "왜 안 오지"를 며칠 헤매게 되므로, **돌릴 환경에서
 * 직접 재보고** 되는 것 중에 고른다.
 *
 * 비밀값이 필요 없다. 안 되는 곳이 있어도 끝까지 다 재고 표로 보여준다.
 */

const TIMEOUT_MS = 8000;

/** pick 은 응답에서 "쓸 수 있는 값"을 뽑는다. 200 이 떠도 모양이 다르면 소용없다. */
const TARGETS = [
  // ── 매매기준율 (USD/KRW) ────────────────────────────────────────────
  {
    group: "환율",
    name: "두나무 CDN (하나은행 고시)",
    url: "https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD",
    pick: (j) => j?.[0]?.basePrice,
  },
  {
    group: "환율",
    name: "네이버 stock api",
    url: "https://api.stock.naver.com/marketindex/exchange/FX_USDKRW",
    pick: (j) => j?.calcPrice ?? j?.closePrice,
  },
  {
    group: "환율",
    name: "네이버 마켓인덱스 목록",
    url: "https://api.stock.naver.com/marketindex/major",
    pick: (j) => j?.find?.((r) => r?.reutersCode === "FX_USDKRW")?.closePrice,
  },
  {
    group: "환율",
    name: "네이버 polling",
    url: "https://polling.finance.naver.com/api/realtime/marketindex/exchange/FX_USDKRW",
    pick: (j) => j?.result?.areas?.[0]?.datas?.[0]?.nv ?? j?.datas?.[0]?.nv,
  },
  {
    group: "환율",
    name: "야후 파이낸스 KRW=X",
    url: "https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1m&range=1d",
    pick: (j) => j?.chart?.result?.[0]?.meta?.regularMarketPrice,
  },
  {
    group: "환율",
    name: "frankfurter (ECB 일일)",
    url: "https://api.frankfurter.app/latest?from=USD&to=KRW",
    pick: (j) => j?.rates?.KRW,
  },
  {
    group: "환율",
    name: "open.er-api (일일)",
    url: "https://open.er-api.com/v6/latest/USD",
    pick: (j) => j?.rates?.KRW,
  },

  // ── 테더 (USDT/KRW) ─────────────────────────────────────────────────
  {
    group: "테더",
    name: "업비트 호가창",
    url: "https://api.upbit.com/v1/orderbook?markets=KRW-USDT",
    pick: (j) => j?.[0]?.orderbook_units?.[0]?.ask_price,
  },
  {
    group: "테더",
    name: "업비트 체결가",
    url: "https://api.upbit.com/v1/ticker?markets=KRW-USDT",
    pick: (j) => j?.[0]?.trade_price,
  },
  {
    group: "테더",
    name: "빗썸 2.0 호가창",
    url: "https://api.bithumb.com/v1/orderbook?markets=KRW-USDT",
    pick: (j) => j?.[0]?.orderbook_units?.[0]?.ask_price,
  },
  {
    group: "테더",
    name: "빗썸 1.0 호가창",
    url: "https://api.bithumb.com/public/orderbook/USDT_KRW",
    pick: (j) => j?.data?.asks?.[0]?.price,
  },
  {
    group: "테더",
    name: "코인원 호가창",
    url: "https://api.coinone.co.kr/public/v2/orderbook/KRW/USDT",
    pick: (j) => j?.asks?.[0]?.price,
  },
  {
    group: "테더",
    name: "코빗 호가창",
    url: "https://api.korbit.co.kr/v2/orderbook?symbol=usdt_krw",
    pick: (j) => j?.data?.asks?.[0]?.[0] ?? j?.asks?.[0]?.[0],
  },
];

async function probe(target) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "fx-alert-bot/1.0 (+https://github.com/dawunkim93-eng)" },
    });
    const ms = Date.now() - started;
    const text = await response.text();
    if (!response.ok) return { ...target, ok: false, ms, detail: `HTTP ${response.status} ${text.slice(0, 80)}` };

    let value;
    try {
      value = target.pick(JSON.parse(text));
    } catch {
      return { ...target, ok: false, ms, detail: `JSON 아님: ${text.slice(0, 80)}` };
    }
    // 200 인데 값을 못 뽑은 건 "막혔다"가 아니라 "내가 필드를 잘못 짚었다"는 뜻이다.
    // 그때는 응답을 넉넉히 보여줘야 다음 시도에서 제대로 짚는다.
    if (value == null) return { ...target, ok: false, ms, reachable: true, detail: `값 없음 ↓\n   ${text.slice(0, 700)}` };
    return { ...target, ok: true, ms, detail: String(value) };
  } catch (error) {
    // fetch failed = DNS·TCP·TLS 단계에서 막힘 (해외 IP 차단이 보통 이렇게 보인다)
    return { ...target, ok: false, ms: Date.now() - started, detail: error.name === "AbortError" ? "시간초과" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

const results = await Promise.all(TARGETS.map(probe));

let lastGroup = null;
for (const result of results) {
  if (result.group !== lastGroup) {
    console.log(`\n── ${result.group} ${"─".repeat(40)}`);
    lastGroup = result.group;
  }
  const mark = result.ok ? "✅" : "❌";
  console.log(`${mark} ${result.name.padEnd(24)} ${String(result.ms).padStart(5)}ms  ${result.detail}`);
}

const usable = (group) => results.filter((r) => r.group === group && r.ok).length;
console.log(`\n환율 ${usable("환율")}/${results.filter((r) => r.group === "환율").length} · 테더 ${usable("테더")}/${results.filter((r) => r.group === "테더").length} 사용 가능`);

// 환율과 테더 **양쪽 다** 하나씩은 열려야 봇이 의미가 있다.
if (!usable("환율") || !usable("테더")) {
  console.error("\n이 환경에서는 봇을 돌릴 수 없습니다. 열린 출처가 한쪽이라도 없습니다.");
  process.exit(1);
}
