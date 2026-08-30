# 상주 실행용 이미지 (NAS·VPS·Fly.io 등)
#
#   docker build -f fx-bot/deploy/Dockerfile -t fx-bot .
#   docker run -d --name fx-bot --restart unless-stopped \
#     --env-file fx-bot/deploy/fx-bot.env \
#     -v fx-bot-state:/state \
#     -v "$PWD/fx-bot/config.json:/app/fx-bot/config.json:ro" \
#     fx-bot
#
# 봇은 외부 의존성이 없다 (Node 내장 fetch 만 쓴다). 그래서 npm install 단계가
# 아예 없고, 이미지에 들어가는 건 fx-bot/ 소스뿐이다.
FROM node:22-alpine

# 시각 표시와 조용한 시간 판정이 KST 기준이다. Intl 데이터는 node:alpine 에
# 들어 있지만 tzdata 가 없으면 컨테이너 로컬 시간이 UTC 로 어긋난다.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Seoul

WORKDIR /app
COPY fx-bot ./fx-bot

# 상태는 볼륨에 둔다. 컨테이너를 지웠다 만들어도 쿨다운·시세 기록이 살아남아야
# 같은 알림이 다시 오지 않는다.
ENV FX_BOT_STATE=/state/state.json
RUN mkdir -p /state && chown -R node:node /state /app

USER node
# 헬스체크: 상태 파일이 최근 10분 안에 갱신됐는지 본다. 시세 확인은 기본 60초
# 주기라, 10분간 갱신이 없으면 루프가 멈춘 것이다.
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m \
  CMD node -e 'const s=require("fs").statSync(process.env.FX_BOT_STATE);process.exit(Date.now()-s.mtimeMs<600000?0:1)'

CMD ["node", "fx-bot/index.mjs"]
