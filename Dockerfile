# Playwright 공식 이미지에 Chromium + 필요한 OS 의존성이 이미 설치되어 있어
# Render 같은 일반 Node 빌드팩에서 겪는 "playwright install"의 apt 권한 문제를 피할 수 있다.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

COPY package*.json ./
# npm ci는 package-lock.json에 고정된 버전 그대로 설치한다 - package.json의 playwright 버전이
# 위 이미지 태그와 어긋나면(브라우저 실행 파일 불일치) 캠핏/네이버 검색이 조용히 깨지므로,
# 버전 표류를 막기 위해 npm install 대신 npm ci를 쓴다. 이미지에 이미 맞는 버전의 Chromium이
# 들어있으므로 postinstall의 재다운로드는 건너뛴다.
RUN npm ci --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
EXPOSE 5173

CMD ["node", "server.js"]
