import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const GITHUB_URL = "https://github.com/";
const PROXY_KEY = `http.${GITHUB_URL}.proxy`;

/** Translate the first OS route without turning a DIRECT preference into a proxy. */
export function gitProxyUrl(routes: string): string | undefined {
  const first = routes.split(";", 1)[0].trim();
  const match = first.match(
    /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+([a-z0-9.-]+|\[[a-f0-9:]+\]):([0-9]+)$/i,
  );
  if (!match) return undefined;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return undefined;
  const protocols: Record<string, string> = {
    PROXY: "http",
    HTTPS: "https",
    SOCKS: "socks4a",
    SOCKS4: "socks4a",
    SOCKS5: "socks5h",
  };
  return `${protocols[match[1].toUpperCase()]}://${match[2]}:${port}`;
}

/** Git/libcurl cannot evaluate an OS PAC file; Electron resolves it for us.
 * Scope the result to GitHub and this process, leaving other hosts and all
 * on-disk Git settings alone. Explicit Git/proxy environment settings win.
 */
export async function systemGitEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv,
  resolveProxy: (url: string) => Promise<string>,
): Promise<NodeJS.ProcessEnv> {
  const env = { ...environment };
  if (
    ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"].some(
      (key) => env[key] !== undefined,
    )
  )
    return env;
  const countText = env.GIT_CONFIG_COUNT ?? "0";
  const count = Number(countText);
  if (!/^\d*$/.test(countText) || !Number.isSafeInteger(count)) return env;
  try {
    await execute(
      "git",
      ["config", "--get-urlmatch", "http.proxy", GITHUB_URL],
      {
        cwd: root,
        env,
        shell: false,
        windowsHide: true,
        timeout: 3000,
        maxBuffer: 64 * 1024,
      },
    );
    // A successful lookup includes an empty value explicitly disabling proxies.
    return env;
  } catch (error) {
    if ((error as { code?: number }).code !== 1) return env;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const routes = await Promise.race([
      resolveProxy(GITHUB_URL),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("DIRECT"), 5000);
      }),
    ]);
    const proxy = gitProxyUrl(routes);
    if (proxy) {
      env.GIT_CONFIG_COUNT = String(count + 1);
      env[`GIT_CONFIG_KEY_${count}`] = PROXY_KEY;
      env[`GIT_CONFIG_VALUE_${count}`] = proxy;
    }
  } catch {
    // Local editing and the terminal must still work offline or without PAC.
  } finally {
    if (timer) clearTimeout(timer);
  }
  return env;
}
