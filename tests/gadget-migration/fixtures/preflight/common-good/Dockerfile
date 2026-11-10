FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .
RUN npx prisma generate
RUN npm run build
CMD ["npm", "run", "start"]
