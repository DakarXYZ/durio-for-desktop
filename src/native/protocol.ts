// dur.io (stage 7, D2): the for-web desktop build (`vite build --mode desktop`) is
// packaged into the asar next to the main process and served from `app://durio/`.
// Code never comes from a chat server: a hijacked server cannot swap the code that
// holds the E2EE keys.
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type Session, app, net, protocol } from "electron";

// one source of truth with for-web (`packages/client/desktop/csp.mjs`), copied with
// its SHA-256 checked by `scripts/sync-web.mjs`
import { desktopCsp } from "./csp.mjs";
import { APP_HOST, APP_SCHEME } from "./security";

/** The policy of the page; a header, unlike the <meta> of the build, can forbid framing */
export const CONTENT_SECURITY_POLICY = `${desktopCsp()}; frame-ancestors 'none'`;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Directory of the web build: `web/` at the root of the app (the asar when packaged).
 * Unpackaged runs (`pnpm start`, tests) may point elsewhere with `DURIO_WEB_DIR`.
 */
export function webRoot() {
  if (!app.isPackaged && process.env.DURIO_WEB_DIR) {
    return path.resolve(process.env.DURIO_WEB_DIR);
  }

  return path.join(app.getAppPath(), "web");
}

/**
 * Must run before `ready`: `standard` gives `app://durio` a real origin (IndexedDB,
 * localStorage), `secure` a secure context (WebCrypto, getUserMedia), `stream` media
 * with ranges. No service workers.
 */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

/**
 * Map a request path to a file inside the web root
 * @param root Web root
 * @param pathname URL path, still percent-encoded
 * @returns Absolute path, or null if it points outside the root or is malformed
 */
export function resolveWebPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  // NUL, drive letters / alternate data streams, any `..` segment (also with `\`)
  if (/[\0:]/.test(decoded)) return null;
  if (decoded.split(/[/\\]/).includes("..")) return null;

  const file = path.resolve(root, "." + path.sep + decoded);
  const relative = path.relative(root, file);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  return file;
}

/**
 * A route of a server with a port (`/i/<host>:<port>/…`): the app's index.html, never
 * a file — `resolveWebPath` refuses the `:` (drive letters, alternate data streams)
 * @param pathname URL path, still percent-encoded
 */
export function isPortRoute(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  return (
    /^\/i\/[A-Za-z0-9.-]+:\d{1,5}(\/[^\0\\:]*)?$/.test(decoded) &&
    !decoded.split("/").includes("..")
  );
}

async function isFile(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function respond(status: number, body: string) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    },
  });
}

/**
 * Serve `app://durio/` from the web build on a session
 * @param ses Session of the main window (`persist:main`)
 */
export function handleAppProtocol(ses: Session) {
  const root = webRoot();

  ses.protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return respond(404, "Not Found");
    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond(405, "Method Not Allowed");
    }

    let file = resolveWebPath(root, url.pathname);
    if (!file) {
      // a reload (F5) on a server with a port, e.g. `/i/name.duckdns.org:8443/…`
      if (!isPortRoute(url.pathname)) return respond(403, "Forbidden");
      file = path.join(root, "index.html");
    }

    if (!(await isFile(file))) {
      // SPA: deep routes (`/i/<host>/channel/…`, hosts have dots) get index.html;
      // a missing hashed asset stays a 404 rather than HTML with the wrong type
      if (url.pathname.startsWith("/assets/")) {
        return respond(404, "Not Found");
      }

      file = path.join(root, "index.html");
    }

    const response = await net.fetch(pathToFileURL(file).toString());
    if (!response.ok) return respond(404, "Not Found");

    const type =
      MIME_TYPES[path.extname(file).toLowerCase()] ??
      response.headers.get("content-type") ??
      "application/octet-stream";

    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Security-Policy": CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  });
}
