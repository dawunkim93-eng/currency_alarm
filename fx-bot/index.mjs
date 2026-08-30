#!/usr/bin/env node
/**
 * 환율·테더 알림 봇 (실행부)
 *
 *   node fx-bot/index.mjs             # 상주 모드 — 주기적으로 확인하고 명령도 받는다
 *   node fx-bot/index.mjs --once      # 1회 확인 후 종료 (cron / GitHub Actions 용)
 *   node fx-bot/index.mjs --dry-run   # 텔레그램으로 보내지 않고 화면에 출력
 *
 * 환경변수
 *   TELEGRAM_BOT_TOKEN  @BotFather 에서 받은 토큰
 *   TELEGRAM_CHAT_ID    받을 chat id (쉼표로 여러 개)
 *   FX_BOT_CONFIG       설정 파일 경로 (기본 fx-bot/config.json)
 *   FX_BOT_STATE        상태 파일 경로 (기본 fx-bot/state.json)
 *
 * 설계 메모: 시세 확인과 명령 수신을 **한 루프**에서 돌린다. 두 개를 따로
 * 돌리면 상태 파일을 동시에 쓰다가 알림 쿨다운 기록이 날아간다. 다음 확인까지
 * 남은 시간만큼 텔레그램 롱폴링으로 대기하므로 놀고 있는 시간이 없다.
 */
import { loadConfig } from "./lib/config.mjs";
import { fetchMarket } from "./lib/sources.mjs";
import { buildQuotes } from "./lib/venues.mjs";
import { evaluate, selectAlerts } from "./lib/signals.mjs";
import { applyOverrides, loadState, pushHistory, saveState } from "./lib/state.mjs";
import { createBot, isAllowedChat, parseCommand } from "./lib/telegram.mjs";
import { handleCommand } from "./lib/commands.mjs";
import { formatAlert, formatDigest, formatRates, formatRecovered, isQuietHour, kstTime } from "./lib/format.mjs";

const argv = process.argv.slice(2);
const flags = new Set(argv);
const ONCE = flags.has("--once");
const DRY_RUN = flags.has("--dry-run");
const NO_HELLO = flags.has("--no-hello") || ONCE;

/**
 * `--max-runtime 3300` (초) 뒤에 스스로 종료한다.
 *
 * GitHub Actions 처럼 "정해진 시간만 살 수 있는" 곳에서 상주하기 위한 것이다.
 * 러너가 강제로 죽이면 상태를 저장할 틈이 없어 쿨다운 기록이 날아가고, 다음
 * 실행에서 같은 알림이 다시 온다. 스스로 나가면 그럴 일이 없다.
 */
const MAX_RUNTIME_MS = (() => {
  const index = argv.indexOf("--max-runtime");
  const raw = index >= 0 ? argv[index + 1] : process.env.FX_BOT_MAX_RUNTIME;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
})();

/** 시세 수집이 연속으로 이만큼 실패하면 "봇이 눈을 감았다"고 알린다. */
const FAILURE_ALERT_STREAK = 3;
/** 명령에 답할 때 이 시간 안에 받아온 시세면 다시 받지 않는다. */
const SNAPSHOT_TTL_MS = 20_000;
/** 시작 인사 최소 간격. 재시작 루프에서 인사가 도배되지 않게. */
const HELLO_THROTTLE_MS = 60 * 60_000;

if (DRY_RUN) {
  process.env.TELEGRAM_BOT_TOKEN ||= "dry-run";
  process.env.TELEGRAM_CHAT_ID ||= "0";
}

const config = loadConfig();
let state = loadState(config.statePath);

const bot = createBot({ token: config.token, chatIds: config.chatIds });
const send = DRY_RUN
  ? async (text) => console.log(`\n───── 텔레그램 메시지 ─────\n${stripHtml(text)}\n`)
  : (text, options) => bot.send(text, options);

let snapshotCache = null;

/** 지금 설정(파일 + 텔레그램에서 바꾼 값)을 합쳐 돌려준다. */
const effectiveConfig = () => applyOverrides(config, state);

async function takeSnapshot({ force = false, now = Date.now() } = {}) {
  if (!force && snapshotCache && now - snapshotCache.at <= SNAPSHOT_TTL_MS) return snapshotCache.value;

  const current = effectiveConfig();
  const market = await fetchMarket({ config: current });
  const quotes = buildQuotes({ market, config: current, manualQuotes: state.manualQuotes, now });
  const signals = evaluate({ market, quotes, config: current, history: state.history, now });

  const value = { market, quotes, signals };
  snapshotCache = { at: now, value };
  return value;
}

async function tick() {
  const now = Date.now();
  const current = effectiveConfig();
  const { market, quotes, signals } = await takeSnapshot({ force: true, now });

  state.history = pushHistory(state.history, { t: now, base: market.forex.base }, now);

  const muted = state.mutedUntil > now || (isQuietHour(current, now) && current.digest.quietHours.muteAlerts);

  if (!muted) {
    // 음소거 중에는 쿨다운 기록도 남기지 않는다. 그래야 음소거가 풀린 직후
    // 아직 살아 있는 신호를 다시 받는다 — "조용히 있는 동안 기회가 지나갔다"를 막는다.
    const { fresh, recovered, nextAlerts } = selectAlerts({ signals, state, config: current, now });
    state.alerts = nextAlerts;
    if (fresh.length) await send(formatAlert({ signals: fresh, market, quotes, config: current }));
    if (recovered.length) await send(formatRecovered({ signals: recovered, market, quotes }));
  }

  const digestDue =
    current.digest.everyMinutes > 0 &&
    now - (state.lastDigestAt ?? 0) >= current.digest.everyMinutes * 60_000 &&
    !isQuietHour(current, now) &&
    state.mutedUntil <= now;

  if (digestDue) {
    const since = state.lastDigestAt || null;
    state.lastDigestAt = now;
    await send(formatDigest({ signals, market, quotes, config: current, since }));
  }

  saveState(config.statePath, state);
  return { market, quotes, signals };
}

async function safeTick() {
  try {
    await tick();
    if (state.failStreak >= FAILURE_ALERT_STREAK) {
      await send(`✅ 시세 수집이 정상으로 돌아왔습니다. ${kstTime()}`);
    }
    state.failStreak = 0;
  } catch (error) {
    state.failStreak = (state.failStreak ?? 0) + 1;
    console.error(`[fx-bot] 시세 수집 실패 (${state.failStreak}회): ${error.message}`);
    // 매번 알리면 그 자체가 소음이다. 세 번 연속 실패했을 때 한 번만.
    if (state.failStreak === FAILURE_ALERT_STREAK) {
      await send(`⚠️ 시세를 ${FAILURE_ALERT_STREAK}회 연속 못 받았습니다.\n<code>${escape(error.message)}</code>`);
    }
    saveState(config.statePath, state);
  }
}

async function drainCommands(waitSeconds) {
  const updates = await bot.getUpdates(state.updateOffset || undefined, Math.max(0, Math.min(25, waitSeconds)));
  for (const update of updates ?? []) {
    state.updateOffset = update.update_id + 1;
    const message = update.message;
    if (!message || !isAllowedChat(message, config.chatIds)) continue;

    const command = parseCommand(message.text);
    if (!command) continue;

    try {
      const result = await handleCommand({
        command,
        state,
        config: effectiveConfig(),
        snapshot: () => takeSnapshot(),
      });
      state = result.state;
      if (result.reply) await send(result.reply, { chatId: message.chat.id });
    } catch (error) {
      console.error(`[fx-bot] 명령 처리 실패 /${command.name}: ${error.message}`);
      await send(`⚠️ /${command.name} 처리 중 오류: <code>${escape(error.message)}</code>`, {
        chatId: message.chat.id,
      });
    }
  }
  if (updates?.length) saveState(config.statePath, state);
}

async function main() {
  console.log(`[fx-bot] 시작 · 설정 ${config.configPath} · 상태 ${config.statePath}`);

  if (ONCE) {
    await safeTick();
    if (effectiveConfig().telegram.commands && !DRY_RUN) await drainCommands(0).catch(() => {});
    return;
  }

  // 상주 실행은 죽으면 자동 재시작(systemd Restart=always)된다. 크래시 루프에
  // 빠지면 켤 때마다 인사를 보내 알림창이 도배되므로, 1시간에 한 번만 인사한다.
  const helloDue = Date.now() - (state.lastHelloAt ?? 0) >= HELLO_THROTTLE_MS;
  if (!NO_HELLO && helloDue) {
    const snap = await takeSnapshot({ force: true }).catch(() => null);
    if (snap) {
      state.lastHelloAt = Date.now();
      await send(
        ["🤖 봇을 켰습니다. /도움 으로 명령을 볼 수 있습니다.", "", formatRates({ ...snap, config: effectiveConfig() })].join(
          "\n",
        ),
      );
    }
  }

  // 롱폴링 중에 신호를 받으면 루프 조건을 다시 보기까지 최대 25초가 걸린다.
  // 상태는 매 tick 마다 저장돼 있으니, 여기서 한 번 더 저장하고 바로 나간다.
  let stopping = false;
  const stop = (signal) => () => {
    if (stopping) process.exit(1); // 두 번 누르면 즉시
    stopping = true;
    console.log(`[fx-bot] ${signal} 수신 — 상태를 저장하고 종료합니다.`);
    saveState(config.statePath, state);
    process.exit(0);
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));

  const deadline = MAX_RUNTIME_MS ? Date.now() + MAX_RUNTIME_MS : Infinity;
  if (MAX_RUNTIME_MS) {
    const span =
      MAX_RUNTIME_MS >= 60_000 ? `${Math.round(MAX_RUNTIME_MS / 60_000)}분` : `${Math.round(MAX_RUNTIME_MS / 1000)}초`;
    console.log(`[fx-bot] ${span} 뒤 스스로 종료합니다.`);
  }

  let nextTickAt = 0;
  while (!stopping && Date.now() < deadline) {
    const now = Date.now();
    if (now >= nextTickAt) {
      await safeTick();
      nextTickAt = Date.now() + effectiveConfig().pollSeconds * 1000;
    }

    // 마감을 넘겨 대기하지 않는다. 롱폴링에 25초를 걸어두면 그만큼 늦게 나간다.
    const waitMs = Math.max(0, Math.min(nextTickAt, deadline) - Date.now());
    if (effectiveConfig().telegram.commands && !DRY_RUN) {
      await drainCommands(Math.ceil(waitMs / 1000)).catch((error) => {
        // 409 는 같은 토큰으로 두 곳에서 롱폴링할 때 난다. 상주 실행 중에
        // GitHub Actions 나 다른 터미널에서 또 켠 경우가 대부분이다.
        if (/conflict/i.test(error.message)) {
          // 409 는 두 가지 원인이 있는데 대처가 서로 다르다. 텔레그램이 준
          // 설명을 그대로 보여줘야 어느 쪽인지 바로 안다.
          //   1) 같은 토큰으로 두 곳에서 롱폴링 중 → 하나만 남긴다
          //   2) 그 토큰에 웹훅이 걸려 있음 → deleteWebhook 으로 지운다
          console.error(`[fx-bot] ${error.message}`);
          console.error(
            "[fx-bot] 같은 봇 토큰을 다른 봇·다른 실행이 쓰고 있습니다. 하나만 남기거나,\n" +
              '         웹훅이 걸려 있으면 curl -s "https://api.telegram.org/bot<토큰>/deleteWebhook" 로 지우세요.',
          );
          return sleep(15_000);
        }
        console.error(`[fx-bot] 명령 수신 실패: ${error.message}`);
        return sleep(3000);
      });
    } else {
      await sleep(Math.min(waitMs, 5000));
    }
  }

  if (!stopping) {
    console.log("[fx-bot] 실행 시간이 끝나 종료합니다. 상태는 저장했습니다.");
    saveState(config.statePath, state);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stripHtml = (text) => String(text).replace(/<[^>]+>/g, "");

/**
 * 예기치 못한 예외로 죽더라도 **조용히 사라지지는 않게** 한다.
 *
 * 상주 실행에서 제일 위험한 실패는 크래시가 아니라 "죽은 줄 모르는 것"이다.
 * 상태를 저장하고 비정상 종료 코드로 나가면 systemd/도커가 다시 띄운다.
 */
const die = (label) => (error) => {
  console.error(`[fx-bot] ${label}: ${error?.stack ?? error}`);
  try {
    saveState(config.statePath, state);
  } catch (saveError) {
    console.error(`[fx-bot] 상태 저장도 실패: ${saveError.message}`);
  }
  process.exit(1);
};
process.on("uncaughtException", die("처리되지 않은 예외"));
process.on("unhandledRejection", die("처리되지 않은 거부"));

main().then(
  () => process.exit(0),
  die("실행 실패"),
);
