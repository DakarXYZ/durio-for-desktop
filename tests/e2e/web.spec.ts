// dur.io (stage 7, D7): the real for-web desktop build in `web/` (skipped without
// it: `pnpm web:sync`). No backend: the app must start at the server address
// screen, under the CSP, without loading anything remote.
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

import { ROOT, cleanUp, launch } from "./app";

test.skip(
  !existsSync(path.join(ROOT, "web", "index.html")),
  "no for-web build in web/",
);

test("the packaged for-web starts at the server address screen", async () => {
  const ctx = await launch();
  const requests: string[] = [];
  ctx.page.on("request", (request) => requests.push(request.url()));

  await expect(ctx.page).toHaveTitle("dur.io");
  await expect(ctx.page.locator("#server-address")).toBeVisible({
    timeout: 20_000,
  });

  // no built-in server (O13): nothing to prefill
  expect(await ctx.page.inputValue("#server-address")).toBe("");
  expect(new URL(ctx.page.url()).protocol).toBe("app:");

  // a reload (F5) serves the same app from the deep route
  await ctx.page.reload();
  await expect(ctx.page.locator("#server-address")).toBeVisible({
    timeout: 20_000,
  });

  const violations = ctx.console.filter((line) =>
    /Content Security Policy|Refused to/i.test(line),
  );
  expect(violations).toEqual([]);
  expect(requests.filter((url) => !url.startsWith("app://durio/"))).toEqual([]);

  await ctx.app.close();
  cleanUp(ctx.userData);
});

test("the RNNoise worklet and its wasm load under the CSP", async () => {
  const ctx = await launch();
  await expect(ctx.page.locator("#server-address")).toBeVisible({
    timeout: 20_000,
  });

  // what the voice processor does in a call: a worklet module from the package
  // (script-src 'self') and the wasm it compiles ('wasm-unsafe-eval')
  const exports = await ctx.page.evaluate(async () => {
    const audio = new AudioContext();
    try {
      await audio.audioWorklet.addModule("/rnnoise/RNNoiseWorklet.js");
      const wasm = await WebAssembly.compileStreaming(
        fetch("/rnnoise/rnnoise.wasm"),
      );
      return WebAssembly.Module.exports(wasm).length;
    } finally {
      await audio.close();
    }
  });
  expect(exports).toBeGreaterThan(0);

  expect(
    ctx.console.filter((line) =>
      /Content Security Policy|Refused to/i.test(line),
    ),
  ).toEqual([]);

  await ctx.app.close();
  cleanUp(ctx.userData);
});
