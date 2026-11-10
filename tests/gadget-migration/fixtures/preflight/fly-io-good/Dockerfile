FROM node:22-alpine
RUN apk add --no-cache openssl tzdata

ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) sha=cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123 ;; \
      arm64) sha=4ae22576a78223d8ccdf5f3b3660a5cbb5288416bf0ca96afc4a36d195932b94 ;; \
      *) echo "no Supercronic checksum for ${TARGETARCH}"; exit 1 ;; \
    esac \
 && wget -qO /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v0.2.51/supercronic-linux-${TARGETARCH:-amd64}" \
 && echo "${sha}  /usr/local/bin/supercronic" | sha256sum -c - \
 && chmod +x /usr/local/bin/supercronic

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ARG VITE_APP_ENV
RUN npx prisma generate
RUN npm run build

CMD ["npm", "run", "start"]
