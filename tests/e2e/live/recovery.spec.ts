// dur.io (WEB-08, D7) scenarios 5 and 6: key backup — created without an
// existing one (no MFA), created over one (MFA first), rotated (MFA), restored
// on a second fresh profile with "sender not confirmed" shields; key export
// to a passphrase file and import on a fresh profile
import { type Page, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { backendUp, live } from "./env";
import { Peer } from "./peer";
import * as ui from "./ui";

test.describe.configure({ mode: "serial" });

let up = false;
test.beforeAll(async () => {
  up = await backendUp();
});
test.beforeEach(() =>
  test.skip(
    !up,
    "no testkit stack (TESTKIT_PUBLIC_PORT=14443 testkit-backend.sh up)",
  ),
);

const ENCRYPTION = "Devices and encryption (beta)";
/** Base58 in 12 groups of four: a Matrix recovery key */
const RECOVERY_KEY = /^([1-9A-HJ-NP-Za-km-z]{4} ){11}[1-9A-HJ-NP-Za-km-z]{4}$/;

/** The recovery key step of the dialog: read the key, confirm it is saved, turn on */
async function saveKeyAndTurnOn(page: Page) {
  const shown = page.getByText(RECOVERY_KEY);
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const key = (await shown.textContent())!;
  await page.getByText("I have saved my recovery key").click();
  await ui.dialogButton(page, "Turn on backup").click();
  return key;
}

/** Wait for "Backup is on." and close the dialog */
async function backupOn(page: Page) {
  await expect(page.getByText(/^Backup is on\./)).toBeVisible({
    timeout: 30_000,
  });
  await ui.dialogButton(page, "Done").click();
}

/** The input of a secret field by its label */
const secret = (page: Page, label: RegExp) =>
  page.locator("label", { hasText: label }).locator("input, textarea");

test("backup: create, replace with MFA, rotate, restore on a new profile", async () => {
  test.setTimeout(420_000);
  const peer = new Peer();
  const s = await ui.start();
  let fresh: ui.Session | undefined;

  try {
    const { desk, channel } = await peer.encryptedPair();
    await ui.connect(s.page, live.server1);
    await ui.login(s.page, desk.email, desk.password);

    // the first prompt (E2EE ready) → a recovery key; no backup yet: no MFA
    await expect(
      s.page.getByText(/^Protect your encrypted history/),
    ).toBeVisible({ timeout: 60_000 });
    await peer.send("peer", channel, "before the backup");
    await ui.dialogButton(s.page, "Create recovery key").click();
    await ui.dialogButton(s.page, "Create recovery key").click();
    await saveKeyAndTurnOn(s.page);
    await backupOn(s.page);
    await expect(s.page.getByText("Confirm action")).toBeHidden();
    await ui.openChannel(s.page, live.server1, channel);
    await expect(ui.messageText(s.page, "before the backup")).toBeVisible({
      timeout: 30_000,
    });

    // a new recovery key over the existing backup: the password first
    await ui.openSettings(s.page, ENCRYPTION);
    await s.page.getByRole("button", { name: "New recovery key" }).click();
    await expect(s.page.getByText(/^You already have a backup/)).toBeVisible();
    await ui.dialogButton(s.page, "Create recovery key").click();
    const key = await saveKeyAndTurnOn(s.page);
    await ui.confirmMfa(s.page, desk.password);
    await backupOn(s.page);

    // a new backup under the same key: the password again
    await s.page
      .getByRole("button", {
        name: "Replace the backup (keeps the recovery key)",
      })
      .click();
    await ui.dialogButton(s.page, "Replace the backup").click();
    await ui.confirmMfa(s.page, desk.password);
    await backupOn(s.page);
    await ui.closeSettings(s.page);
    ui.expectClean(s);
    await ui.stop(s);

    // a second, fresh profile of the same account restores the history
    fresh = await ui.start();
    await ui.connect(fresh.page, live.server1);
    await ui.login(fresh.page, desk.email, desk.password);
    await expect(fresh.page.getByText(/^New device/)).toBeVisible({
      timeout: 60_000,
    });
    await ui.dialogButton(fresh.page, "Restore with recovery key").click();
    await secret(fresh.page, /^Recovery key/).fill(key);
    await expect(
      fresh.page.getByText("Looks like a recovery key"),
    ).toBeVisible();
    await ui.dialogButton(fresh.page, "Restore").click();
    await expect(fresh.page.getByText(/^Restored [1-9]\d* keys\./)).toBeVisible(
      {
        timeout: 60_000,
      },
    );
    await ui.dialogButton(fresh.page, "Done").click();
    await ui.openChannel(fresh.page, live.server1, channel);
    await expect(ui.messageText(fresh.page, "before the backup")).toBeVisible({
      timeout: 30_000,
    });
    await expect(fresh.page.getByText(/sender not confirmed$/)).toBeVisible();
    ui.expectClean(fresh);
  } finally {
    await ui.stop(s);
    if (fresh) await ui.stop(fresh);
    peer.close();
  }
});

test("key export to a file, import on a new profile", async () => {
  test.setTimeout(300_000);
  const peer = new Peer();
  const downloads = mkdtempSync(path.join(tmpdir(), "durio-downloads-"));
  const s = await ui.start();
  let fresh: ui.Session | undefined;
  const passphrase = "orange tractor sings at midnight 42";

  try {
    const { desk, channel } = await peer.encryptedPair();
    await ui.connect(s.page, live.server1);
    await ui.login(s.page, desk.email, desk.password);
    await ui.dismissFirstPrompt(s.page);
    await peer.send("peer", channel, "exported history");
    await ui.openChannel(s.page, live.server1, channel);
    await expect(ui.messageText(s.page, "exported history")).toBeVisible({
      timeout: 30_000,
    });

    // export: the passphrase twice, the file through the app's download
    await ui.downloadsTo(s, downloads);
    await ui.openSettings(s.page, ENCRYPTION);
    await s.page.getByRole("button", { name: "Export keys" }).click();
    await secret(s.page, /^Passphrase/).fill(passphrase);
    await secret(s.page, /^Repeat the passphrase/).fill(passphrase);
    await ui.dialogButton(s.page, "Export and save").click();
    await expect(
      s.page.getByText(/^Saved: keys of [1-9]\d* sessions\./),
    ).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => readdirSync(downloads), { timeout: 10_000 })
      .toHaveLength(1);
    const file = path.join(downloads, readdirSync(downloads)[0]);
    expect(path.basename(file)).toMatch(
      /^dur\.io-keys-\d{4}-\d{2}-\d{2}\.txt$/,
    );
    await ui.dialogButton(s.page, "Done").click();
    await ui.closeSettings(s.page);
    ui.expectClean(s);
    await ui.stop(s);

    // a fresh profile cannot read the history until it imports the file
    fresh = await ui.start();
    await ui.connect(fresh.page, live.server1);
    await ui.login(fresh.page, desk.email, desk.password);
    expect(await ui.dismissFirstPrompt(fresh.page)).toBe("New device");
    await ui.openChannel(fresh.page, live.server1, channel);
    await expect(ui.messageText(fresh.page, "exported history")).toBeHidden();

    await ui.openSettings(fresh.page, ENCRYPTION);
    await fresh.page.getByRole("button", { name: "Import keys" }).click();
    await fresh.page.locator('input[type="file"]').setInputFiles(file);
    await secret(fresh.page, /^Passphrase/).fill(passphrase);
    await ui.dialogButton(fresh.page, "Import").click();
    await expect(
      fresh.page.getByText(/^Imported ([1-9]\d*) of \1 keys\./),
    ).toBeVisible({
      timeout: 60_000,
    });
    await ui.dialogButton(fresh.page, "Done").click();
    await ui.closeSettings(fresh.page);
    await expect(ui.messageText(fresh.page, "exported history")).toBeVisible({
      timeout: 30_000,
    });
    await expect(fresh.page.getByText(/sender not confirmed$/)).toBeVisible();
    ui.expectClean(fresh);
  } finally {
    await ui.stop(s);
    if (fresh) await ui.stop(fresh);
    peer.close();
    if (existsSync(downloads))
      rmSync(downloads, { recursive: true, force: true });
  }
});
