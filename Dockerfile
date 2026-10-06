# +1 Speed Skateboard Escape - Colyseus game server for Bloxity Legion.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Legion injects PORT (2567); HTTP + WebSocket share it.
EXPOSE 2567
USER node
CMD ["node", "src/index.js"]
