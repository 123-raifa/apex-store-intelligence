FROM node:22 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/events.jsonl ./events.jsonl
COPY package*.json ./
RUN npm install --omit=dev
EXPOSE 3000
CMD ["npm", "start"]