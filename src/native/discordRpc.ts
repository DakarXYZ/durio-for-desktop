import { Client } from "discord-rpc";

import { config } from "./config";

// dur.io (D1): the upstream Discord application belongs to Stoat; without an
// application of our own the presence stays off even if the setting is on
const DISCORD_CLIENT_ID = "";

// internal state
let rpc: Client;

export async function initDiscordRpc() {
  if (!config.discordRpc || !DISCORD_CLIENT_ID) return;

  // clean up existing client if one exists
  rpc?.removeAllListeners();

  try {
    rpc = new Client({ transport: "ipc" });

    rpc.on("ready", () =>
      rpc.setActivity({
        state: "dur.io",
        details: "Chatting with others",
      }),
    );

    rpc.on("disconnected", reconnect);

    rpc.login({ clientId: DISCORD_CLIENT_ID });
  } catch {
    reconnect();
  }
}

const reconnect = () => setTimeout(() => initDiscordRpc(), 1e4);

export async function destroyDiscordRpc() {
  rpc?.destroy();
}
