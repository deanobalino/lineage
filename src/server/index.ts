import { buildApp } from "./app.js";
import { serverConfig } from "./config.js";
import { safeReplay } from "./capture/capture-service.js";

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

let captureListening = false;
let replayTimer: NodeJS.Timeout | undefined;
try {
  await captureApp.listen({ host: config.captureHost, port: config.capturePort });
  captureListening = true;
} catch (error) {
  app.log.error({ err: error }, "capture listener unavailable; browser service will continue");
}

app.addHook("onClose", async () => {
  if (replayTimer) clearInterval(replayTimer);
  if (captureListening) await captureApp.close();
});

let browserListening = false;
try {
  await app.listen({ host: config.host, port: config.port });
  browserListening = true;
} catch (error) {
  app.log.error(error);
  if (captureListening) await captureApp.close();
  process.exitCode = 1;
}

if (browserListening && captureListening) {
  await safeReplay(services.capture, app.log);
  replayTimer = setInterval(() => {
    void safeReplay(services.capture, app.log);
  }, 5_000);
  replayTimer.unref();
}
