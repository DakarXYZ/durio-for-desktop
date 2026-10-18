// dur.io additions to `window.native` (contract: for-web
// `components/common/lib/desktop.ts`, `DurioNativeBridge`); every call is checked
// by the main process to come from `app://durio/`
import { ipcRenderer } from "electron";

export const durioBridge = {
  servers: {
    default: () =>
      ipcRenderer.invoke("servers:default") as Promise<string | undefined>,
  },
};
