FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN npm install --production=false || true
COPY . .
RUN npm run build
CMD ["npm", "start"]
