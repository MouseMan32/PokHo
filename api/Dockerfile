
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm i --production
COPY index.js ./
ENV PORT=8080 SAVES_DIR=/data/saves
VOLUME ["/data/saves"]
EXPOSE 8080
CMD ["npm","start"]
