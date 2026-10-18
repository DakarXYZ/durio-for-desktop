import dbus from "@homebridge/dbus-native";

import { NativeImage, app, nativeImage } from "electron";

import { onTrusted } from "./security";
import { mainWindow } from "./window";

// dur.io (D5): overlay icons inlined at build time (-1 = unread dot, 10 = "9+")
const badgeAssets = import.meta.glob<string>(
  "../../assets/desktop/badges/*.ico",
  { eager: true, query: "?asset", import: "default" },
);

// internal state
const nativeIcons: Record<number, NativeImage> = {};
let sessionBus: dbus.MessageBus | null;

export async function setBadgeCount(count: number) {
  switch (process.platform) {
    case "win32":
    case "linux":
      if (count === 0) {
        mainWindow.setOverlayIcon(null, "No Notifications");
        break;
      }

      if (!nativeIcons[count])
        nativeIcons[count] = nativeImage.createFromDataURL(
          badgeAssets[`../../assets/desktop/badges/${Math.min(count, 10)}.ico`],
        );

      mainWindow.setOverlayIcon(
        nativeIcons[count],
        count === -1 ? `Unread Messages` : `${count} Notifications`,
      );

      break;
    // @ts-expect-error this is `linux` block
    case "_": // todo: try to get this to work
      // send D-Bus message
      // @ts-expect-error undocumented API
      if (!sessionBus) sessionBus = dbus.sessionBus();

      // @ts-expect-error undocumented API
      sessionBus.connection.message({
        // @ts-expect-error undocumented API
        type: dbus.messageType.signal,
        serial: 1,
        path: "/",
        interface: "com.canonical.Unity.LauncherEntry",
        member: "Update",
        signature: "sa{sv}",
        body: [
          process.env.container === "1"
            ? "application://io.github.dakarxyz.durio.desktop.desktop" // flatpak handling
            : "application://durio.desktop",
          [
            ["count", ["x", Math.min(count, 0)]],
            ["count-visible", ["b", count !== 0]],
          ],
        ],
      });

      break;
    case "darwin":
      app.dock.setBadge(
        count === -1 ? "•" : count === 0 ? "" : count.toString(),
      );

      break;
  }
}

onTrusted("setBadgeCount", (_event, count: number) => {
  if (Number.isInteger(count) && count >= -1) setBadgeCount(count);
});
