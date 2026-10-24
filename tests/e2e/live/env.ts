// dur.io (WEB-08, D7): the live backend of the e2e tests — the durio-crypt
// testkit stack with its TLS proxy:
//
//   TESTKIT_PUBLIC_PORT=14443 ../durio-crypt/scripts/testkit-backend.sh up
//
// https://srv1.localhost:<port> and srv2.localhost are two servers (`*.localhost`
// is loopback in Chromium and Windows); the proxy's certificate comes from
// Caddy's internal CA, which only the test run trusts (`--ignore-certificate-errors`).
// Without the stack the live tests are skipped.
import { createHash } from "node:crypto";
import { request } from "node:https";

const port = Number(process.env.DURIO_E2E_PORT ?? 14443);

export const live = {
  port,
  /** What the user types on the server address screen */
  server1: `srv1.localhost:${port}`,
  server2: `srv2.localhost:${port}`,
  network: process.env.DURIO_E2E_NETWORK ?? "durio-test",
  /** Image and volume with the peer binary (durio-crypt `target/`) */
  peerImage: process.env.DURIO_E2E_PEER_IMAGE ?? "rust:1.96.1-bookworm",
  peerVolume: process.env.DURIO_E2E_PEER_VOLUME ?? "durio-target",
  /** Switches of the app under test */
  args: ["--ignore-certificate-errors"],
};

/** API URL of a server as the app discovers it */
export const apiUrl = (server: string) => `https://${server}/api`;

/**
 * The account key of the app (`common/lib/accountKey.ts`): names the crypto
 * store, its key file and the notification tags
 */
export function accountKey(server: string, userId: string) {
  return createHash("sha256")
    .update(`${apiUrl(server)}\n${userId}`)
    .digest("hex")
    .slice(0, 16);
}

/** Whether the stack answers (checked once per worker) */
export function backendUp(): Promise<boolean> {
  return new Promise((resolve) => {
    // Node does not resolve *.localhost the way Chromium does
    const req = request(
      `https://127.0.0.1:${port}/api/`,
      {
        headers: { host: live.server1 },
        servername: "srv1.localhost",
        rejectUnauthorized: false,
        timeout: 3_000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
