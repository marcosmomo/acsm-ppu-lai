FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY aas ./aas
COPY resources ./resources

RUN mkdir -p /app/data/logs

ENV NODE_ENV=production
ENV HTTP_PORT=3007
ENV MQTT_BROKER=acsm-mosquitto
ENV MQTT_PORT=1883
ENV CPS_LOG_DIR=/app/data/logs
ENV CPS_DATASHEET_PATH=/app/resources/datasheet.pdf

EXPOSE 3007

CMD ["node", "src/server.js"]
