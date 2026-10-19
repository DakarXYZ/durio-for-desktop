// dur.io (WEB-08, D7) scenarios 7 and 8: the session is revoked on another
// device → the logged-out screen, and signing in again leaves nothing of the
// old device (crypto store, drafts, key file); the store key is lost (file
// deleted while the store exists) → the "keys lost" wizard
import { expect, test } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";

import { accountKey, backendUp, live } from "./env";
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

/**
 * Another device of the account ends the app's session (an MFA ticket, the password)
 * @param peer Peer that knows the account as `desk`
 * @param password Password
 */
async function revokeAppSession(peer: Peer, password: string) {
  await peer.login("desk2", "desk");
  const sessions = await peer.api<{ _id: string; name: string }[]>(
    "desk2",
    "GET",
    "/auth/session/all",
  );
  const app = sessions.body.find((x) => x.name.startsWith("dur.io Desktop"));
  expect(app, JSON.stringify(sessions.body)).toBeTruthy();
  const ticket = await peer.api<{ token: string }>(
    "desk2",
    "PUT",
    "/auth/mfa/ticket",
    { password },
  );
  const revoked = await peer.call<{ status: number }>("api", {
    as: "desk2",
    method: "DELETE",
    path: `/auth/session/${app!._id}`,
    mfa: ticket.body.token,
  });
  expect(revoked.status).toBe(204);
}

test("session revoked elsewhere: logged out, local data deleted", async () => {
  test.setTimeout(240_000);
  const peer = new Peer();
  const s = await ui.start();

  try {
    const { desk, channel } = await peer.encryptedPair();
    await ui.connect(s.page, live.server1);
    await ui.login(s.page, desk.email, desk.password);
    await ui.dismissFirstPrompt(s.page);
    await ui.openChannel(s.page, live.server1, channel);
    await peer.send("peer", channel, "before the revocation");
    await expect(ui.messageText(s.page, "before the revocation")).toBeVisible({
      timeout: 30_000,
    });
    await ui.composer(s.page).click();
    await s.page.keyboard.type("a draft that must not survive");
    await expect
      .poll(() => ui.storage(s, live.server1, desk.user_id))
      .toMatchObject({ drafts: true, keyFile: true });

    // another device of the account ends the app's session
    const unauthorized: string[] = [];
    s.page.on("response", (response) => {
      if (response.status() === 401) unauthorized.push(response.url());
    });
    await revokeAppSession(peer, desk.password);

    // a new message makes the app fetch its mailbox (/e2ee/*) with the dead token
    await peer.send("peer", channel, "after the revocation");
    await expect(s.page.getByText("You've been logged out")).toBeVisible({
      timeout: 60_000,
    });
    test.info().annotations.push({
      type: "401",
      description: unauthorized.join(" ") || "none",
    });
    await ui.dialogButton(s.page, "Log in").click();
    await expect(s.page.locator('mdui-text-field[name="email"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => ui.storage(s, live.server1, desk.user_id), {
        timeout: 20_000,
      })
      .toEqual({ crypto: [], drafts: false, keyFile: false });
    ui.expectClean(s);
  } finally {
    await ui.stop(s);
    peer.close();
  }
});

test("session revoked while the app was closed: logged out at start, data deleted", async () => {
  test.setTimeout(240_000);
  const peer = new Peer();
  let s = await ui.start();

  try {
    const { desk } = await peer.encryptedPair();
    await ui.connect(s.page, live.server1);
    await ui.login(s.page, desk.email, desk.password);
    await ui.dismissFirstPrompt(s.page);
    expect((await ui.storage(s, live.server1, desk.user_id)).keyFile).toBe(
      true,
    );
    await ui.stop(s, true);

    await revokeAppSession(peer, desk.password);
    s = await ui.start(s.userData);
    await expect(s.page.getByText("You've been logged out")).toBeVisible({
      timeout: 60_000,
    });
    await ui.dialogButton(s.page, "Log in").click();
    await expect(s.page.locator('mdui-text-field[name="email"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => ui.storage(s, live.server1, desk.user_id), {
        timeout: 20_000,
      })
      .toEqual({ crypto: [], drafts: false, keyFile: false });
    ui.expectClean(s);
  } finally {
    await ui.stop(s);
    peer.close();
  }
});

test("store key lost: the wizard, then a clean sign-out", async () => {
  test.setTimeout(240_000);
  const peer = new Peer();
  let s = await ui.start();

  try {
    const { desk } = await peer.encryptedPair();
    await ui.connect(s.page, live.server1);
    await ui.login(s.page, desk.email, desk.password);
    await ui.dismissFirstPrompt(s.page);
    const before = await ui.storage(s, live.server1, desk.user_id);
    expect(before.keyFile).toBe(true);
    expect(before.crypto.length).toBeGreaterThan(0);
    await ui.stop(s, true);

    // the key file goes (a restored or copied profile), the store stays
    rmSync(
      path.join(
        s.userData,
        "keys",
        `${accountKey(live.server1, desk.user_id)}.bin`,
      ),
    );
    s = await ui.start(s.userData);
    await expect(s.page.getByText(/^Encryption was reset/)).toBeVisible({
      timeout: 60_000,
    });
    await ui.dialogButton(s.page, "Log out and log in again").click();
    await expect(s.page.locator('mdui-text-field[name="email"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => ui.storage(s, live.server1, desk.user_id), {
        timeout: 20_000,
      })
      .toEqual({ crypto: [], drafts: false, keyFile: false });

    // signing in again makes a new device that works
    await ui.login(s.page, desk.email, desk.password);
    expect(await ui.dismissFirstPrompt(s.page)).toBe(
      "Protect your encrypted history",
    );
    ui.expectClean(s);
  } finally {
    await ui.stop(s);
    peer.close();
  }
});
