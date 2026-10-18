import AutoLaunch from "auto-launch";

import { handleTrusted } from "./security";

export const autoLaunch = new AutoLaunch({
  name: "dur.io",
});

export function initAutoLaunch() {
  handleTrusted("getAutostart", async () => {
    const enabled = await autoLaunch.isEnabled();
    return enabled;
  });

  handleTrusted("setAutostart", async (_event, state: boolean) => {
    if (state === true) {
      await autoLaunch.enable();
      console.log("Received new configuration autoStart: true");
    } else {
      await autoLaunch.disable();
      console.log("Received new configuration autoStart: false");
    }

    const enabled = await autoLaunch.isEnabled();
    return enabled;
  });
}
