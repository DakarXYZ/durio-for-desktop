// dur.io (stage 7, D2): put the for-web desktop build into `web/`, which forge packs
// into the asar and `protocol.handle("app")` serves as `app://durio/`.
//
//   node scripts/sync-web.mjs [--from ../for-web] [--build] [--strict]
//
// --from    for-web checkout (default: ../for-web, the workspace layout)
// --build   run the desktop build of for-web first (`mise run build:desktop`, or the
//           same steps without mise; for-web dependencies must be installed and built)
// --strict  for releases: for-web must be at the commit pinned in `for-web.lock.json`
//           with a clean tree (CI checks that commit out, see .github/workflows)
//
// Always checks that the CSP copied into this repo (`src/native/csp.mjs`) is the
// for-web one and matches the <meta> of the build, then writes `web/durio-web.json`
// (for-web commit + SHA-256 of every file) so a release names exactly what it ships.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.join(import.meta.dirname, "..");
const { values: args } = parseArgs({
  options: {
    from: { type: "string", default: path.join(ROOT, "..", "for-web") },
    build: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
  },
});

const forWeb = path.resolve(args.from);
const dist = path.join(forWeb, "packages", "client", "dist-desktop");
const target = path.join(ROOT, "web");
const lock = JSON.parse(
  readFileSync(path.join(ROOT, "for-web.lock.json"), "utf8"),
);

function fail(message) {
  console.error(`sync-web: ${message}`);
  process.exit(1);
}

function run(command, cwd) {
  console.info(`sync-web: ${command}`);
  const result = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  if (result.status !== 0) fail(`"${command}" failed`);
}

function git(...gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: forWeb, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** SHA-256 of a text file, independent of the checkout's line endings */
function textHash(file) {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex");
}

function* walk(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), relative);
    else yield relative;
  }
}

if (!existsSync(forWeb)) fail(`no for-web checkout at ${forWeb}`);

// which for-web this is
const commit = git("rev-parse", "HEAD");
const dirty = !!git("status", "--porcelain", "--untracked-files=no");
if (!commit) fail(`${forWeb} is not a git checkout`);
if (commit !== lock.commit || dirty) {
  const message = `for-web is at ${commit}${dirty ? " (modified)" : ""}, the pin is ${lock.commit}`;
  if (args.strict) fail(message);
  console.warn(`sync-web: warning: ${message}`);
}

if (args.build) {
  const hasMise =
    spawnSync("mise", ["--version"], { shell: true }).status === 0;
  if (hasMise) {
    run("mise run build:desktop", forWeb);
  } else {
    run("node packages/client/desktop/fetch-rnnoise.mjs", forWeb);
    run("pnpm --filter client exec vite build --mode desktop", forWeb);
    run(
      "node packages/client/desktop/check-build.mjs packages/client/dist-desktop",
      forWeb,
    );
  }
}

if (!existsSync(path.join(dist, "index.html"))) {
  fail(
    `no desktop build in ${dist}; run with --build or "mise build:desktop" in for-web`,
  );
}

// the CSP header of the Electron side must be the policy for-web was built with
const ours = path.join(ROOT, "src", "native", "csp.mjs");
const theirs = path.join(forWeb, "packages", "client", "desktop", "csp.mjs");
if (textHash(ours) !== textHash(theirs)) {
  fail(
    "src/native/csp.mjs differs from for-web packages/client/desktop/csp.mjs: copy it over",
  );
}

const { DESKTOP_CSP } = await import(pathToFileURL(ours).href);
const html = readFileSync(path.join(dist, "index.html"), "utf8");
const meta = html.match(
  /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i,
)?.[1];
const decoded = meta
  ?.replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&");
if (decoded !== DESKTOP_CSP)
  fail("the CSP <meta> of the build is not DESKTOP_CSP");

// copy
rmSync(target, { recursive: true, force: true });
cpSync(dist, target, { recursive: true });

const files = {};
for (const file of [...walk(target)].sort()) {
  files[file] = createHash("sha256")
    .update(readFileSync(path.join(target, file)))
    .digest("hex");
}

writeFileSync(
  path.join(target, "durio-web.json"),
  JSON.stringify(
    {
      repository: lock.repository,
      commit,
      dirty,
      pinned: commit === lock.commit,
      files,
    },
    null,
    2,
  ) + "\n",
);

console.info(
  `sync-web: copied ${Object.keys(files).length} files of for-web ${commit.slice(0, 10)}${dirty ? " (modified)" : ""} to web/`,
);
