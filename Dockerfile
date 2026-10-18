FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && npm cache clean --force
COPY core.mjs pickup-monitor.mjs stock-history.mjs stock-history-view.js pickup-page.js ./
COPY server ./server
RUN mkdir -p /app/data && chown -R node:node /app /ms-playwright
USER node
ENV HOST=0.0.0.0 PORT=8787 MONITOR_DATA_DIR=/app/data
EXPOSE 8787
CMD ["node", "server/index.mjs"]
