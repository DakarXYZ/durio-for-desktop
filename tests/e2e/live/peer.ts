// dur.io (WEB-08, D7): the scripted E2EE peer of durio-crypt (CR-15,
// `crates/stoat-crypto-testkit/examples/peer.rs`) in a container on the
// testkit network, driven over JSON lines on stdin/stdout
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { live } from "./env";

/** What `register` answers */
export interface Account {
  user_id: string;
  username: string;
  email: string;
  password: string;
  session_id: string;
  token: string;
}

/** A message as the peer reads it */
export interface PeerMessage {
  id: string;
  author: string;
  edited: boolean;
  text?: string;
  verification?: string;
  sender_device?: string;
  error?: string;
  attachments?: {
    name: string;
    size: number;
    content_type: string;
    sha256?: string;
    thumbnail?: { width: number; height: number; size?: number };
  }[];
}

/** SAS state of a flow */
export interface SasState {
  type: string;
  emoji?: { index: number; symbol: string; description: string }[];
  reason?: string;
  by_us?: boolean;
}

export class Peer {
  #process: ChildProcessWithoutNullStreams;
  #next = 1;
  #waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** stderr of the peer, for failure messages */
  readonly log: string[] = [];

  constructor() {
    this.#process = spawn(
      "docker",
      [
        "run",
        "-i",
        "--rm",
        "--network",
        live.network,
        "-e",
        "STOAT_API=http://durio-test-delta:14702",
        "-e",
        "STOAT_WS=ws://durio-test-bonfire:14703",
        "-e",
        "STOAT_AUTUMN=http://durio-test-autumn:14704",
        "-e",
        "STOAT_API2=http://durio-test-delta2:14702",
        "-e",
        "STOAT_WS2=ws://durio-test-bonfire2:14703",
        "-v",
        `${live.peerVolume}:/t:ro`,
        live.peerImage,
        "/t/debug/examples/peer",
      ],
      { stdio: "pipe", windowsHide: true },
    );

    createInterface({ input: this.#process.stdout }).on("line", (line) => {
      let answer: { id: number; ok: boolean; result?: unknown; error?: string };
      try {
        answer = JSON.parse(line);
      } catch {
        return;
      }
      const waiting = this.#waiting.get(answer.id);
      this.#waiting.delete(answer.id);
      if (answer.ok) waiting?.resolve(answer.result);
      else waiting?.reject(new Error(`peer: ${answer.error}`));
    });

    createInterface({ input: this.#process.stderr }).on("line", (line) =>
      this.log.push(line),
    );

    this.#process.on("exit", (code) => {
      for (const waiting of this.#waiting.values())
        waiting.reject(
          new Error(`peer exited (${code}): ${this.log.slice(-5).join("\n")}`),
        );
      this.#waiting.clear();
    });
  }

  /**
   * One command (see examples/peer.rs)
   * @param cmd Command
   * @param args Arguments
   */
  call<T = unknown>(cmd: string, args: Record<string, unknown> = {}) {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#waiting.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.#process.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }

  register(as: string, name: string, server = 1) {
    return this.call<Account>("register", { as, name, server });
  }

  /** A new session (device) of the account `like`, kept as `as` */
  login(as: string, like: string) {
    return this.call<{ user_id: string; session_id: string; token: string }>(
      "login",
      { as, like },
    );
  }

  open(as: string) {
    return this.call<{ device_id: string }>("open", { as });
  }

  api<T = unknown>(
    as: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    return this.call("api", { as, method, path, body });
  }

  async send(as: string, channel: string, text: string) {
    return (await this.call<{ message: string }>("send", { as, channel, text }))
      .message;
  }

  waitText(
    as: string,
    channel: string,
    text: { text?: string; contains?: string },
    timeout_ms = 30_000,
  ) {
    return this.call<PeerMessage>("wait_text", {
      as,
      channel,
      ...text,
      timeout_ms,
    });
  }

  messages(as: string, channel: string) {
    return this.call<PeerMessage[]>("messages", { as, channel });
  }

  sasState(as: string, flow: string, until: string[], timeout_ms = 30_000) {
    return this.call<SasState>("sas_state", { as, flow, until, timeout_ms });
  }

  sas(as: string, flow: string, action: string) {
    return this.call<SasState>("sas", { as, flow, action });
  }

  /**
   * A session of an account made in the app, kept as `as`
   * @param server 1 or 2
   */
  adopt(as: string, email: string, password: string, server = 1) {
    return this.call<{ user_id: string; username: string; session_id: string }>(
      "adopt",
      { as, email, password, server },
    );
  }

  /** `peer` befriends `desk`, opens their DM and switches encryption on */
  async encryptedDm(peer: string, desk: string) {
    await this.call("befriend", { from: peer, to: desk });
    const { channel } = await this.call<{ channel: string }>("dm", {
      as: peer,
      with: desk,
    });
    return channel;
  }

  /**
   * Two friends with an encrypted DM: `<prefix>desk` (the app's user; its
   * setup session is logged out again) and `<prefix>peer`, whose device is open
   * @param prefix Names in the peer
   * @param server 1 or 2
   */
  async encryptedPair(prefix = "", server = 1) {
    const deskName = `${prefix}desk`;
    const peerName = `${prefix}peer`;
    const desk = await this.register(deskName, "desk", server);
    const peer = await this.register(peerName, "peer", server);
    const channel = await this.encryptedDm(peerName, deskName);
    await this.call("logout", { as: deskName });
    const { device_id } = await this.open(peerName);
    return { desk, peer, channel, peerDevice: device_id, peerName, deskName };
  }

  /** Devices of a user as the peer `as` knows them */
  devices(as: string, user: string) {
    return this.call<{ device_id: string; trust: string; deleted: boolean }[]>(
      "devices",
      { as, user },
    );
  }

  close() {
    this.#process.stdin.end();
    this.#process.kill();
  }
}
