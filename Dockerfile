# CareCircle — runs the same image locally, on AWS App Runner, or on AWS Lambda (via Lambda Web Adapter).
FROM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:22-slim
# Lambda Web Adapter: lets this plain HTTP server run unchanged on Lambda (ignored elsewhere).
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
ENV NODE_ENV=production PORT=8080 AWS_LWA_READINESS_CHECK_PATH=/healthz
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
EXPOSE 8080
CMD ["node", "dist/server.js"]
