FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

COPY . .
ENV PORT=8080 SAVES_DIR=/data/saves
EXPOSE 8080
CMD ["node","index.js"]
