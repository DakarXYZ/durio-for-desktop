<div align="center">
<h1>dur.io for Windows</h1>

A fork of [Stoat for Desktop](https://github.com/stoatchat/for-desktop) for self-hosted servers, with end-to-end
encrypted direct messages and groups (beta). Windows only; Linux is kept building in CI.

</div>
<br/>

## How it differs from upstream

- **The interface ships with the app.** The window loads a local build of
  [durio-for-web](https://github.com/DakarXYZ/durio-for-web) (`vite build --mode desktop`) from `app://durio/`
  (`src/native/protocol.ts`), never a remote page: a hijacked chat server cannot swap the code that holds the
  encryption keys. The build is packed into the asar as `web/`; a release names the exact for-web commit
  (`for-web.lock.json`, `web/durio-web.json` with the SHA-256 of every file).
- **Locked down** (`src/native/security.ts`): navigation and redirects only within `app://durio`, links open in the
  external browser, permissions only `media`, `display-capture`, `notifications`, `clipboard-sanitized-write`,
  `fullscreen`, `speaker-selection` and only for the app, every IPC checks that the sender frame is
  `app://durio/`, the `Content-Security-Policy` header comes from for-web's `desktop/csp.mjs` (copied here as
  `src/native/csp.mjs`, checked by `scripts/sync-web.mjs`) plus `frame-ancestors 'none'`.
- **No built-in server.** The first launch asks for a server address; all servers and accounts share one session
  (`persist:main`) and for-web keeps their data apart. A build may suggest an address with
  `DURIO_DEFAULT_SERVER=<host>` (empty by default).
- **E2EE store keys** (`src/native/secrets.ts`): 32 random bytes per account, sealed with `safeStorage` (DPAPI) in
  `%APPDATA%\dur.io\keys\<accountKey>.bin`. They protect the crypto store against other Windows users and a stolen
  disk, not against programs running as the same user.
- Updates only from the GitHub Releases of this repository. Discord Rich Presence is off.

The bridge the page sees (`window.native`, `window.desktopConfig`) is documented in the for-web README, section
"dur.io fork: desktop build".

## Installing (users)

Releases are **not code-signed** yet. Windows SmartScreen warns about an unknown publisher: _More info_ → _Run
anyway_. With Smart App Control turned on (Windows 11), unsigned apps are blocked and it has to be turned off.
Antivirus software may flag the installer. Check the download against `SHA256SUMS` from the same release:

```powershell
Get-FileHash .\durio-setup.exe -Algorithm SHA256
```

The app installs per user (`%LOCALAPPDATA%\durio`, no admin rights) next to an official Stoat install; data is in
`%APPDATA%\dur.io`. Notifications show the text of decrypted messages; Windows keeps the text of toasts
unencrypted in its notification database.

## Development

Requirements: Node 22+, pnpm (`corepack enable`), and a checkout of
[durio-for-web](https://github.com/DakarXYZ/durio-for-web) next to this one (`../for-web`).

```bash
pnpm install

# build for-web in desktop mode and copy it into web/ (gitignored)
pnpm web:build            # = node scripts/sync-web.mjs --build
pnpm web:sync             # only copy an existing packages/client/dist-desktop
# --from <dir>: another for-web checkout; --strict: require the pinned commit

pnpm start                # run unpackaged (DURIO_WEB_DIR=<dir> serves another build)
pnpm lint && pnpm typecheck && pnpm fmt
pnpm package              # out/dur.io-win32-x64, also builds .vite/build for the tests
pnpm test:e2e             # Playwright tests on the unpackaged app (live ones skip without a backend)
pnpm make                 # Squirrel installer (Windows), zip
```

**E2EE scenarios with a backend (WEB-08, D7):** `tests/e2e/live` runs the real for-web build in the app against
the stoat-crypto testkit stack, with the testkit's scripted peer (`examples/peer.rs`, a container on the stack
network) as the other device: register on the server address screen, encrypted DM (text, edits, attachments with
thumbnails), restart, sign-out, incoming SAS (match and mismatch), first prompt and "new device" notice, backup
create/replace/rotate/restore, key export/import, session revoked (while running and while closed), lost store
key, two accounts on two servers; every flow checks for CSP violations, page errors and requests to anything but
the app and its servers. Needs Docker and the workspace layout (`../stoat-crypto`, `../stoatchat`):

```bash
TESTKIT_PUBLIC_PORT=14443 ../stoat-crypto/scripts/testkit-backend.sh up   # + tools/rust-dev/test-env.sh up
pnpm package && pnpm test:e2e     # ≈ 6 min; https://srv1.localhost:14443 and srv2.localhost are the servers
../stoat-crypto/scripts/testkit-backend.sh down && ../tools/rust-dev/test-env.sh down
```

The app trusts the proxy's internal CA only through `--ignore-certificate-errors` on the test command line.
CI: job `e2e-live` (Linux, xvfb, gnome-keyring for safeStorage).

Placeholder icons until there is a brand asset: `node scripts/placeholder-icons.mjs` writes `assets/desktop/`.

### Releases

Only CI builds releases (`.github/workflows/durio.yml`): for-web at the pinned commit with `mise build:desktop`,
`sync-web --strict`, lint, typecheck, Playwright, `pnpm make --platform win32`, `SHA256SUMS`; a `v*` tag drafts a
GitHub release. Before tagging, point `for-web.lock.json` at a pushed for-web commit.

Code signing is prepared but off: `DURIO_SIGN=1` with `DURIO_SIGN_COMMAND=<program that signs one file>` makes
forge sign the package, the installer and the `.nupkg` contents through `scripts/windows-sign-hook.cjs` (SignPath
or signtool).

## License

AGPL-3.0, like upstream. Stoat is a trademark of its owners; this build is called dur.io.
