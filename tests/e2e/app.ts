// dur.io (stage 7, D7): launching the app under Playwright with its own profile
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
} from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT = path.join(__dirname, "..", "..");
export const APP_URL = "app://durio/";

/** The smallest valid WebAssembly module (magic + version) */
export const EMPTY_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

/** A unique temporary directory */
export function tempDir(name: string) {
  return mkdtempSync(path.join(tmpdir(), `durio-${name}-`));
}

/**
 * A stand-in for the for-web build: an external script that records CSP
 * violations, an inline script the policy must block, a wasm file, and a file
 * next to (outside) the web root that must never be served
 */
export function fixtureWeb() {
  const base = tempDir("web");
  const root = path.join(base, "web");
  mkdirSync(path.join(root, "assets"), { recursive: true });

  writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>fixture</title>
    <script src="/assets/fixture.js"></script>
    <script>window.__inline = true;</script>
  </head>
  <body><p id="fixture">fixture</p></body>
</html>
`,
  );

  writeFileSync(
    path.join(root, "assets", "fixture.js"),
    `window.__violations = [];
document.addEventListener("securitypolicyviolation", (e) =>
  window.__violations.push(e.violatedDirective),
);
`,
  );

  writeFileSync(path.join(root, "assets", "empty.wasm"), EMPTY_WASM);
  writeFileSync(path.join(base, "secret.txt"), "OUTSIDE-THE-WEB-ROOT");

  return root;
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
  /** Console messages of the page */
  console: string[];
}

/**
 * Start the app (`.vite/build/main.js`, hidden window, separate profile)
 * @param options `webDir`: serve this instead of `web/` (unset: the real build);
 *   `userData`: reuse a profile (restart tests); `args`: extra command line
 *   switches (the live tests trust the test proxy's certificate this way)
 */
export async function launch(
  options: { webDir?: string; userData?: string; args?: string[] } = {},
): Promise<Launched> {
  if (!existsSync(path.join(ROOT, ".vite", "build", "main.js"))) {
    throw new Error("no .vite/build/main.js: run `pnpm package` first");
  }

  const userData = options.userData ?? tempDir("profile");
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;

  delete env.ELECTRON_RUN_AS_NODE;
  if (options.webDir) env.DURIO_WEB_DIR = options.webDir;
  else delete env.DURIO_WEB_DIR;

  const app = await electron.launch({
    args: [
      ".",
      "--hidden",
      `--durio-user-data=${userData}`,
      // Linux: Playwright's loader sets --password-store=basic (no
      // encryption, refused by the app); devOverrides puts the keyring back
      ...(process.platform === "linux"
        ? ["--durio-password-store=gnome-libsecret"]
        : []),
      ...(options.args ?? []),
    ],
    cwd: ROOT,
    env,
  });

  const page = await app.firstWindow();
  const messages: string[] = [];
  page.on("console", (message) =>
    messages.push(`${message.type()}: ${message.text()}`),
  );

  await page.waitForLoadState("domcontentloaded");
  return { app, page, userData, console: messages };
}

/** Remove a temporary profile or web root (Chromium may hold files for a moment) */
export function cleanUp(dir: string | undefined) {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
