// dur.io (WEB-08, D7) scenarios 3 and 4: the first prompt of a device; SAS
// started by a testkit device of another user — same emoji → Verified, "they
// don't match" → cancelled as a mismatch; a new own device signs in → notice
import { type Page, expect, test } from "@playwright/test";

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

/** The app's device as the peer sees it, once the peer queried its keys */
async function appDevice(peer: Peer, userId: string) {
  let device: string | undefined;
  await expect
    .poll(
      async () =>
        (device = (await peer.devices("peer", userId)).find(
          (d) => !d.deleted,
        )?.device_id),
      { timeout: 30_000 },
    )
    .toBeTruthy();
  return device!;
}

/** The emoji of the open SAS dialog */
async function shownEmoji(page: Page) {
  const dialog = page.getByText(
    "Check that the other screen shows the same emoji in the same order.",
  );
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // symbol + name per cell; the symbols are the first span of each cell
  return page.evaluate(() =>
    [...document.querySelectorAll("#floating span")]
      .filter(
        (span) =>
          span.parentElement?.children.length === 2 &&
          span === span.parentElement.firstElementChild &&
          /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(
            span.textContent ?? "",
          ),
      )
      .map((span) => span.textContent),
  );
}

test("first prompt, incoming SAS match and mismatch, new own device", async () => {
  test.setTimeout(300_000);
  const peer = new Peer();
  const s = await ui.start();

  try {
    const { desk, channel } = await peer.encryptedPair();
    await ui.connect(s.page, live.server1);
    await ui.login(s.page, desk.email, desk.password);

    // 4. the only device of an account without a backup: set up a recovery key
    expect(await ui.dismissFirstPrompt(s.page)).toBe(
      "Protect your encrypted history",
    );
    // the taskbar badge follows the unread DM (IPC setBadgeCount, D5)
    await s.app.evaluate(({ ipcMain }) => {
      const seen: number[] = [];
      (globalThis as unknown as { badges: number[] }).badges = seen;
      ipcMain.on("setBadgeCount", (_event, count: number) => seen.push(count));
    });
    await peer.send("peer", channel, "verify me");
    await expect
      .poll(() =>
        s.app.evaluate(
          () => (globalThis as unknown as { badges: number[] }).badges,
        ),
      )
      .toContain(1);
    await ui.openChannel(s.page, live.server1, channel);
    await expect(ui.messageText(s.page, "verify me")).toBeVisible({
      timeout: 30_000,
    });

    // 3. the peer asks to verify the app's device
    const device = await appDevice(peer, desk.user_id);
    let { flow } = await peer.call<{ flow: string }>("verify", {
      as: "peer",
      user: desk.user_id,
      device,
    });
    await expect(s.page.getByText(/wants to verify your device/)).toBeVisible({
      timeout: 30_000,
    });
    await ui.dialogButton(s.page, "Accept").click();
    await peer.sasState("peer", flow, ["Ready"]);
    await peer.sas("peer", flow, "start");
    const codes = await peer.sasState("peer", flow, ["ShowCodes"]);
    expect(await shownEmoji(s.page)).toEqual(
      codes.emoji!.map((emoji) => emoji.symbol),
    );
    await ui.dialogButton(s.page, "They match").click();
    await peer.sas("peer", flow, "confirm");
    expect(
      (await peer.sasState("peer", flow, ["Done", "Cancelled"])).type,
    ).toBe("Done");
    await expect(s.page.getByText(/^Device verified\./)).toBeVisible({
      timeout: 30_000,
    });
    await ui.dialogButton(s.page, "Close").click();
    expect(
      (await peer.devices("peer", desk.user_id)).find(
        (d) => d.device_id === device,
      )?.trust,
    ).toBe("Verified");

    // the same again, and the user says the emoji differ
    ({ flow } = await peer.call<{ flow: string }>("verify", {
      as: "peer",
      user: desk.user_id,
      device,
    }));
    await expect(s.page.getByText(/wants to verify your device/)).toBeVisible({
      timeout: 30_000,
    });
    await ui.dialogButton(s.page, "Accept").click();
    await peer.sasState("peer", flow, ["Ready"]);
    await peer.sas("peer", flow, "start");
    await peer.sasState("peer", flow, ["ShowCodes"]);
    await shownEmoji(s.page);
    await ui.dialogButton(s.page, "They don't match").click();
    await expect(s.page.getByText(/^The codes did not match/)).toBeVisible({
      timeout: 30_000,
    });
    const cancelled = await peer.sasState("peer", flow, ["Cancelled"]);
    expect([cancelled.reason, cancelled.by_us]).toEqual(["Mismatch", false]);
    await ui.dialogButton(s.page, "Close").click();

    // 4. another device of the same account signs in: the app offers to verify it
    await peer.login("desk2", "desk");
    await peer.open("desk2");
    await expect(
      s.page.getByText(/^A new device signed in to your account/),
    ).toBeVisible({ timeout: 30_000 });
    ui.expectClean(s);
  } finally {
    await ui.stop(s);
    peer.close();
  }
});
