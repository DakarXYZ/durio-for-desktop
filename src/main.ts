import fs from "node:fs";
import path from "node:path";
import { IUpdateInfo, updateElectronApp } from "update-electron-app";

import { BrowserWindow, Notification, app, session } from "electron";
import started from "electron-squirrel-startup";

import { initAutoLaunch } from "./native/autoLaunch";
import { config } from "./native/config";
import { initDiscordRpc } from "./native/discordRpc";
import { handleAppProtocol, registerAppScheme } from "./native/protocol";
import { initSecrets } from "./native/secrets";
import { guardWebContents, lockDownSession } from "./native/security";
import { initServers } from "./native/servers";
import { initTray } from "./native/tray";
import { initVirtualMic } from "./native/virtualMic";
import { PARTITION, createMainWindow, mainWindow } from "./native/window";

// In Flatpak, we have to update the temp dir to a shared directory across host and sandbox;
// otherwise, the icon will not show up in the tray when using app indicators.
if (process.platform === "linux" && process.env.FLATPAK_ID) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    try {
      const sharedTmpDir = path.join(runtimeDir, "app", process.env.FLATPAK_ID);
      fs.mkdirSync(sharedTmpDir, { recursive: true });
      process.env.TMPDIR = sharedTmpDir;
    } catch (error) {
      console.error("Failed to set up host-visible TMPDIR:", error);
    }
  }
}

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// dur.io (D1): the AppUserModelID of the Squirrel shortcut, `com.squirrel.<package
// name>.<exe>`, set before any window or notification exists; otherwise toasts are
// attributed to another app and clicking them does not raise the window
const APP_USER_MODEL_ID = "com.squirrel.durio.durio";

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// dur.io (D2): `app://durio/` must be privileged before `ready`
registerAppScheme();

// disable hw-accel if so requested
if (!config.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

const onNotifyUser = (_info: IUpdateInfo) => {
  const notification = new Notification({
    title: "Update Available",
    body: "Restart the app to install the update.",
    silent: true,
  });

  notification.show();
};

if (acquiredLock) {
  // start auto update logic
  updateElectronApp({ onNotifyUser });

  // create and configure the app when electron is ready
  app.on("ready", () => {
    // serve the packaged web build and deny what it does not need (D2)
    const ses = session.fromPartition(PARTITION);
    lockDownSession(ses);
    lockDownSession(session.defaultSession);
    handleAppProtocol(ses);
    initServers();
    initSecrets();

    // create window and application contexts
    createMainWindow();

    // save first launch state
    if (config.firstLaunch) {
      // Doesn't do anything right now. Used to enable auto start, but that behaviour was removed.
      // Left in case it gets used in the future.
      config.firstLaunch = false;
    }

    initTray();
    initDiscordRpc();
    initVirtualMic();
    initAutoLaunch();
  });

  // focus the window if we try to launch again
  app.on("second-instance", () => {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });

  // macOS specific behaviour to keep app active in dock:
  // (irrespective of the minimise-to-tray option)

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // keep every web contents on `app://durio/`, open links in the external browser
  app.on("web-contents-created", (_, contents) => guardWebContents(contents));
} else {
  app.quit();
}
