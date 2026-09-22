import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const seen = new Map();
async function visit(name, from) {
  const require = createRequire(from);
  let file;
  try {
    file = require.resolve(`${name}/package.json`);
  } catch {
    try {
      let dir = path.dirname(require.resolve(name));
      while (dir !== path.dirname(dir)) {
        try {
          const candidate = JSON.parse(
            await fs.readFile(path.join(dir, "package.json"), "utf8"),
          );
          if (candidate.name === name) {
            file = path.join(dir, "package.json");
            break;
          }
        } catch {}
        dir = path.dirname(dir);
      }
    } catch {
      return;
    }
  }
  if (!file) return;
  const pkg = JSON.parse(await fs.readFile(file, "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  const dir = path.dirname(file);
  const licenses = (await fs.readdir(dir)).filter((f) =>
    /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f),
  );
  const text = (
    await Promise.all(
      licenses.map(async (f) => {
        try {
          return `${f}:\n${await fs.readFile(path.join(dir, f), "utf8")}`;
        } catch {
          return "";
        }
      }),
    )
  ).join("\n\n");
  seen.set(key, { license: pkg.license || "See package license", text });
  for (const dependency of Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  }))
    await visit(dependency, file);
}
const manifest = path.resolve("package.json");
const pkg = JSON.parse(await fs.readFile(manifest, "utf8"));
for (const name of Object.keys(pkg.dependencies)) await visit(name, manifest);
await visit("electron", manifest);
let output =
  "# Third-party notices\n\nTypeset is MIT licensed. The following notices cover application dependencies. Electron also ships Chromium and Node.js notices in its distribution. The compiler image contains Debian and TeX Live packages under their respective free-software licenses; package copyright files are retained in /usr/share/doc inside the image.\n";
for (const [name, entry] of [...seen].sort(([a], [b]) => a.localeCompare(b)))
  output += `\n## ${name}\n\nLicense: ${typeof entry.license === "string" ? entry.license : JSON.stringify(entry.license)}\n\n\`\`\`text\n${entry.text || "See the package source distribution for license details."}\n\`\`\`\n`;
await fs.writeFile("THIRD_PARTY_NOTICES.md", output);
console.log(`Generated notices for ${seen.size} packages.`);
