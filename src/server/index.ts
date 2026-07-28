import { buildApp } from "./app.js";
import { serverConfig } from "./config.js";

const config = serverConfig();
const { app, captureApp, bootstrap, services } = await buildApp(config);

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
  await captureApp.listen({ host: config.captureHost, port: config.capturePort });
  await services.capture.replay();
  const replayTimer = setInterval(() => {
    void services.capture.replay();
  }, 5_000);
  replayTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(replayTimer);
    await captureApp.close();
  });
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await captureApp.close();
  process.exitCode = 1;
}
