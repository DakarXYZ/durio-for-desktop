// dur.io (stage 7, D3): there is no built-in server (O13). The list of servers and
// accounts lives in for-web; the desktop app only offers an optional prefill of the
// server address screen, set at build time (`DURIO_DEFAULT_SERVER`, empty by
// default) and kept in electron-store, where an admin may change it.
import { config } from "./config";
import { handleTrusted } from "./security";

// a host, optionally with a port: what the address screen expects
const HOST =
  /^(?=.{1,253}(?::\d{1,5})?$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

/** The suggested server address, if one was set and it looks like a host */
export function defaultServer(): string | undefined {
  const value = config.defaultServer?.trim();
  return value && HOST.test(value) ? value : undefined;
}

export function initServers() {
  handleTrusted("servers:default", () => defaultServer());
}
