import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const next = require.resolve("next/dist/bin/next");
const environment = {
  ...process.env,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
  CLERK_SECRET_KEY: "",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
  NEXT_TELEMETRY_DISABLED: "1",
};

async function main() {
  const build = spawn(process.execPath, [next, "build"], { env: environment, stdio: "inherit" });
  const [code] = await once(build, "exit");
  assert.equal(code, 0, "Production build must pass with blank application credentials");

  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));

  const server = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  let exited = false;
  server.stdout.on("data", chunk => { logs += String(chunk); });
  server.stderr.on("data", chunk => { logs += String(chunk); });
  const stopped = once(server, "exit").then(() => { exited = true; });
  try {
    const deadline = Date.now() + 30_000;
    let response;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Preview server exited before it was ready: ${logs}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/preview`, { signal: AbortSignal.timeout(2000), redirect: "manual" });
        break;
      } catch {
        await delay(150);
      }
    }
    assert(response, `Preview server did not become ready: ${logs}`);
    assert.equal(response.status, 200, `Preview response failed: ${logs}`);
    const html = await response.text();
    assert(html.includes("honojs/hono"), "Preview must render the real fixture");
    assert(html.includes("category-sidebar") && html.includes("detail-column"), "Preview must render the three-column shell");
    assert(!html.includes("clerk.browser.js"), "Preview must not load Clerk");
    const protectedResponse = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    await protectedResponse.arrayBuffer();
    assert.equal(protectedResponse.status, 500, "Workspace must fail loudly with missing configuration");
    assert(logs.includes("Missing environment variable NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"), "Workspace must report the missing configuration");
    console.log("Offline preview: HTTP 200; real fixture and three-column shell rendered; Clerk not loaded.");
    console.log("Blank credentials: production build passed; protected workspace failed loudly as required.");
  } finally {
    if (!exited) server.kill();
    await stopped;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
