FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js config.json ./

EXPOSE 8080
CMD ["npm", "start"]
