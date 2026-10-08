FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8080 DATABASE_PATH=/app/data/wallet.sqlite
EXPOSE 8080
CMD ["node", "src/server.js"]
