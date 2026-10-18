// dur.io (stage 7, D4): keys of the E2EE crypto stores, one per account. The main
// process makes 32 random bytes per accountKey and keeps them encrypted with the OS
// (safeStorage = DPAPI of the Windows user) in `userData/keys/<accountKey>.bin`.
// Contract with for-web: `DurioNativeBridge` in `components/common/lib/desktop.ts`.
// There is deliberately no generic "get a secret": only store keys by accountKey.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { app, safeStorage } from "electron";

import { handleTrusted } from "./security";

const ACCOUNT_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_LENGTH = 32;

/** A store key and whether this call created it */
export interface StoreKey {
  key: Uint8Array;
  created: boolean;
}

// one operation per account at a time: two windows asking at once must not both create
const queues = new Map<string, Promise<unknown>>();

function serialise<T>(accountKey: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(accountKey) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch((): void => undefined);
  queues.set(accountKey, settled);
  settled.then(() => {
    if (queues.get(accountKey) === settled) queues.delete(accountKey);
  });
  return next;
}

function keysDir() {
  return path.join(app.getPath("userData"), "keys");
}

function keyFile(accountKey: string) {
  if (typeof accountKey !== "string" || !ACCOUNT_KEY.test(accountKey)) {
    throw new Error("invalid account key");
  }

  return path.join(keysDir(), `${accountKey}.bin`);
}

function assertEncryption() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption is not available");
  }

  // without a keyring Linux falls back to a hardcoded password: refuse it
  if (
    process.platform === "linux" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  ) {
    throw new Error("no OS keyring to protect the key");
  }
}

/**
 * The store key of an account, created on first use
 * @param accountKey Account key, 1–128 of `[A-Za-z0-9_-]`
 */
export function getStoreKey(accountKey: string): Promise<StoreKey> {
  const file = keyFile(accountKey);

  return serialise(accountKey, async () => {
    assertEncryption();

    let sealed: Buffer | undefined;
    try {
      sealed = await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (sealed) {
      // never replace a key that exists but cannot be read: the page decides
      // (the "keys lost" wizard) after the user deletes it explicitly
      const key = Buffer.from(safeStorage.decryptString(sealed), "base64");
      if (key.length !== KEY_LENGTH) throw new Error("corrupt store key");
      return { key: new Uint8Array(key), created: false };
    }

    const key = randomBytes(KEY_LENGTH);
    await mkdir(keysDir(), { recursive: true, mode: 0o700 });

    // write then rename: a crash never leaves a half-written key behind
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      safeStorage.encryptString(key.toString("base64")),
      { mode: 0o600 },
    );
    await rename(temporary, file);

    return { key: new Uint8Array(key), created: true };
  });
}

/**
 * Delete the store key of a signed-out account; no error if there is none
 * @param accountKey Account key
 */
export function deleteStoreKey(accountKey: string): Promise<void> {
  const file = keyFile(accountKey);
  return serialise(accountKey, () => rm(file, { force: true }));
}

export function initSecrets() {
  handleTrusted("secrets:get", (_event, accountKey: string) =>
    getStoreKey(accountKey),
  );

  handleTrusted("secrets:delete", (_event, accountKey: string) =>
    deleteStoreKey(accountKey),
  );
}
