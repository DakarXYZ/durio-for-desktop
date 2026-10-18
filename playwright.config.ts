import { defineConfig } from "@playwright/test";

// dur.io (stage 7, D7): Playwright drives the unpackaged app (`.vite/build`, made by
// `pnpm package`); packaged builds disable the inspector fuse Playwright attaches with
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
});
