import { startServer } from "./server";

const running = await startServer(Number(process.env.PORT ?? 8080));
console.log(`mock-llm listening on ${running.port}`);

const shutdown = () => {
  void running.stop().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
