FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm i --omit=dev --no-audit --no-fund; \
    fi

# IMPORTANT: copy the rest of the source (parsers/, store/, etc.)
COPY . .

# your ports
ENV PORT=8095 SAVES_DIR=/data/saves META_DIR=/data/meta
EXPOSE 8095
CMD ["node","index.js"]
