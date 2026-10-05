FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=3100
USER node
EXPOSE 3100
CMD ["node", "server.js"]
