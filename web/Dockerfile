FROM node:20-alpine AS build
WORKDIR /app

# Install deps (use lockfile if present)
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund ; \
    else \
      npm install --no-audit --no-fund ; \
    fi

# Copy source and build
COPY . .
# Optional: print versions to help debugging
RUN node -v && npm -v
# Build (if this fails, the prebuild step above will already have shown why)
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist/ /usr/share/nginx/html
EXPOSE 80
