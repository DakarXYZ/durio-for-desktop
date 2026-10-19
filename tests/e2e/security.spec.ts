// dur.io (stage 7, D7): security of the shell (Q64) — no backend needed
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  APP_URL,
  type Launched,
  ROOT,
  cleanUp,
  fixtureWeb,
  launch,
} from "./app";

let ctx: Launched;
let webDir: string;

test.beforeAll(async () => {
  webDir = fixtureWeb();
  ctx = await launch({ webDir });
});

test.afterAll(async () => {
  await ctx?.app.close();
  cleanUp(ctx?.userData);
  cleanUp(path.dirname(webDir));
});

/** Status, type, CSP and the start of the body of a GET from the page */
function get(url: string) {
  return ctx.page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      csp: response.headers.get("content-security-policy"),
      body: (await response.text()).slice(0, 200),
    };
  }, url);
}

test("the page is served from app://durio with the bridge", async () => {
  expect(ctx.page.url()).toBe(APP_URL);
  await expect(ctx.page.locator("#fixture")).toHaveText("fixture");
  expect(await ctx.page.evaluate(() => "native" in window)).toBe(true);
});

test("the CSP header is sent and enforced", async () => {
  const index = await get("/");
  expect(index.status).toBe(200);
  expect(index.type).toContain("text/html");
  expect(index.csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(index.csp).toContain("frame-ancestors 'none'");
  expect(index.csp).not.toContain("'unsafe-eval'");

  // the fixture has no <meta>: only the header can have blocked the inline script
  expect(await ctx.page.evaluate(() => "__inline" in window)).toBe(false);
  expect(
    await ctx.page.evaluate(
      () => (window as unknown as { __violations: string[] }).__violations,
    ),
  ).toBeDefined();

  const js = await get("/assets/fixture.js");
  expect(js.csp).toContain("frame-ancestors 'none'");
});

test("wasm is served as application/wasm and compiles", async () => {
  const wasm = await get("/assets/empty.wasm");
  expect(wasm.status).toBe(200);
  expect(wasm.type).toBe("application/wasm");

  // instantiateStreaming insists on the MIME type; CSP must allow wasm
  expect(
    await ctx.page.evaluate(async () => {
      await WebAssembly.instantiateStreaming(fetch("/assets/empty.wasm"));
      return true;
    }),
  ).toBe(true);
});

test("deep routes fall back to index.html, missing assets do not", async () => {
  const route = await get("/i/duri0.duckdns.org/channel/01ABC");
  expect(route.status).toBe(200);
  expect(route.type).toContain("text/html");
  expect(route.body).toContain("<title>fixture</title>");

  expect((await get("/assets/missing.js")).status).toBe(404);

  // a server with a port: the `:` is no drive letter here (reload on a live server)
  const port = await get("/i/srv1.localhost:14443/login");
  expect(port.status).toBe(200);
  expect(port.body).toContain("<title>fixture</title>");
  for (const url of [
    "/i/a.example:1/..%2F..%2Fsecret.txt",
    "/i/a.example:1/x%5C..%5Csecret.txt",
    "/i/a.example:1/C:%5Cx",
    "/x/a.example:1/",
  ])
    expect((await get(url)).status, url).toBe(403);
});

test("paths outside the web root are rejected", async () => {
  for (const url of [
    "/..%2Fsecret.txt",
    "/..%2F..%2Fpackage.json",
    "/assets/..%2F..%2Fsecret.txt",
    "/..%5Csecret.txt",
    "/%2e%2e%5Csecret.txt",
    "/C:%5CWindows%5Cwin.ini",
    "/index.html%00.js",
  ]) {
    const response = await get(url);
    expect(response.status, url).toBe(403);
    expect(response.body, url).not.toContain("OUTSIDE-THE-WEB-ROOT");
  }

  // `..` the URL parser resolves itself stays inside the root
  for (const url of ["/../secret.txt", "/%2e%2e/secret.txt"]) {
    const response = await get(url);
    expect(response.body, url).not.toContain("OUTSIDE-THE-WEB-ROOT");
  }
});

test("other hosts of app:// are not served", async () => {
  const status = await ctx.app.evaluate(async ({ session }) => {
    const response = await session
      .fromPartition("persist:main")
      .fetch("app://other/index.html");
    return response.status;
  });

  expect(status).toBe(404);
});

test("navigation to https is blocked", async () => {
  await ctx.page.evaluate(() => {
    location.href = "https://example.com/";
  });

  await ctx.page.waitForTimeout(1_000);
  expect(ctx.page.url()).toBe(APP_URL);

  // the same through a redirect-free form of navigation
  await ctx.page.evaluate(() => {
    location.assign("file:///C:/Windows/win.ini");
  });

  await ctx.page.waitForTimeout(500);
  expect(ctx.page.url()).toBe(APP_URL);
});

test("window.open goes to the external browser, never a new window", async () => {
  await ctx.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });

  await ctx.page.evaluate(() => {
    window.open("https://example.com/link");
    window.open("app://durio/settings");
    window.open("file:///C:/Windows/win.ini");
  });

  await ctx.page.waitForTimeout(500);
  const opened = await ctx.app.evaluate(
    () => (globalThis as unknown as { __opened: string[] }).__opened,
  );

  expect(opened).toEqual(["https://example.com/link"]);
  expect(
    await ctx.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
});

test("only whitelisted permissions are granted", async () => {
  expect(await ctx.page.evaluate(() => Notification.requestPermission())).toBe(
    "granted",
  );

  expect(
    await ctx.page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          navigator.geolocation.getCurrentPosition(
            () => resolve(0),
            (error) => resolve(error.code),
          ),
        ),
    ),
  ).toBe(1); // PERMISSION_DENIED

  expect(
    await ctx.page.evaluate(() =>
      navigator.requestMIDIAccess().then(
        () => "granted",
        () => "denied",
      ),
    ),
  ).toBe("denied");
});

/** A window with the app's preload on a page that is not the app */
async function foreignWindow(url: string) {
  const preload = path.join(ROOT, ".vite", "build", "preload.js");
  return ctx.app.evaluate(
    async ({ BrowserWindow }, [url, preload]) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          partition: "persist:main",
          contextIsolation: true,
          sandbox: true,
        },
      });

      await win.loadURL(url);
      return win.id;
    },
    [url, preload] as const,
  );
}

async function runIn(id: number, code: string) {
  return ctx.app.evaluate(
    ({ BrowserWindow }, [id, code]) =>
      BrowserWindow.fromId(id as number).webContents.executeJavaScript(
        code as string,
      ),
    [id, code] as const,
  );
}

test("IPC from a foreign origin is rejected", async () => {
  const id = await foreignWindow("data:text/html,<p>foreign</p>");

  // the bridge exists there (same preload), but main refuses to answer
  expect(await runIn(id, "typeof window.native")).toBe("object");
  expect(
    await runIn(
      id,
      `window.desktopConfig.getAutostart().then(() => "answered", () => "rejected")`,
    ),
  ).toBe("rejected");

  // fire-and-forget messages are dropped
  await runIn(id, `window.desktopConfig.set({ discordRpc: true }), 1`);
  await ctx.page.waitForTimeout(300);
  const store = JSON.parse(
    readFileSync(path.join(ctx.userData, "config.json"), "utf8"),
  );
  expect(store.discordRpc).toBe(false);

  // a foreign page in the app session gets no permissions either
  expect(await runIn(id, `Notification.requestPermission()`)).toBe("denied");

  await ctx.app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.fromId(id).destroy();
  }, id);
});

test("the config IPC accepts only known boolean settings", async () => {
  await ctx.page.evaluate(() => {
    (
      window as unknown as {
        desktopConfig: { set(config: Record<string, unknown>): void };
      }
    ).desktopConfig.set({
      minimiseToTray: false,
      customFrame: "yes",
      windowState: { x: -99999, y: 0, width: 1, height: 1 },
      bogus: 1,
    });
  });

  await ctx.page.waitForTimeout(300);
  const store = JSON.parse(
    readFileSync(path.join(ctx.userData, "config.json"), "utf8"),
  );

  expect(store.minimiseToTray).toBe(false);
  expect(store.customFrame).toBe(true);
  expect(store.bogus).toBeUndefined();
  expect(store.windowState?.x).not.toBe(-99999);
});
