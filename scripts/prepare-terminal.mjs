import { chmod, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// Some node-pty release archives omit the executable bit on the PTY helper.
// Set it before development or packaging; packaged applications need no repair.
if (process.platform !== "win32") {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("node-pty/package.json"));
  async function prepare(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await prepare(file);
      else if (entry.name === "spawn-helper") await chmod(file, 0o755);
    }
  }
  await prepare(path.join(root, "prebuilds"));
  await prepare(path.join(root, "build"));
}
