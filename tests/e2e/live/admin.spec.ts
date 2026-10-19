// dur.io: an instance admin ends the sessions of another user in "Administration" →
// that user's app shows the logged-out screen and its local data (crypto store,
// drafts, key file) is deleted. Two apps on separate profiles; the admin is made one
// with `privileged` in the database (ids are random, `[api.admins] users` would need a
// restart of delta with a config file)
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";

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

/**
 * Make a user an instance admin of server 1
 * @param userId User id
 */
function makeAdmin(userId: string) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "durio-test-mongo",
      "mongosh",
      "revolt",
      "--quiet",
      "--eval",
      `db.users.updateOne({ _id: ${JSON.stringify(userId)} }, { $set: { privileged: true } }).modifiedCount`,
    ],
    { encoding: "utf8" },
  );
  expect(result.stdout.trim(), result.stderr).toBe("1");
}

test("admin ends all sessions of a user: logged out, local data deleted", async () => {
  test.setTimeout(300_000);
  const peer = new Peer();
  const target = await ui.start();
  let admin: ui.Session | undefined;

  try {
    const { desk, channel } = await peer.encryptedPair();
    await ui.connect(target.page, live.server1);
    await ui.login(target.page, desk.email, desk.password);
    await ui.dismissFirstPrompt(target.page);
    await ui.openChannel(target.page, live.server1, channel);
    await peer.send("peer", channel, "before the admin");
    await expect(ui.messageText(target.page, "before the admin")).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => ui.storage(target, live.server1, desk.user_id))
      .toMatchObject({ keyFile: true });

    // a non-admin has no "Administration"
    await ui.openSettings(target.page);
    await expect(target.page.getByText("Devices and encryption (beta)")).toBeVisible();
    await expect(
      target.page.getByText("Administration", { exact: true }),
    ).toHaveCount(0);
    await ui.closeSettings(target.page);

    // the admin, in an app of its own
    const account = await peer.register("admin", "admin");
    makeAdmin(account.user_id);
    admin = await ui.start();
    await ui.connect(admin.page, live.server1);
    await ui.login(admin.page, account.email, account.password);
    await ui.dismissFirstPrompt(admin.page);
    await ui.openSettings(admin.page, "Administration");

    const query = admin.page.locator('mdui-text-field[name="admin-query"] input');
    await query.fill(`nobody_${Date.now().toString(36)}#0001`);
    await admin.page.getByRole("button", { name: "Find" }).click();
    await expect(
      admin.page.getByText("No user with this id or name."),
    ).toBeVisible({ timeout: 20_000 });

    const profile = await peer.api<{ discriminator: string }>(
      "peer",
      "GET",
      `/users/${desk.user_id}`,
    );
    await query.fill(`@${desk.username}#${profile.body.discriminator}`);
    await admin.page.getByRole("button", { name: "Find" }).click();
    await expect(admin.page.getByText(desk.user_id, { exact: false })).toBeVisible(
      { timeout: 20_000 },
    );
    await expect(
      admin.page.getByText(/^dur\.io Desktop/).first(),
    ).toBeVisible({ timeout: 20_000 });

    await admin.page.getByRole("button", { name: "End all sessions" }).click();
    await expect(
      admin.page.getByText(/end-to-end encryption devices of these sessions/),
    ).toBeVisible();
    await ui.dialogButton(admin.page, "End all sessions").last().click();
    await expect(
      admin.page.getByText("The user is not signed in anywhere."),
    ).toBeVisible({ timeout: 20_000 });
    ui.expectClean(admin);

    // the user's app: the logged-out screen, nothing of the device left
    await peer.send("peer", channel, "after the admin");
    await expect(target.page.getByText("You've been logged out")).toBeVisible({
      timeout: 60_000,
    });
    await ui.dialogButton(target.page, "Log in").click();
    await expect(
      target.page.locator('mdui-text-field[name="email"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => ui.storage(target, live.server1, desk.user_id), {
        timeout: 20_000,
      })
      .toEqual({ crypto: [], drafts: false, keyFile: false });
    ui.expectClean(target);
  } finally {
    if (admin) await ui.stop(admin);
    await ui.stop(target);
    peer.close();
  }
});
