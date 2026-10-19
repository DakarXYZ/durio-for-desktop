// dur.io: an instance admin ends the sessions of another user in "Administration" →
// that user's app shows the logged-out screen and its local data (crypto store,
// drafts, key file) is deleted. Two apps on separate profiles; the admin is made one
// with `privileged` in the database (ids are random, `[api.admins] users` would need a
// restart of delta with a config file) and has an authenticator app: admin mode is
// turned on with its 2FA code when the page opens
import { type Page, expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { EOL, tmpdir } from "node:os";
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

/**
 * Make a user an instance admin of server 1
 * @param userId User id
 */
function makeAdmin(userId: string, mongo = "durio-test-mongo") {
  const result = spawnSync(
    "docker",
    [
      "exec",
      mongo,
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

/**
 * TOTP code of a base32 secret (RFC 6238: SHA-1, 30 s, 6 digits)
 * @param secret Base32 secret
 * @param at Time
 */
function totp(secret: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

/**
 * Turn the authenticator app on for an account of the peer
 * @returns The secret
 */
async function enableTotp(peer: Peer, as: string, password: string) {
  const ticket = await peer.api<{ token: string }>(
    as,
    "PUT",
    "/auth/mfa/ticket",
    { password },
  );
  const secret = await peer.call<{ status: number; body: { secret: string } }>(
    "api",
    { as, method: "POST", path: "/auth/mfa/totp", mfa: ticket.body.token },
  );
  expect(secret.status).toBe(200);
  const enabled = await peer.api(as, "PUT", "/auth/mfa/totp", {
    totp_code: totp(secret.body.secret),
  });
  expect([200, 204]).toContain(enabled.status);
  return secret.body.secret;
}

/**
 * Answer the 2FA prompt of admin mode with the authenticator app
 * @param page Page
 * @param secret TOTP secret
 */
async function confirmTotp(page: Page, secret: string) {
  await expect(page.getByText("Confirm action")).toBeVisible({
    timeout: 20_000,
  });
  const choose = page.getByText("Authenticator App", { exact: true });
  const code = page.locator('mdui-text-field[name="totp_code"] input');
  if ((await choose.isVisible()) && !(await code.isVisible()))
    await choose.click();
  // a code is accepted once: the one that enabled the app may still be current
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  await code.fill(totp(secret));
  await ui.dialogButton(page, "Confirm").click();
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
    await expect(
      target.page.getByText("Devices and encryption (beta)"),
    ).toBeVisible();
    await expect(
      target.page.getByText("Administration", { exact: true }),
    ).toHaveCount(0);
    await expect(async () => {
      await target.page.keyboard.press("Escape");
      await expect(target.page.locator(".settings_sidebar")).toHaveCount(0, {
        timeout: 2_000,
      });
    }).toPass({ timeout: 20_000 });

    // the admin, in an app of its own
    const account = await peer.register("admin", "admin");
    makeAdmin(account.user_id);
    admin = await ui.start();
    await ui.connect(admin.page, live.server1);
    await ui.login(admin.page, account.email, account.password);
    await ui.dismissFirstPrompt(admin.page);
    // after the login: a login with an authenticator app asks for its code too
    const secret = await enableTotp(peer, "admin", account.password);
    await ui.openSettings(admin.page, "Administration");
    await confirmTotp(admin.page, secret);
    await expect(admin.page.getByText(/^Admin mode is on until/)).toBeVisible({
      timeout: 20_000,
    });

    const query = admin.page.locator(
      'mdui-text-field[name="admin-query"] input',
    );
    await query.fill(`nobody_${Date.now().toString(36)}#0001`);
    await admin.page.getByRole("button", { name: "Find" }).click();
    await expect(
      admin.page.getByText("No user with this id or name."),
    ).toBeVisible({ timeout: 20_000 });

    // the peer's username is the tag already (name#1234); a leading @ is fine
    await query.fill(`@${desk.username}`);
    await admin.page.getByRole("button", { name: "Find" }).click();
    await expect(
      admin.page.getByText(desk.user_id, { exact: false }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(admin.page.getByText(/^dur\.io Desktop/).first()).toBeVisible({
      timeout: 20_000,
    });

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

/**
 * One request to a test server through the TLS proxy, from Node
 * @param server `srv2.localhost:<port>`
 */
function call(
  server: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{
  status: number;
  body: { type?: string } & Record<string, unknown>;
}> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // Node does not resolve *.localhost the way Chromium does
    const req = request(
      `https://127.0.0.1:${live.port}/api${route}`,
      {
        method,
        headers: {
          host: server,
          ...(data ? { "content-type": "application/json" } : {}),
        },
        servername: server.split(":")[0],
        rejectUnauthorized: false,
        timeout: 10_000,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            // empty
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * Restart delta of server 2 with sign-up by invitation on or off (the testkit has it
 * off; its other settings stay)
 * @param inviteOnly Invitation only
 */
async function inviteOnlyServer2(inviteOnly: boolean) {
  const name = "durio-test-delta2";
  const inspect = spawnSync(
    "docker",
    ["inspect", "-f", "{{json .Config.Env}}", name],
    { encoding: "utf8" },
  );
  expect(inspect.status, inspect.stderr).toBe(0);
  const env = (JSON.parse(inspect.stdout) as string[])
    .filter(
      (line) =>
        !line.startsWith("REVOLT__API__REGISTRATION__INVITE_ONLY=") &&
        !line.startsWith("PATH="),
    )
    .concat(`REVOLT__API__REGISTRATION__INVITE_ONLY=${inviteOnly}`);
  const file = path.join(tmpdir(), `durio-delta2-${Date.now()}.env`);
  writeFileSync(file, env.join(EOL));
  try {
    spawnSync("docker", ["rm", "-f", name]);
    const run = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        "--network",
        live.network,
        "--memory",
        "1g",
        "--env-file",
        file,
        "-v",
        "durio-cargo-target:/target:ro",
        "-w",
        "/",
        "durio-rust-dev:local",
        "/target/debug/revolt-delta",
      ],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
  } finally {
    rmSync(file, { force: true });
  }

  await expect
    .poll(
      async (): Promise<unknown> =>
        (await call(live.server2, "GET", "/").catch((): undefined => undefined))
          ?.body?.features,
      { timeout: 120_000, intervals: [1_000] },
    )
    .toMatchObject({ invite_only: inviteOnly });
}

test("admin invite links: single use, multi-use, revoked", async () => {
  test.setTimeout(420_000);
  const peer = new Peer();
  let admin: ui.Session | undefined;
  let fresh: ui.Session | undefined;
  const tag = Date.now().toString(36);
  const register = (n: string, invite: string) =>
    call(live.server2, "POST", "/auth/account/create", {
      email: `inv-${tag}-${n}@testkit.invalid`,
      password: `inv-${tag}-password`,
      invite,
    });

  try {
    // the admin of server 2, made before sign-up needs an invite
    const account = await peer.register("admin2", "admin", 2);
    makeAdmin(account.user_id, "durio-test-mongo2");
    await inviteOnlyServer2(true);

    admin = await ui.start();
    const page = admin.page;
    const app = admin.app;
    await ui.connect(page, live.server2);
    await ui.login(page, account.email, account.password);
    await ui.dismissFirstPrompt(page);
    const secret = await enableTotp(peer, "admin2", account.password);
    await ui.openSettings(page, "Administration");
    await confirmTotp(page, secret);
    await expect(page.getByText(/^Admin mode is on until/)).toBeVisible({
      timeout: 20_000,
    });

    // single use, 1 hour: the link is copied
    const clipboard = (): Promise<string> =>
      app.evaluate(({ clipboard }) => clipboard.readText());
    await page.getByRole("button", { name: "1 h", exact: true }).click();
    await page.getByRole("button", { name: "Create and copy link" }).click();
    await expect(page.getByText("Invite link copied.")).toBeVisible({
      timeout: 20_000,
    });
    const single = await clipboard();
    expect(single.startsWith(`https://${live.server2}/join/`)).toBe(true);
    const singleCode = single.split("/").pop()!;
    await expect(page.locator(`[data-invite="${singleCode}"]`)).toContainText(
      "single use",
    );

    // a new account in a fresh profile, the link pasted
    fresh = await ui.start();
    await ui.connect(fresh.page, live.server2);
    await ui.register(
      fresh.page,
      `inv-${tag}@testkit.invalid`,
      `inv-${tag}-password`,
      `inv_${tag}`,
      single,
    );
    await ui.dismissFirstPrompt(fresh.page);
    ui.expectClean(fresh);
    await ui.stop(fresh);
    fresh = undefined;

    // used up
    const again = await register("again", singleCode);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.body.type).toBe("InvalidInvite");

    // multi-use: counts its uses
    await page.locator('mdui-checkbox[name="admin-invite-multi"]').click();
    await page.getByRole("button", { name: "Create and copy link" }).click();
    await expect.poll(clipboard, { timeout: 20_000 }).not.toBe(single);
    const multiCode = (await clipboard()).split("/").pop()!;
    expect((await register("m1", multiCode)).status).toBe(204);
    expect((await register("m2", multiCode)).status).toBe(204);

    await ui.closeSettings(page);
    await ui.openSettings(page, "Administration");
    const card = page.locator(`[data-invite="${multiCode}"]`);
    await expect(card).toContainText("multi-use", { timeout: 20_000 });
    await expect(card).toContainText("accounts made: 2");

    // revoked: no more sign-ups
    await card.getByRole("button", { name: "Revoke" }).click();
    await page
      .locator(".dialog")
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await expect(card).toHaveCount(0, { timeout: 20_000 });
    const revoked = await register("m3", multiCode);
    expect(revoked.status).toBeGreaterThanOrEqual(400);
    expect(revoked.body.type).toBe("InvalidInvite");
    ui.expectClean(admin);
  } finally {
    if (fresh) await ui.stop(fresh);
    if (admin) await ui.stop(admin);
    peer.close();
    await inviteOnlyServer2(false);
  }
});
