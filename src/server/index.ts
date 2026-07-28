import { buildApp } from "./app.js";
import { serverConfig } from "./config.js";

const config = serverConfig();
const { app, bootstrap } = await buildApp(config);

if (bootstrap.operatorToken) {
  app.log.warn(
    {
      operatorToken: bootstrap.operatorToken,
      captureToken: bootstrap.captureToken
    },
    "First-run credentials. Store them now; they will not be displayed again."
  );
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
