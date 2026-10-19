// dur.io (stage 7, D7): unpackaged runs only (`pnpm start`, Playwright) may use a
// separate profile, `--durio-user-data=<dir>`, so tests never touch the real one.
// Imported by `config.ts`, before `electron-store` reads the profile path; it also
// separates the single-instance lock, which Electron keys by the profile.
import { app } from "electron";

if (!app.isPackaged && app.commandLine.hasSwitch("durio-user-data")) {
  app.setPath("userData", app.commandLine.getSwitchValue("durio-user-data"));
}

// Playwright's Electron loader appends Chromium's automation switches, among them
// `--password-store=basic`: no keyring, so safeStorage has no encryption on Linux and
// the store keys are refused. `--durio-password-store=<store>` puts the keyring back;
// appended here, after the loader, it replaces that value before the app is ready.
if (!app.isPackaged && app.commandLine.hasSwitch("durio-password-store")) {
  app.commandLine.appendSwitch(
    "password-store",
    app.commandLine.getSwitchValue("durio-password-store"),
  );
}
