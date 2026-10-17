FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

RUN npx playwright install --with-deps chromium

COPY backend backend
COPY frontend frontend
COPY .env.example .env.example
RUN npm run build

ENV NODE_ENV=production
ENV DATA_DIR=/var/data
EXPOSE 10000

CMD ["npm", "run", "start", "--workspace", "backend"]
