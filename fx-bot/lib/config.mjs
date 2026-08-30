/**
 * 봇 설정 — 기본값 + `fx-bot/config.json` 병합 + 환경변수
 *
 * 임계값은 전부 **퍼센트 숫자**다 (0.3 = 0.3%). 소수(0.003)로 쓰면
 * 100배 예민해져서 알림이 쏟아지므로, 여기서 단위를 하나로 못박는다.
 *
 * 은행/핀테크는 공개 시세 API가 없다. 그래서 이 봇은 은행 환율을
 * **매매기준율 + (스프레드 × (1 − 우대율))** 로 모형화한다. 실제 앱에 찍힌
 * 환율과 다르면 `config.json`의 우대율을 고치거나, 텔레그램에서
 * `/시세입력 토스 매수 1391.2` 로 실측값을 덮어쓴다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOT_DIR = path.resolve(HERE, "..");

/**
 * 기본 설정.
 *
 * `spread: null` 은 "매매기준율 제공처(하나은행)의 전신환 스프레드를 그대로
 * 쓴다"는 뜻이다. 두나무 응답의 `ttSellingPrice/basePrice` 에서 뽑아 쓴다.
 * 숫자를 넣으면 그 값(비율, 0.01 = 1%)이 우선한다.
 */
export const DEFAULTS = {
  /** 시세를 몇 초마다 확인할지. 두나무·업비트 모두 초당 수 회까지 허용하지만 예의상 60초. */
  pollSeconds: 60,

  /** 알림에 "1,000만원 굴리면 +42,000원" 식으로 환산해 보여줄 기준 금액(원). */
  notional: 10_000_000,

  /** 수동 입력(`/시세입력`)한 환율을 몇 분 동안 유효하게 볼지. */
  manualQuoteTtlMinutes: 360,

  banks: {
    toss: { label: "토스뱅크", spread: null, prefBuy: 1.0, prefSell: 1.0 },
    kakaobank: { label: "카카오뱅크", spread: null, prefBuy: 1.0, prefSell: 1.0 },
    switchen: { label: "스위치원", spread: null, prefBuy: 0.95, prefSell: 0.95 },
    hana: { label: "하나은행", spread: null, prefBuy: 0.9, prefSell: 0.9 },
  },

  exchanges: {
    /** 원화마켓 테이커 수수료(비율). 쿠폰·등급에 따라 다르니 본인 값으로 고칠 것. */
    upbit: { label: "업비트", takerFee: 0.0005, enabled: true },
    bithumb: { label: "빗썸", takerFee: 0.0004, enabled: true },
    // 코인원도 러너에서 열리는 걸 확인했다(diagnose). 다만 수수료가 등급·쿠폰에
    // 따라 크게 달라서, 본인 값을 확인하고 켜라고 꺼둔다 — 수수료를 틀리게 넣으면
    // 없는 차익이 있다고 나온다.
    coinone: { label: "코인원", takerFee: 0.002, enabled: false },
  },

  thresholds: {
    /** 달러 → 테더 갈아타기 이득률(%). 은행 달러 매도 대금으로 테더를 살 때 남는 폭. */
    toTetherPct: 0.3,
    /** 테더 → 달러 갈아타기 이득률(%). */
    toDollarPct: 0.3,
    /** 두 다리를 동시에 다 먹을 수 있을 때(즉시 왕복 차익, %). 거의 안 뜨지만 뜨면 큰 신호. */
    roundTripPct: 0.6,
    /** 은행 간 즉시 차익(%) — 최저가 매수처와 최고가 매도처의 벌어짐. */
    bankGapPct: 0.2,
    /** 거래소 간 테더 가격차(%). */
    exchangeGapPct: 0.3,
    /** 급변동 감지: 창(분) 안에서 매매기준율이 이만큼(%) 움직이면. */
    movePct: 0.4,
    moveWindowMinutes: 30,
    /** 지정가 알림. 원화 값 또는 null. 매수는 "최저 매수 환율", 매도는 "최고 매도 환율" 기준. */
    usdBuyBelow: null,
    usdSellAbove: null,
  },

  alerts: {
    /** 같은 신호를 다시 보내기까지 최소 간격(분). */
    cooldownMinutes: 30,
    /** 쿨다운 중이라도 직전 알림보다 이만큼(%p) 더 좋아지면 즉시 재알림. */
    escalationPct: 0.1,
    /** 신호가 풀렸을 때 "해제" 알림을 보낼지. */
    recoverNotice: true,
  },

  digest: {
    /** 정기 시세 요약 주기(분). 0 이면 끔. */
    everyMinutes: 60,
    /** 조용한 시간대(KST, from 이상 ~ to 미만). 요약은 무조건 쉰다. */
    quietHours: { from: 23, to: 7, muteAlerts: false },
  },

  telegram: {
    /** 텔레그램 명령(/시세, /신호 …)을 받을지. 끄면 일방 알림만 한다. */
    commands: true,
  },
};

/** 사람이 쓰기 쉬운 별칭 → 내부 키. `/시세입력 토스 …` 처럼 한글로 쓰게. */
export const VENUE_ALIASES = {
  토스: "toss",
  토스뱅크: "toss",
  toss: "toss",
  카뱅: "kakaobank",
  카카오: "kakaobank",
  카카오뱅크: "kakaobank",
  kakao: "kakaobank",
  kakaobank: "kakaobank",
  스위치원: "switchen",
  switchen: "switchen",
  하나: "hana",
  하나은행: "hana",
  hana: "hana",
  업비트: "upbit",
  upbit: "upbit",
  빗썸: "bithumb",
  bithumb: "bithumb",
};

/** 깊은 병합 — 사용자가 일부 키만 적어도 나머지 기본값이 살아남게. */
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 설정 로드.
 *
 * 토큰·챗ID는 파일이 아니라 **환경변수**로 받는다. 실수로 커밋되는 사고가
 * 제일 흔한 유출 경로라서다.
 */
export function loadConfig({ env = process.env, configPath } = {}) {
  const file = configPath ?? env.FX_BOT_CONFIG ?? path.join(BOT_DIR, "config.json");
  let fileConfig = {};
  if (fs.existsSync(file)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`설정 파일을 읽지 못했습니다 (${file}): ${error.message}`);
    }
  }

  const config = deepMerge(DEFAULTS, fileConfig);

  config.token = env.TELEGRAM_BOT_TOKEN ?? "";
  config.chatIds = String(env.TELEGRAM_CHAT_ID ?? "")
    .split(/[,\s]+/)
    .filter(Boolean);
  config.statePath = env.FX_BOT_STATE ?? path.join(BOT_DIR, "state.json");
  config.configPath = file;

  const problems = validateConfig(config);
  if (problems.length) throw new Error(`설정 오류:\n- ${problems.join("\n- ")}`);
  return config;
}

/** 눈에 띄는 실수만 잡는다. 여기서 막지 않으면 "알림이 안 온다"로 나타나서 원인 찾기가 어렵다. */
export function validateConfig(config) {
  const problems = [];
  if (!config.token) problems.push("TELEGRAM_BOT_TOKEN 환경변수가 비어 있습니다.");
  if (!config.chatIds.length) problems.push("TELEGRAM_CHAT_ID 환경변수가 비어 있습니다.");
  if (!(config.pollSeconds >= 5)) problems.push("pollSeconds 는 5 이상이어야 합니다.");

  for (const [id, bank] of Object.entries(config.banks ?? {})) {
    for (const key of ["prefBuy", "prefSell"]) {
      const value = bank[key];
      if (typeof value !== "number" || value < 0 || value > 1) {
        problems.push(`banks.${id}.${key} 는 0~1 사이 우대율이어야 합니다 (지금: ${value}).`);
      }
    }
    if (bank.spread != null && !(bank.spread >= 0 && bank.spread < 0.2)) {
      problems.push(`banks.${id}.spread 는 비율입니다. 1% 는 0.01 로 적습니다 (지금: ${bank.spread}).`);
    }
  }

  for (const [id, exchange] of Object.entries(config.exchanges ?? {})) {
    const fee = exchange.takerFee;
    if (typeof fee !== "number" || fee < 0 || fee > 0.02) {
      problems.push(`exchanges.${id}.takerFee 는 비율입니다. 0.05% 는 0.0005 로 적습니다 (지금: ${fee}).`);
    }
  }

  for (const [key, value] of Object.entries(config.thresholds ?? {})) {
    if (value == null) continue;
    if (typeof value !== "number" || Number.isNaN(value)) problems.push(`thresholds.${key} 가 숫자가 아닙니다.`);
    if (key.endsWith("Pct") && value > 20) {
      problems.push(`thresholds.${key} 가 ${value} 입니다. 퍼센트 단위(0.3 = 0.3%)가 맞는지 확인하세요.`);
    }
  }
  return problems;
}
