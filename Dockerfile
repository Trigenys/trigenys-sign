FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production PORT=8790 DATA_DIR=/data
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
USER app
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8790/api/config >/dev/null || exit 1
CMD ["node", "dist/src/index.js"]
