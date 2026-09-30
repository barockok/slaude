FROM node:22-alpine
WORKDIR /app
COPY main.mjs ./
ENV PORT=8080
EXPOSE 8080
USER node
HEALTHCHECK --interval=5s --timeout=2s --retries=10 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "main.mjs"]
