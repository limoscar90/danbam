# Playwright 공식 이미지에 Chromium + 필요한 OS 의존성이 이미 설치되어 있어
# Render 같은 일반 Node 빌드팩에서 겪는 "playwright install"의 apt 권한 문제를 피할 수 있다.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package*.json ./
# 이미지에 이 버전에 맞는 Chromium이 들어있으므로 postinstall의 재다운로드는 건너뛴다.
RUN npm install --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
EXPOSE 5173

CMD ["node", "server.js"]
