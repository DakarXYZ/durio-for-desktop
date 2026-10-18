// dur.io additions to `window.native` (contract: for-web
// `components/common/lib/desktop.ts`, `DurioNativeBridge`); every call is checked
// by the main process to come from `app://durio/`
import { ipcRenderer } from "electron";

export const durioBridge = {
  /** 32-byte key of an account's crypto store, created on first use (D4) */
  e2eeStoreKey: (accountKey: string) =>
    ipcRenderer.invoke("secrets:get", accountKey) as Promise<{
      key: Uint8Array;
      created: boolean;
    }>,

  /** Forget the key of a signed-out account */
  e2eeDeleteStoreKey: (accountKey: string) =>
    ipcRenderer.invoke("secrets:delete", accountKey) as Promise<void>,

  servers: {
    default: () =>
      ipcRenderer.invoke("servers:default") as Promise<string | undefined>,
  },
};
