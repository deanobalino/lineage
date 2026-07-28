#!/usr/bin/env node

import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("dist/lineage-capture.mjs");
await mkdir(resolve("dist"), { recursive: true });
await build({
  entryPoints: [resolve("src/capture/cli.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" }
});
await chmod(output, 0o755);
process.stdout.write(`${output}\n`);
