// dur.io (stage 7, D2): the page is a local build served from `app://durio/`, and only
// that origin may talk to the main process, navigate the window or get permissions.
import {
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
  ipcMain,
  shell,
} from "electron";

export const APP_SCHEME = "app";
export const APP_HOST = "durio";
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/`;

/**
 * Whether a URL belongs to the packaged app. `new URL("app://durio/").origin` is
 * "null" in Node (not a special scheme), so compare protocol and host explicitly
 * @param url URL to check
 */
export function isAppUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/**
 * Whether an IPC message comes from a frame of the packaged app
 * @param event IPC event
 */
export function isTrustedSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
): boolean {
  // senderFrame is null when the frame navigated away or was destroyed
  const url = event.senderFrame?.url;
  return typeof url === "string" && url.startsWith(APP_URL);
}

/**
 * `ipcMain.on` that drops messages from anything but `app://durio/`
 * @param channel IPC channel
 * @param listener Listener
 */
export function onTrusted<A extends unknown[]>(
  channel: string,
  listener: (event: IpcMainEvent, ...args: A) => void,
) {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      console.warn(`Rejected IPC "${channel}" from an untrusted frame`);
      return;
    }

    listener(event, ...(args as A));
  });
}

/**
 * `ipcMain.handle` that rejects calls from anything but `app://durio/`
 * @param channel IPC channel
 * @param listener Handler
 */
export function handleTrusted<A extends unknown[], R>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>,
) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      console.warn(`Rejected IPC "${channel}" from an untrusted frame`);
      throw new Error("untrusted sender");
    }

    return listener(event, ...(args as A));
  });
}

/**
 * Permissions the page may get (Q64), and only for `app://durio/`.
 * `speaker-selection` lets the voice settings pick an output device.
 */
const ALLOWED_PERMISSIONS = new Set<string>([
  "media",
  "display-capture",
  "notifications",
  "clipboard-sanitized-write",
  "fullscreen",
  "speaker-selection",
]);

/**
 * Whether a permission may be granted
 * @param permission Permission name
 * @param requestingUrl URL of the frame asking
 * @param topUrl URL of the page the frame is in
 */
function permits(
  permission: string,
  requestingUrl: string | undefined,
  topUrl: string | undefined,
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission) || !isAppUrl(topUrl)) return false;

  // embeds (YouTube and the like) may go fullscreen inside the app, nothing else
  return permission === "fullscreen" || isAppUrl(requestingUrl);
}

/**
 * Deny everything but the allowed permissions of the app (Electron grants all
 * permissions by default) and all device access (HID, USB, serial)
 * @param ses Session to lock down
 */
export function lockDownSession(ses: Session) {
  ses.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const allowed = permits(
        permission,
        details.requestingUrl,
        webContents?.getURL(),
      );

      if (!allowed) console.warn(`Denied permission request "${permission}"`);
      callback(allowed);
    },
  );

  ses.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      permits(
        permission,
        details.requestingUrl ?? requestingOrigin,
        webContents?.getURL() ?? details.embeddingOrigin,
      ),
  );

  ses.setDevicePermissionHandler(() => false);
}

/**
 * Keep every web contents on `app://durio/`: no navigation or redirect elsewhere,
 * no <webview>, new windows go to the external browser
 * @param contents Web contents just created
 */
export function guardWebContents(contents: WebContents) {
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      console.warn("Blocked navigation away from the app");
      event.preventDefault();
    }
  });

  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) {
      console.warn("Blocked redirect away from the app");
      event.preventDefault();
    }
  });

  contents.on("will-attach-webview", (event) => event.preventDefault());

  contents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith("http:") ||
      url.startsWith("https:") ||
      url.startsWith("mailto:")
    ) {
      setImmediate(() => {
        shell.openExternal(url);
      });
    }

    return { action: "deny" };
  });
}
