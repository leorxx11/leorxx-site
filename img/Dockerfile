FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY cli.js ./
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=3100 DB_PATH=/data/darkroom.db
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3100
CMD ["node", "src/server.js"]
