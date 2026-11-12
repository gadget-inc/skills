FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci && npx prisma generate && npm run build
ENV NODE_ENV=production
ENV INNGEST_DEV=1
CMD ["npm", "run", "docker-start"]
