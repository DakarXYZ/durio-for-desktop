// Content Security Policy of the dur.io desktop build (plan WEB-11, 90-desktop-windows D2).
// One source of truth: the desktop build puts it into index.html as a <meta>, and the
// Electron side (stage 7) sends the same string as the `Content-Security-Policy` header
// from `protocol.handle("app", …)` — import this file or copy it with its hash checked.
//
// - script-src: only the packaged files; 'wasm-unsafe-eval' for the crypto core (and the
//   RNNoise worklet), never 'unsafe-eval' or 'unsafe-inline' (no inline scripts at all:
//   the build fails on one).
// - worker-src: the crypto worker and the module workers are packaged files ('self').
// - connect-src: `https:` and `wss:` — servers are added at runtime (O12) and discovery
//   reads `https://<host>/.well-known/stoat` of a host typed by the user before anything
//   is known about it; a policy of known hosts would need a reload per new server and
//   could not cover discovery. Plain `http:`/`ws:` stay blocked (only `connectSrcDev`
//   adds localhost for development builds of the desktop app). `blob:`/`data:` for
//   object URLs read back by the app.
// - img-src/media-src: avatars, attachments and proxied media from the user's servers
//   (`https:`), decrypted attachments (`blob:`), inline images (`data:`).
// - style-src 'unsafe-inline': Solid style attributes, KaTeX and Shiki.
// - frame-src https:: embeds (YouTube and the like).

/** Local development servers, added only when the desktop app runs a dev backend */
export const connectSrcDev = [
  "http://localhost:*",
  "ws://localhost:*",
  "http://127.0.0.1:*",
  "ws://127.0.0.1:*",
];

/**
 * The policy as a header value
 * @param {{ dev?: boolean }} [options] `dev`: also allow a local backend
 * @returns {string}
 */
export function desktopCsp(options = {}) {
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'wasm-unsafe-eval'"],
    "worker-src": ["'self'"],
    "connect-src": [
      "'self'",
      "https:",
      "wss:",
      "blob:",
      "data:",
      ...(options.dev ? connectSrcDev : []),
    ],
    "img-src": ["'self'", "https:", "data:", "blob:"],
    "media-src": ["'self'", "https:", "blob:"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "font-src": ["'self'", "data:"],
    "frame-src": ["https:"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** The production policy */
export const DESKTOP_CSP = desktopCsp();
