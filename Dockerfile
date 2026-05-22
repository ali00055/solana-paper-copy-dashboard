FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data

COPY package.json ./
COPY *.mjs ./
COPY *.json ./
COPY deploy ./deploy

RUN mkdir -p /data

EXPOSE 8787

CMD ["node", "deploy/start-all.mjs"]
