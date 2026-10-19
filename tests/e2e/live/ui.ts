// dur.io (WEB-08, D7): driving the real for-web build inside the app against
// the live backend — the screens the E2EE scenarios pass through
import { type Page, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { type Launched, cleanUp, launch } from "../app";

import { accountKey, live } from "./env";

/** A launched app and what the scenario checks at the end (scenario 11) */
export interface Session extends Launched {
  /** Every request of the page */
  requests: string[];
  /** Responses with status >= 400 (`<status> <url>`) */
  failures: string[];
}

/** Hosts the app may talk to: itself and the two test servers */
const OWN = /^(app:\/\/durio\/|https:\/\/srv[12]\.localhost:\d+\/|blob:|data:)/;

/**
 * Start the app on a profile (new or existing) with the test proxy trusted
 * @param userData Profile to reuse (restart)
 */
export async function start(userData?: string): Promise<Session> {
  const ctx = await launch({ userData, args: live.args });
  const requests: string[] = [];
  const failures: string[] = [];
  ctx.page.on("request", (request) => requests.push(request.url()));
  ctx.page.on("pageerror", (error) =>
    ctx.console.push(`pageerror: ${error.stack ?? error.message}`),
  );
  ctx.page.on("response", (response) => {
    if (response.status() >= 400)
      failures.push(`${response.status()} ${response.url()}`);
  });
  return { ...ctx, requests, failures };
}

/**
 * Scenario 11 on every flow: no CSP violation, nothing but the app and its
 * servers contacted, no uncaught error
 * @param s Session
 */
export function expectClean(s: Session) {
  expect(
    s.console.filter((line) =>
      /Content Security Policy|Refused to|securitypolicyviolation/i.test(line),
    ),
  ).toEqual([]);
  expect(s.requests.filter((url) => !OWN.test(url))).toEqual([]);
  // an uncaught error of the page (a broken render left a blank window)
  expect(s.console.filter((line) => line.startsWith("pageerror:"))).toEqual([]);
}

/** Close the app and remove its profile */
export async function stop(s: Session, keepProfile = false) {
  await s.app.close().catch((): undefined => undefined);
  if (!keepProfile) cleanUp(s.userData);
}

/**
 * Server address screen → login screen of a server
 * @param page Page
 * @param server `srv1.localhost:<port>`
 */
export async function connect(page: Page, server: string) {
  await page.locator("#server-address").fill(server);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator('mdui-text-field[name="email"]')).toBeVisible({
    timeout: 30_000,
  });
}

/** Fill an mdui text field by name */
function field(page: Page, name: string) {
  return page.locator(`mdui-text-field[name="${name}"] input`);
}

/** The app after login: the home sidebar is there */
export async function expectInApp(page: Page) {
  await expect(page.getByText("Conversations")).toBeVisible({
    timeout: 60_000,
  });
}

/**
 * Log in on the login screen of the current server
 * @param page Page
 * @param email E-mail
 * @param password Password
 */
export async function login(page: Page, email: string, password: string) {
  await field(page, "email").fill(email);
  await field(page, "password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expectInApp(page);
}

/**
 * Create an account on the login screen (the test stack has no e-mail
 * verification), then pick a username
 * @param page Page
 * @param email E-mail
 * @param password Password
 * @param username Username
 */
export async function register(
  page: Page,
  email: string,
  password: string,
  username: string,
) {
  await page.locator('a[href$="/login/create"]').first().click();
  await field(page, "email").fill(email);
  await field(page, "new-password").fill(password);
  await page.locator('button[type="submit"]').click();
  await field(page, "username").fill(username);
  await page.locator('button[type="submit"]').click();
  await expectInApp(page);
}

/**
 * The first prompt of a device (E2EE ready): which one, then "Later"
 * @param page Page
 * @returns Its title
 */
export async function dismissFirstPrompt(page: Page) {
  // the title carries a "beta" label
  const title = page.getByText(/^(Protect your encrypted history|New device)/);
  await expect(title).toBeVisible({ timeout: 60_000 });
  const text = (await title.textContent())?.replace(/beta$/i, "");
  await page.getByRole("button", { name: "Later" }).click();
  await expect(title).toBeHidden();
  return text;
}

/**
 * Open a channel through the router (no reload)
 * @param page Page
 * @param server Server of the account
 * @param channel Channel id
 */
export async function openChannel(page: Page, server: string, channel: string) {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/i/${server}/channel/${channel}`);
  await expect(page.locator(".cm-content").first()).toBeVisible({
    timeout: 30_000,
  });
}

/** The composer */
export const composer = (page: Page) => page.locator(".cm-content").first();

/**
 * Type and send a message in the open channel
 * @param page Page
 * @param text Text
 */
export async function sendText(page: Page, text: string) {
  await composer(page).click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/**
 * Edit the last own message of the open channel (arrow up in the empty composer)
 * @param page Page
 * @param text New text
 */
export async function editLast(page: Page, text: string) {
  await composer(page).click();
  await page.keyboard.press("ArrowUp");
  // the inline editor takes over the focus with the old text selected or not
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** A message text in the open channel */
export const messageText = (page: Page, text: string) =>
  page.getByText(text, { exact: true });

/**
 * Open the user settings, optionally on a page
 * @param page Page
 * @param section Sidebar entry, e.g. "Devices and encryption (beta)"
 */
export async function openSettings(page: Page, section?: string) {
  await page.locator("a", { hasText: /^settings$/ }).click();
  if (section) await page.getByText(section, { exact: true }).click();
}

/** Close the settings */
export async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByText("ESC", { exact: true })).toBeHidden();
}

/** A button of the open dialog by its text */
export const dialogButton = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

/**
 * Answer the MFA prompt ("Confirm action") with the password
 * @param page Page
 * @param password Password
 */
export async function confirmMfa(page: Page, password: string) {
  await expect(page.getByText("Confirm action")).toBeVisible({
    timeout: 20_000,
  });
  const choose = page.getByText("Password", { exact: true });
  if (
    (await choose.isVisible()) &&
    !(await field(page, "password").isVisible())
  )
    await choose.click();
  await field(page, "password").fill(password);
  await dialogButton(page, "Confirm").click();
}

/**
 * Make the next `<a download>` of the app land in `dir` instead of a save
 * dialog (main process, the app's one session)
 * @param s Session
 * @param dir Directory
 */
export async function downloadsTo(s: Session, dir: string) {
  await s.app.evaluate(({ session }, target) => {
    session
      .fromPartition("persist:main")
      .on("will-download", (_event, item) =>
        item.setSavePath(`${target}\\${item.getFilename()}`),
      );
  }, dir);
}

/** What the app stores per account, seen from the page and the profile */
export async function storage(s: Session, server: string, userId: string) {
  const key = accountKey(server, userId);
  const page = await s.page.evaluate(
    async ({ key, store }) => {
      const dbs = (await indexedDB.databases()).map((db) => db.name ?? "");
      const forage = await new Promise<string[]>((resolve) => {
        const open = indexedDB.open("localforage");
        open.onsuccess = () => {
          resolve([...open.result.objectStoreNames]);
          open.result.close();
        };
        open.onerror = () => resolve([]);
      });
      return {
        crypto: dbs.filter((name) => name.startsWith(`durio-e2ee-${key}`)),
        drafts: forage.includes(store),
      };
    },
    { key, store: `@${server}/${userId}` },
  );

  return {
    ...page,
    keyFile: existsSync(path.join(s.userData, "keys", `${key}.bin`)),
  };
}

/** CRC-32 for the PNG chunks */
function crc32(buf: Buffer) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/**
 * A real PNG (RGB gradient) — the app decodes it for metadata and a thumbnail
 * @param width Width
 * @param height Height
 */
export function png(width: number, height: number) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = (x * 255) / width;
      raw[row + 2 + x * 3] = (y * 255) / height;
      raw[row + 3 + x * 3] = 128;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export { cleanUp, launch };
