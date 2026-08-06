# Image Glama (and any container-based MCP runner) uses to start the server and
# run MCP introspection. The server starts and lists its tools without any
# credentials; a BASICDEPLOY_API_KEY is only needed to actually call a tool.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENTRYPOINT ["node", "src/index.js"]
