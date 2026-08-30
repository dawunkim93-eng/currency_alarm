/**
 * 텔레그램 명령 처리
 *
 * 순수 함수로 둔다 — 입력은 (명령, 현재 상태, 시세 스냅샷 함수), 출력은
 * (답장 문자열, 새 상태). 그래야 테스트에서 네트워크 없이 다 돌려볼 수 있다.
 *
 * 값을 바꾸는 명령은 전부 `state.overrides` 에 쌓인다. config.json 을 고치러
 * 서버에 들어가지 않아도 폰에서 임계값을 조일 수 있어야 하기 때문이다.
 */
import { DEFAULTS, VENUE_ALIASES, deepMerge, validateConfig } from "./config.mjs";
import { getPath, setPath } from "./state.mjs";
import { formatConfig, formatHelp, formatRates, formatSignals, kstTime, compactWon } from "./format.mjs";

/** `/설정값` 으로 바꿀 수 있는 경로. 아무 키나 열어두면 오타가 조용히 새 키를 만든다. */
const SETTABLE = new Set([
  "notional",
  "pollSeconds",
  "manualQuoteTtlMinutes",
  "digest.everyMinutes",
  "digest.quietHours.from",
  "digest.quietHours.to",
  "alerts.cooldownMinutes",
  "alerts.escalationPct",
  "alerts.recoverNotice",
]);

const SIDES = { 매수: "buy", 살때: "buy", buy: "buy", 매도: "sell", 팔때: "sell", sell: "sell" };

/** "1,391.2" → 1391.2 · "0.25%" → 0.25 · "90%" → 90 (우대율 변환은 호출부에서) */
export function parseNumber(raw) {
  if (raw == null) return null;
  const value = Number(String(raw).replace(/[,%\s원]/g, ""));
  return Number.isFinite(value) ? value : null;
}

export async function handleCommand({ command, state, config, snapshot, now = Date.now() }) {
  const { name, args } = command;
  const reply = (text) => ({ reply: text, state });
  const withState = (nextState, text) => ({ reply: text, state: nextState });

  switch (name) {
    case "start":
    case "help":
    case "도움":
    case "도움말":
      return reply(formatHelp());

    case "시세":
    case "rate":
    case "rates": {
      const snap = await snapshot();
      return reply(formatRates({ ...snap, config }));
    }

    case "신호":
    case "signal":
    case "signals": {
      const snap = await snapshot();
      return reply(formatSignals({ ...snap, config }));
    }

    case "설정":
    case "config":
    case "상태":
      return reply(formatConfig(config, state));

    case "임계":
    case "threshold": {
      const [key, rawValue] = args;
      if (!key) return reply("사용법: <code>/임계 toTetherPct 0.25</code>");
      if (!(key in DEFAULTS.thresholds)) {
        return reply(`모르는 임계값입니다: ${key}\n가능: ${Object.keys(DEFAULTS.thresholds).join(", ")}`);
      }
      if (rawValue === "해제" || rawValue === "off" || rawValue === "null") {
        return applyOverride({ state, config, path: `thresholds.${key}`, value: null, label: `${key} 끔` });
      }
      const value = parseNumber(rawValue);
      if (value == null) return reply(`숫자를 읽지 못했습니다: ${rawValue}`);
      return applyOverride({ state, config, path: `thresholds.${key}`, value, label: `${key} = ${value}` });
    }

    case "설정값":
    case "set": {
      const [path, rawValue] = args;
      if (!path || !SETTABLE.has(path)) {
        return reply(`바꿀 수 있는 값:\n${[...SETTABLE].map((key) => `· ${key}`).join("\n")}`);
      }
      const value =
        rawValue === "true" || rawValue === "false" ? rawValue === "true" : parseNumber(rawValue);
      if (value == null) return reply(`숫자를 읽지 못했습니다: ${rawValue}`);
      return applyOverride({ state, config, path, value, label: `${path} = ${value}` });
    }

    case "지정가":
    case "limit": {
      const [side, rawValue] = args;
      if (side === "해제" || side === "off") {
        let next = setPath(state.overrides, "thresholds.usdBuyBelow", null);
        next = setPath(next, "thresholds.usdSellAbove", null);
        return withState({ ...state, overrides: next }, "지정가 알림을 모두 껐습니다.");
      }
      const key = SIDES[side] === "buy" ? "usdBuyBelow" : SIDES[side] === "sell" ? "usdSellAbove" : null;
      if (!key) return reply("사용법: <code>/지정가 매수 1380</code> · <code>/지정가 해제</code>");
      const value = parseNumber(rawValue);
      if (value == null || value < 100 || value > 5000) return reply(`환율 값이 이상합니다: ${rawValue}`);
      return applyOverride({
        state,
        config,
        path: `thresholds.${key}`,
        value,
        label: `${SIDES[side] === "buy" ? "매수" : "매도"} 지정가 ${value.toLocaleString("ko-KR")}원`,
      });
    }

    case "시세입력":
    case "quote": {
      const [rawVenue, rawSide, rawValue] = args;
      const venue = VENUE_ALIASES[String(rawVenue ?? "").toLowerCase()];
      const side = SIDES[rawSide];
      const value = parseNumber(rawValue);
      if (!venue || !config.banks?.[venue]) return reply("사용법: <code>/시세입력 토스 매수 1391.2</code>");
      if (!side || value == null) return reply("사용법: <code>/시세입력 토스 매수 1391.2</code>");

      const previous = state.manualQuotes?.[venue] ?? {};
      const manualQuotes = { ...state.manualQuotes, [venue]: { ...previous, [side]: value, at: now } };
      const ttl = config.manualQuoteTtlMinutes;
      return withState(
        { ...state, manualQuotes },
        `📝 ${config.banks[venue].label} ${side === "buy" ? "매수" : "매도"} ${value.toLocaleString("ko-KR")}원 반영 (${ttl}분간 유효)`,
      );
    }

    case "우대":
    case "pref": {
      const [rawVenue, rawSide, rawValue] = args;
      const venue = VENUE_ALIASES[String(rawVenue ?? "").toLowerCase()];
      const side = SIDES[rawSide];
      let value = parseNumber(rawValue);
      if (!venue || !config.banks?.[venue] || !side || value == null) {
        return reply("사용법: <code>/우대 스위치원 매수 0.9</code> (90% 는 0.9 또는 90)");
      }
      if (value > 1) value /= 100; // "90" 이라고 쓰는 사람이 더 많다.
      if (value < 0 || value > 1) return reply("우대율은 0~1 사이여야 합니다.");
      const path = `banks.${venue}.${side === "buy" ? "prefBuy" : "prefSell"}`;
      return applyOverride({
        state,
        config,
        path,
        value,
        label: `${config.banks[venue].label} ${side === "buy" ? "매수" : "매도"}우대 ${(value * 100).toFixed(0)}%`,
      });
    }

    case "음소거":
    case "mute": {
      const minutes = parseNumber(args[0]) ?? 60;
      const until = now + minutes * 60_000;
      return withState({ ...state, mutedUntil: until }, `🔕 ${kstTime(until)} 까지 알림을 멈춥니다.`);
    }

    case "해제":
    case "unmute":
      return withState({ ...state, mutedUntil: 0 }, "🔔 알림을 다시 켰습니다.");

    default:
      return reply(`모르는 명령입니다: /${name}\n/도움 을 보세요.`);
  }
}

/** 오버라이드를 적용하되, 병합 결과가 설정 검증을 통과할 때만 저장한다. */
function applyOverride({ state, config, path, value, label }) {
  const overrides = setPath(state.overrides, path, value);
  const merged = deepMerge(config, overrides);
  const problems = validateConfig({ ...merged, token: config.token, chatIds: config.chatIds });
  if (problems.length) return { reply: `적용하지 않았습니다:\n- ${problems.join("\n- ")}`, state };

  const previous = getPath(config, path);
  const shown = path === "notional" ? compactWon(value) : String(value);
  return {
    reply: `✅ ${label} <i>(이전: ${previous ?? "없음"} → ${shown})</i>`,
    state: { ...state, overrides },
  };
}
