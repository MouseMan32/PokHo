FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
RUN npm run build

FROM nginx:alpine
# use our nginx config
COPY nginx.conf /etc/nginx/nginx.conf
# static assets
COPY --from=build /app/dist/ /usr/share/nginx/html
EXPOSE 80
