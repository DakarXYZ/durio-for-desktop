// dur.io (stage 7, D7): the dur.io members of `window.native` (D3, D4)
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ROOT, cleanUp, fixtureWeb, launch, tempDir } from "./app";

interface Bridge {
  e2eeStoreKey(
    accountKey: string,
  ): Promise<{ key: Uint8Array; created: boolean }>;
  e2eeDeleteStoreKey(accountKey: string): Promise<void>;
  servers: { default(): Promise<string | undefined> };
}

declare const window: Window & { native: Bridge };

let webDir: string;

test.beforeAll(() => {
  webDir = fixtureWeb();
});

test.afterAll(() => cleanUp(path.dirname(webDir)));

test("store keys: create, reuse, persist, delete", async () => {
  const userData = tempDir("profile");

  // the key as the page sees it: type, length and hex
  const read = (account: string) =>
    ctx.page.evaluate(async (account) => {
      const { key, created } = await window.native.e2eeStoreKey(account);
      return {
        created,
        isBytes: key instanceof Uint8Array,
        length: key.length,
        hex: Array.from(key, (b) => b.toString(16).padStart(2, "0")).join(""),
      };
    }, account);

  let ctx = await launch({ webDir, userData });

  const first = await read("acc_1-A");
  expect(first).toMatchObject({ created: true, isBytes: true, length: 32 });

  const again = await read("acc_1-A");
  expect(again).toEqual({ ...first, created: false });

  // a different account has a different key
  const other = await read("other");
  expect(other.created).toBe(true);
  expect(other.hex).not.toBe(first.hex);

  // the file is sealed by the OS, not the key in clear
  const file = path.join(userData, "keys", "acc_1-A.bin");
  const sealed = readFileSync(file);
  const base64 = Buffer.from(first.hex, "hex").toString("base64");
  expect(sealed.includes(Buffer.from(base64))).toBe(false);
  expect(sealed.includes(Buffer.from(first.hex, "hex"))).toBe(false);

  // the key survives a restart
  await ctx.app.close();
  ctx = await launch({ webDir, userData });
  expect(await read("acc_1-A")).toEqual({ ...first, created: false });

  // delete: gone, the next get makes a new one; deleting twice is fine
  await ctx.page.evaluate(() => window.native.e2eeDeleteStoreKey("acc_1-A"));
  expect(existsSync(file)).toBe(false);
  await ctx.page.evaluate(() => window.native.e2eeDeleteStoreKey("acc_1-A"));

  const fresh = await read("acc_1-A");
  expect(fresh.created).toBe(true);
  expect(fresh.hex).not.toBe(first.hex);

  // concurrent first calls create one key
  const both = await ctx.page.evaluate(async () => {
    const [a, b] = await Promise.all([
      window.native.e2eeStoreKey("race"),
      window.native.e2eeStoreKey("race"),
    ]);
    return [a.created, b.created, a.key.join() === b.key.join()];
  });
  expect(both.slice(0, 2).filter((created) => created)).toHaveLength(1);
  expect(both[2]).toBe(true);

  await ctx.app.close();
  cleanUp(userData);
});

test("store keys: invalid account keys are rejected", async () => {
  const ctx = await launch({ webDir });

  for (const accountKey of [
    "",
    "../escape",
    "a/b",
    "a\\b",
    "a.b",
    "x".repeat(129),
    "C:",
  ]) {
    const result = await ctx.page.evaluate(
      (accountKey) =>
        window.native.e2eeStoreKey(accountKey).then(
          () => "answered",
          () => "rejected",
        ),
      accountKey,
    );
    expect(result, accountKey).toBe("rejected");
  }

  expect(
    await ctx.page.evaluate(() =>
      window.native.e2eeStoreKey(123 as unknown as string).then(
        () => "answered",
        () => "rejected",
      ),
    ),
  ).toBe("rejected");

  expect(existsSync(path.join(ctx.userData, "escape.bin"))).toBe(false);

  await ctx.app.close();
  cleanUp(ctx.userData);
});

test("store keys: a foreign origin gets nothing", async () => {
  const ctx = await launch({ webDir });
  const preload = path.join(ROOT, ".vite", "build", "preload.js");

  const result = await ctx.app.evaluate(async ({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, partition: "persist:main", sandbox: true },
    });
    await win.loadURL("data:text/html,<p>foreign</p>");
    const answer = await win.webContents.executeJavaScript(
      `window.native.e2eeStoreKey("account").then(() => "answered", () => "rejected")`,
    );
    win.destroy();
    return answer;
  }, preload);

  expect(result).toBe("rejected");
  expect(existsSync(path.join(ctx.userData, "keys", "account.bin"))).toBe(
    false,
  );

  await ctx.app.close();
  cleanUp(ctx.userData);
});

test("servers.default is empty unless a valid host is configured", async () => {
  let ctx = await launch({ webDir });
  expect(
    await ctx.page.evaluate(() => window.native.servers.default()),
  ).toBeUndefined();

  const userData = ctx.userData;
  await ctx.app.close();

  const config = path.join(userData, "config.json");
  const set = (value: string) =>
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, "utf8")),
        defaultServer: value,
      }),
    );

  set("duri0.duckdns.org");
  ctx = await launch({ webDir, userData });
  expect(await ctx.page.evaluate(() => window.native.servers.default())).toBe(
    "duri0.duckdns.org",
  );
  await ctx.app.close();

  set("https://evil.example/path");
  ctx = await launch({ webDir, userData });
  expect(
    await ctx.page.evaluate(() => window.native.servers.default()),
  ).toBeUndefined();
  await ctx.app.close();

  cleanUp(userData);
});

test("the window: persist:main, not throttled, raised by focus()", async () => {
  const ctx = await launch({ webDir });

  const state = () =>
    ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return {
        visible: win.isVisible(),
        throttled: win.webContents.getBackgroundThrottling(),
        persistent: win.webContents.session.isPersistent(),
        storage: win.webContents.session.getStoragePath(),
      };
    });

  // started with --hidden, as from autostart into the tray
  const before = await state();
  expect(before).toMatchObject({
    visible: false,
    throttled: false,
    persistent: true,
  });
  expect(before.storage).toContain(path.join("Partitions", "main"));

  await ctx.page.evaluate(() =>
    (window as unknown as { native: { focus(): void } }).native.focus(),
  );
  await expect.poll(async () => (await state()).visible).toBe(true);

  // the badge IPC takes counts, -1 (unread dot) and ignores junk
  await ctx.page.evaluate(() => {
    const native = (
      window as unknown as { native: { setBadgeCount(n: unknown): void } }
    ).native;
    for (const count of [3, 12, -1, 0, "x", 1.5, -7])
      native.setBadgeCount(count);
  });
  await ctx.page.waitForTimeout(300);
  expect(
    await ctx.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);

  await ctx.app.close();
  cleanUp(ctx.userData);
});
