// dur.io (stage 7, D6): signing hook for @electron/windows-sign, called for every
// file to sign (the exe and DLLs of the package, the Squirrel installer and the
// contents of the .nupkg). v1 ships unsigned (O11'): forge.config.ts uses this hook
// only with DURIO_SIGN=1. The actual signer — SignPath (60-deploy §2a) or signtool
// with a certificate — is a command given in DURIO_SIGN_COMMAND, called as
// `<command> <file>`; it must sign the file in place and exit non-zero on failure.
const { execFileSync } = require("node:child_process");

module.exports = async function sign(filePath) {
  const command = process.env.DURIO_SIGN_COMMAND;
  if (!command) {
    throw new Error(
      "DURIO_SIGN=1 needs DURIO_SIGN_COMMAND: the program that signs one file",
    );
  }

  execFileSync(command, [filePath], { stdio: "inherit" });
};
