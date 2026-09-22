import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";
await import("./build-electron.mjs");
const server = await createServer();
await server.listen();
const env = { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { stdio: "inherit", env });
child.on("exit", () => {
  server.close();
  process.exit();
});
process.on("SIGINT", () => {
  child.kill();
  server.close();
});
