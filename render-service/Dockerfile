# Open Code War — 온디맨드 OG 렌더 서비스.
# 빌드 컨텍스트는 레포 루트다(Coolify: Base Directory = /, Dockerfile = render-service/Dockerfile).
# 그래야 공용 로직(scripts/og-lib.mjs)과 템플릿(web/og-user.html)을 함께 담을 수 있다.

FROM node:22-bookworm-slim

# system Chromium + 한글(CJK) 폰트. puppeteer-core 는 이 크로미움을 실행만 한다(브라우저 미다운로드).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium fonts-noto-cjk fonts-noto-color-emoji ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY render-service/package.json ./
RUN npm install --omit=dev

# 서버 + 공용 로직 + 템플릿을 같은 디렉토리에 평탄화해 둔다(server.mjs 가 ./ 로 참조).
COPY render-service/server.mjs ./
COPY scripts/og-lib.mjs ./
COPY web/og-user.html ./

EXPOSE 3000
CMD ["node", "server.mjs"]
