/**
 * 텔레그램 Bot API 최소 구현
 *
 * 웹훅을 쓰지 않는다. 공인 IP·인증서 없이 집 PC나 라즈베리파이에서 그냥
 * 돌리려면 롱폴링(getUpdates)이 맞다.
 */

const API = "https://api.telegram.org";

export function createBot({ token, chatIds, fetchImpl = fetch }) {
  const call = async (method, body, { timeoutMs = 15_000 } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!payload?.ok) {
        throw new Error(`텔레그램 ${method} 실패: ${payload?.description ?? `HTTP ${response.status}`}`);
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    /** 등록된 모든 chat 으로 보낸다. 하나가 실패해도 나머지는 보낸다. */
    async send(text, { chatId } = {}) {
      const targets = chatId ? [chatId] : chatIds;
      const results = await Promise.allSettled(
        targets.map((id) =>
          call("sendMessage", {
            chat_id: id,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") console.error(`[fx-bot] ${result.reason?.message ?? result.reason}`);
      }
      return results;
    },

    /**
     * 새 메시지 수신. `timeoutSeconds` 동안 서버가 붙들고 있다가 응답한다
     * (롱폴링). 반환값의 offset 을 다음 호출에 넘겨야 같은 메시지를 두 번
     * 처리하지 않는다.
     */
    async getUpdates(offset, timeoutSeconds = 25) {
      return call(
        "getUpdates",
        { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
        { timeoutMs: (timeoutSeconds + 10) * 1000 },
      );
    },
  };
}

/**
 * 명령 파싱. `/시세`, `/rate@my_bot`, `/임계 toTetherPct 0.25` 를 모두 받는다.
 * 명령이 아니면 null.
 */
export function parseCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...args] = trimmed.split(/\s+/);
  return { name: head.slice(1).split("@")[0].toLowerCase(), args };
}

/**
 * 남의 챗에서 온 메시지는 그냥 버린다.
 *
 * 봇 토큰만 알면 누구나 말을 걸 수 있다. 이 봇은 내 자산 상태를 다루므로
 * 허용된 chat id 외에는 **응답조차 하지 않는다** (존재를 알려줄 이유도 없다).
 */
export function isAllowedChat(message, chatIds) {
  const id = String(message?.chat?.id ?? "");
  return chatIds.map(String).includes(id);
}
