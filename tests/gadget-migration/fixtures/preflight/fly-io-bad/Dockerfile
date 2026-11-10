# syntax = docker/dockerfile:1
FROM node:22-alpine
LABEL fly_launch_runtime="Node.js"
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
