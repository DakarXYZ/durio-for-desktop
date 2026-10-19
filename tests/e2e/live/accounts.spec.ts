// dur.io (WEB-08, D7) scenario 10 (T14 in the app): two accounts on two
// servers in one profile — each with its own store key, crypto store and local
// store, each reading only its own server's encrypted DM, switched in the app
import { expect, test } from "@playwright/test";

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

test("two accounts on two servers stay apart", async () => {
  test.setTimeout(360_000);
  const peer = new Peer();
  const s = await ui.start();

  try {
    const one = await peer.encryptedPair("a", 1);
    const two = await peer.encryptedPair("b", 2);
    expect(accountKey(live.server1, one.desk.user_id)).not.toBe(
      accountKey(live.server2, two.desk.user_id),
    );

    // server 1
    await ui.connect(s.page, live.server1);
    await ui.login(s.page, one.desk.email, one.desk.password);
    await ui.dismissFirstPrompt(s.page);
    await peer.send(one.peerName, one.channel, "from server one");
    await ui.openChannel(s.page, live.server1, one.channel);
    await expect(ui.messageText(s.page, "from server one")).toBeVisible({
      timeout: 30_000,
    });

    // "Add an account" → the login screen → another server
    await ui.openSettings(s.page);
    await s.page.getByText("Add an account", { exact: true }).click();
    await expect(s.page.locator('mdui-text-field[name="email"]')).toBeVisible({
      timeout: 30_000,
    });
    await s.page.getByRole("button", { name: "Change server" }).click();
    await ui.connect(s.page, live.server2);
    await ui.login(s.page, two.desk.email, two.desk.password);
    await ui.dismissFirstPrompt(s.page);
    await peer.send(two.peerName, two.channel, "from server two");
    await ui.openChannel(s.page, live.server2, two.channel);
    await expect(ui.messageText(s.page, "from server two")).toBeVisible({
      timeout: 30_000,
    });

    // each account has its own key file, crypto store and local store
    const first = await ui.storage(s, live.server1, one.desk.user_id);
    const second = await ui.storage(s, live.server2, two.desk.user_id);
    for (const stored of [first, second]) {
      expect(stored.keyFile).toBe(true);
      expect(stored.drafts).toBe(true);
      expect(stored.crypto.length).toBeGreaterThan(0);
    }
    expect(first.crypto).not.toEqual(second.crypto);

    // back to the first account: its own DM decrypts, nothing of server 2 shows
    await s.page.mouse.click(35, 140);
    await s.page.getByText("Switch Accounts").click();
    await s.page
      .getByRole("button", { name: new RegExp(`desk_.* @ ${live.server1}`) })
      .or(
        s.page.getByText(
          new RegExp(`desk_.*@ ${live.server1.replace(".", "\\.")}`),
        ),
      )
      .first()
      .click();
    await ui.expectInApp(s.page);
    await ui.openChannel(s.page, live.server1, one.channel);
    await expect(ui.messageText(s.page, "from server one")).toBeVisible({
      timeout: 30_000,
    });
    await expect(ui.messageText(s.page, "from server two")).toBeHidden();
    expect(new URL(s.page.url()).pathname).toContain(`/i/${live.server1}/`);
    ui.expectClean(s);
  } finally {
    await ui.stop(s);
    peer.close();
  }
});
