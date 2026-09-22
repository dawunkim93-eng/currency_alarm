/**
 * 거래처별 "내가 실제로 적용받는 환율" 계산
 *
 * 은행·핀테크는 공개 시세 API가 없어서 모형으로 만든다.
 *
 *   내가 살 때(원화→달러)  buy  = 기준율 × (1 + 스프레드 × (1 − 매수우대율))
 *   내가 팔 때(달러→원화)  sell = 기준율 × (1 − 스프레드 × (1 − 매도우대율))
 *
 * 스프레드는 설정에 숫자가 없으면 **하나은행 전신환 고시에서 역산**한다
 * (ttSelling/base, base/ttBuying). 은행마다 자체 기준율이 조금씩 달라서
 * 모형값과 앱 화면이 몇십 전 어긋날 수 있는데, 그건 `/시세입력` 으로 실측을
 * 덮어쓰라고 만들어 뒀다. 모형을 진짜 고시환율인 척하지는 않는다.
 *
 * 거래소는 호가창을 그대로 쓰되 **테이커 수수료를 값에 녹인다**.
 * 수수료를 빼고 비교하면 0.05%짜리 차익은 전부 허깨비가 된다.
 */

/** 전신환 고시가 없을 때 쓰는 USD 기본 스프레드(1%). 국내 은행 관행값. */
const FALLBACK_TT_SPREAD = 0.01;
/** 엔화용 기본 스프레드(2%). 엔 전신환은 달러보다 스프레드가 넓다 — 고시를 못
 * 구했을 때 낙관적으로 잡으면 없는 차익을 만들므로 넉넉히 쓴다. */
const FALLBACK_YEN_TT_SPREAD = 0.02;

export function derivedSpreads(forex, fallbackSpread = FALLBACK_TT_SPREAD) {
  const buy = forex.ttSelling && forex.base ? (forex.ttSelling - forex.base) / forex.base : null;
  const sell = forex.ttBuying && forex.base ? (forex.base - forex.ttBuying) / forex.base : null;
  return {
    buy: buy && buy > 0 ? buy : fallbackSpread,
    sell: sell && sell > 0 ? sell : fallbackSpread,
    derived: Boolean(buy && sell),
  };
}

/**
 * @param {object} args
 * @param {object} args.market  fetchMarket() 결과
 * @param {object} args.config
 * @param {object} [args.manualQuotes]  `/시세입력` 으로 넣은 실측값 { toss: { buy, sell, at } }
 * @param {number} [args.now]
 */
export function buildQuotes({ market, config, manualQuotes = {}, now = Date.now() }) {
  const { forex } = market;
  const spreads = derivedSpreads(forex);
  const ttlMs = (config.manualQuoteTtlMinutes ?? 360) * 60_000;

  const banks = Object.entries(config.banks ?? {}).map(([id, bank]) => {
    const buySpread = bank.spread ?? spreads.buy;
    const sellSpread = bank.spread ?? spreads.sell;
    const quote = {
      id,
      label: bank.label ?? id,
      buy: forex.base * (1 + buySpread * (1 - bank.prefBuy)),
      sell: forex.base * (1 - sellSpread * (1 - bank.prefSell)),
      manual: null,
    };

    // 실측 입력이 살아 있으면 그 쪽이 진실이다. 모형은 어디까지나 추정.
    const manual = manualQuotes[id];
    if (manual && now - (manual.at ?? 0) <= ttlMs) {
      if (typeof manual.buy === "number") quote.buy = manual.buy;
      if (typeof manual.sell === "number") quote.sell = manual.sell;
      quote.manual = { at: manual.at, buy: manual.buy ?? null, sell: manual.sell ?? null };
    }
    return quote;
  });

  const exchanges = Object.entries(market.exchanges ?? {}).map(([id, book]) => {
    const fee = config.exchanges?.[id]?.takerFee ?? 0;
    return {
      id,
      label: config.exchanges?.[id]?.label ?? id,
      ask: book.ask,
      bid: book.bid,
      /** 테더 1개를 지금 사는 데 드는 원화(수수료 포함). */
      buyCost: book.ask * (1 + fee),
      /** 테더 1개를 지금 팔아 손에 쥐는 원화(수수료 차감). */
      sellProceeds: book.bid * (1 - fee),
      fee,
    };
  });

  // 엔화·JPYC — USD 파이프라인과 독립이다. 엔 고시가 없으면 통째로 null 이고,
  // JPYC 호가가 없으면 엔 뱅크 모형만 남는다(신호는 둘 다 있어야 뜬다).
  const yen = market.jpy ? buildYenQuotes({ jpy: market.jpy, jpyc: market.jpyc, config }) : null;

  return {
    banks,
    exchanges,
    spreads,
    bestBankBuy: pick(banks, (a, b) => a.buy < b.buy), // 가장 싸게 사는 곳
    bestBankSell: pick(banks, (a, b) => a.sell > b.sell), // 가장 비싸게 파는 곳
    bestExchangeBuy: pick(exchanges, (a, b) => a.buyCost < b.buyCost),
    bestExchangeSell: pick(exchanges, (a, b) => a.sellProceeds > b.sellProceeds),
    yen,
  };
}

/**
 * 엔화 은행 모형 — USD 모형과 같은 공식을 엔 기준율(1엔당 원화)에 적용한다.
 *
 * 우대율은 `config.banks` 의 USD 값을 그대로 재사용한다 (통화별로 관리하면
 * 설정이 두 배가 되는데, 실측 보정은 USD 쪽만 필요하다고 판단했다).
 * `/시세입력` 실측은 USD 전용이므로 여기엔 적용하지 않는다 — 실측값에 통화
 * 표시가 없어 USD 값을 엔에 섞으면 160배 오류가 된다.
 *
 * JPYC 는 업비트에만 상장돼 있어 거래소 목록 대신 단일 quote 로 둔다.
 * 수수료는 업비트 테이커 수수료(config.exchanges.upbit.takerFee)를 재사용한다 —
 * 같은 거래소의 같은 KRW 마켓이라 요율이 같다.
 */
function buildYenQuotes({ jpy, jpyc, config }) {
  const yenSpreads = derivedSpreads(jpy, FALLBACK_YEN_TT_SPREAD);
  const fee = config.exchanges?.upbit?.takerFee ?? 0;

  const banks = Object.entries(config.banks ?? {}).map(([id, bank]) => {
    const buySpread = bank.spread ?? yenSpreads.buy;
    const sellSpread = bank.spread ?? yenSpreads.sell;
    return {
      id,
      label: bank.label ?? id,
      buy: jpy.base * (1 + buySpread * (1 - bank.prefBuy)),
      sell: jpy.base * (1 - sellSpread * (1 - bank.prefSell)),
      manual: null,
    };
  });

  return {
    banks,
    spreads: yenSpreads,
    bestBankBuy: pick(banks, (a, b) => a.buy < b.buy),
    bestBankSell: pick(banks, (a, b) => a.sell > b.sell),
    jpyc: jpyc
      ? {
          id: "jpyc",
          label: "업비트",
          ask: jpyc.ask,
          bid: jpyc.bid,
          /** JPYC 1개(=1엔)를 지금 사는 데 드는 원화(수수료 포함). */
          buyCost: jpyc.ask * (1 + fee),
          /** JPYC 1개를 지금 팔아 손에 쥐는 원화(수수료 차감). */
          sellProceeds: jpyc.bid * (1 - fee),
          fee,
        }
      : null,
  };
}

function pick(list, better) {
  return list.reduce((best, item) => (best == null || better(item, best) ? item : best), null);
}
