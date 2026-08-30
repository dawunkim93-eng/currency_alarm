#!/usr/bin/env bash
# 상주 실행 설치 (systemd)
#
#   sudo fx-bot/deploy/install-systemd.sh
#
# 하는 일
#   1. /etc/fx-bot.env 를 만든다 (없을 때만 · 600 · root 소유) → 토큰을 여기 적는다
#   2. fx-bot/config.json 을 만든다 (없을 때만)
#   3. 경로·계정을 채운 fx-bot.service 를 /etc/systemd/system 에 설치하고 켠다
#
# 여러 번 실행해도 안전하다. 이미 있는 설정 파일은 덮어쓰지 않는다.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/../.." && pwd)"
ENV_FILE="/etc/fx-bot.env"
UNIT_FILE="/etc/systemd/system/fx-bot.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "루트 권한이 필요합니다: sudo $0" >&2
  exit 1
fi

# sudo 로 실행하면 whoami 는 root 다. 봇은 저장소를 소유한 계정으로 돌리는 게 맞다.
RUN_USER="${SUDO_USER:-root}"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  # sudo 는 PATH 를 좁히므로, 실제 사용자 PATH 에서 한 번 더 찾아본다.
  NODE_BIN="$(sudo -u "$RUN_USER" bash -lc 'command -v node' || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "node 를 찾지 못했습니다. Node 22 이상을 설치한 뒤 다시 실행하세요." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node 20 이상이 필요합니다 (지금: $("$NODE_BIN" -v)). 내장 fetch 를 씁니다." >&2
  exit 1
fi

# 1. 비밀값
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 -o root -g root "$DEPLOY_DIR/fx-bot.env.example" "$ENV_FILE"
  echo "생성: $ENV_FILE — 토큰과 chat id 를 채운 뒤 다시 실행하세요."
  NEEDS_SECRETS=1
else
  echo "그대로 둠: $ENV_FILE"
  NEEDS_SECRETS=0
fi

# 2. 설정
if [ ! -f "$REPO_DIR/fx-bot/config.json" ]; then
  install -m 644 -o "$RUN_USER" "$REPO_DIR/fx-bot/config.example.json" "$REPO_DIR/fx-bot/config.json"
  echo "생성: fx-bot/config.json — 우대율·임계값을 본인 상황에 맞게 고치세요."
else
  echo "그대로 둠: fx-bot/config.json"
fi

# 3. 유닛
sed -e "s|__USER__|$RUN_USER|g" -e "s|__REPO__|$REPO_DIR|g" -e "s|__NODE__|$NODE_BIN|g" \
  "$DEPLOY_DIR/fx-bot.service" > "$UNIT_FILE"
chmod 644 "$UNIT_FILE"
systemctl daemon-reload
echo "설치: $UNIT_FILE (사용자 $RUN_USER · node $("$NODE_BIN" -v))"

if [ "$NEEDS_SECRETS" -eq 1 ]; then
  cat <<EOF

아직 켜지 않았습니다. 토큰을 채우고 켜세요.

  sudo nano $ENV_FILE
  sudo systemctl enable --now fx-bot
EOF
  exit 0
fi

systemctl enable --now fx-bot
sleep 2
systemctl --no-pager --lines=15 status fx-bot || true

cat <<EOF

이제부터
  로그      journalctl -u fx-bot -f
  재시작    sudo systemctl restart fx-bot
  설정 변경 fx-bot/config.json 수정 후 재시작 (임계값은 텔레그램 /임계 로 즉시 변경 가능)
EOF
