// dur.io (WEB-08, D7) scenarios 1, 2, 9, 11: an account made on the server
// address screen chats with a testkit device in an encrypted DM (text, edits,
// attachments with thumbnails), reads its history after a restart (store key
// from safeStorage) and signs out (crypto store, drafts and key file gone)
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

import { backendUp, live } from "./env";
import { Peer, type PeerMessage } from "./peer";
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

const sha256 = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");

test("register, encrypted DM with a testkit device, restart, sign out", async () => {
  test.setTimeout(360_000);
  const peer = new Peer();
  let s = await ui.start();
  const tag = Date.now().toString(36);
  const email = `desk-${tag}@testkit.invalid`;
  const password = `desk-${tag}-password`;

  try {
    // 1. the server address screen, a new account, the first prompt of a device
    await ui.connect(s.page, live.server1);
    await ui.register(s.page, email, password, `desk_${tag}`);
    expect(await ui.dismissFirstPrompt(s.page)).toBe(
      "Protect your encrypted history",
    );

    const desk = await peer.adopt("desk", email, password);
    await peer.register("peer", "peer");
    const channel = await peer.encryptedDm("peer", "desk");
    await peer.call("logout", { as: "desk" });
    await peer.open("peer");
    await ui.openChannel(s.page, live.server1, channel);

    // peer → app
    const first = await peer.send("peer", channel, `hello desktop ${tag}`);
    await expect(ui.messageText(s.page, `hello desktop ${tag}`)).toBeVisible({
      timeout: 30_000,
    });

    // Q63: an emoji is an image packaged with the app, not from static.stoat.chat
    // (expectClean below fails on any request outside the app and its servers)
    await peer.send("peer", channel, `emoji ${tag} \u{1F600}`);
    const emoji = s.page.locator('img.emoji[src="/emoji/twemoji/1f600.svg"]');
    await expect(emoji.first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() =>
        emoji.first().evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);

    // app → peer, the peer sees the app's device (not verified)
    await ui.sendText(s.page, `hello peer ${tag}`);
    const sent = await peer.waitText("peer", channel, {
      text: `hello peer ${tag}`,
    });
    expect(sent.verification).toBe("Unverified");
    expect(sent.author).toBe(desk.user_id);

    // edits both ways
    await ui.editLast(s.page, `edited by desktop ${tag}`);
    const edited = await peer.waitText("peer", channel, {
      text: `edited by desktop ${tag}`,
    });
    expect([edited.id, edited.edited]).toEqual([sent.id, true]);
    await expect(
      ui.messageText(s.page, `edited by desktop ${tag}`),
    ).toBeVisible();

    await peer.call("edit", {
      as: "peer",
      channel,
      message: first,
      text: `peer edited ${tag}`,
    });
    await expect(ui.messageText(s.page, `peer edited ${tag}`)).toBeVisible({
      timeout: 30_000,
    });

    // app → peer: an image, encrypted with a thumbnail made by the app
    const image = ui.png(640, 480);
    const chooser = s.page.waitForEvent("filechooser");
    // "+" opens the attach panel, its "Files" asks for any file
    await s.page.locator("button", { hasText: /^add$/ }).last().click();
    await s.page.locator("#floating button", { hasText: /Files$/ }).click();
    await (
      await chooser
    ).setFiles({
      name: `picture-${tag}.png`,
      mimeType: "image/png",
      buffer: image,
    });
    await ui.composer(s.page).click();
    await s.page.keyboard.press("Enter");

    let picture: PeerMessage | undefined;
    await expect
      .poll(
        async () =>
          (picture = (await peer.messages("peer", channel)).find((m) =>
            m.attachments?.some((a) => a.name === `picture-${tag}.png`),
          )),
        { timeout: 60_000 },
      )
      .toBeTruthy();
    const attachment = picture!.attachments![0];
    expect(attachment.sha256).toBe(sha256(image));
    expect(attachment.size).toBe(image.length);
    expect(attachment.thumbnail?.width).toBe(320);
    expect(attachment.thumbnail?.size).toBeGreaterThan(0);

    // peer → app: an image with a thumbnail, decrypted to a blob: URL
    await peer.call("send_file", {
      as: "peer",
      channel,
      name: `from-peer-${tag}.png`,
      content_type: "image/png",
      data: ui.png(200, 100).toString("base64"),
      thumbnail: ui.png(64, 32).toString("base64"),
      thumb_width: 64,
      thumb_height: 32,
      metadata: { type: "Image", width: 200, height: 100 },
    });
    await expect
      .poll(() => s.page.locator('img[src^="blob:"]').count(), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(2);

    // what the profile holds for the account
    const stored = await ui.storage(s, live.server1, desk.user_id);
    expect(stored.keyFile).toBe(true);
    expect(stored.crypto.length).toBeGreaterThan(0);
    ui.expectClean(s);

    // 2. restart: the history decrypts with the key from safeStorage
    await ui.stop(s, true);
    s = await ui.start(s.userData);
    await ui.expectInApp(s.page);
    await ui.openChannel(s.page, live.server1, channel);
    for (const text of [`peer edited ${tag}`, `edited by desktop ${tag}`])
      await expect(ui.messageText(s.page, text)).toBeVisible({
        timeout: 30_000,
      });
    await peer.send("peer", channel, `after restart ${tag}`);
    await expect(ui.messageText(s.page, `after restart ${tag}`)).toBeVisible({
      timeout: 30_000,
    });
    // no first prompt again on this device
    await expect(
      s.page.getByText("Protect your encrypted history"),
    ).toBeHidden();

    // an unsent draft lives in the account's local store
    await ui.composer(s.page).click();
    await s.page.keyboard.type(`unsent draft ${tag}`);
    await expect
      .poll(
        async () => (await ui.storage(s, live.server1, desk.user_id)).drafts,
      )
      .toBe(true);

    // 9. sign-out without a backup: offered one, then everything local goes
    await ui.openSettings(s.page);
    await s.page.getByText("Log Out", { exact: true }).click();
    await expect(s.page.getByText("Log out?")).toBeVisible();
    await ui.dialogButton(s.page, "Log out").click();
    await expect(s.page.locator('mdui-text-field[name="email"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => ui.storage(s, live.server1, desk.user_id), {
        timeout: 20_000,
      })
      .toEqual({ crypto: [], drafts: false, keyFile: false });

    // the server dropped the device: the peer no longer encrypts for it
    await expect
      .poll(
        async () =>
          (await peer.devices("peer", desk.user_id)).filter((d) => !d.deleted)
            .length,
        { timeout: 20_000 },
      )
      .toBe(0);
    ui.expectClean(s);
  } finally {
    await ui.stop(s);
    peer.close();
  }
});
