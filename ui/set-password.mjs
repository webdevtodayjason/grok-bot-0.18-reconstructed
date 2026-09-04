#!/usr/bin/env node
// set-password.mjs -- set the relay's login password.
//
//   node ui/set-password.mjs                 prompt twice, no echo
//   printf '%s' "$PASSWORD" | node ui/set-password.mjs   read it from stdin (no prompt, no echo)
//   node ui/set-password.mjs /path/auth.json write somewhere other than ui/auth.json
//
// It writes ui/auth.json at mode 0600: a scrypt salt and hash, and a fresh 32 byte cookie signing
// secret. The password itself is never written, never echoed and never printed back. Rotating the
// cookie secret on every run is deliberate: it is the only way to sign existing sessions out.
//
// Setting a password is what unlocks a non-loopback bind. Without this file the relay serves
// loopback exactly as it always has, and refuses to start on any other address.
import path from "node:path";
import { newAuthRecord, writeAuthFile } from "./auth.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, "auth.json");
// An online guesser gets ten tries a minute through the lockout, so length is the only defence
// that matters here. Eight is the floor, not a recommendation.
const MIN_LENGTH = 8;

const die = (message) => { process.stderr.write(`set-password: ${message}\n`); process.exit(1); };

// Reads one line with the terminal's echo turned off. Raw mode means this loop owns every
// keystroke, including the ones that have to keep working: ctrl-c must still quit, and backspace
// must still delete, or the operator cannot correct a typo they cannot see.
function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(label);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const done = (error, result) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error); else resolve(result);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(null, value);
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        if (ch < " ") continue;
        value += ch;
      }
    };
    input.on("data", onData);
  });
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // One line, trailing newline stripped, so `printf '%s\n' "$PW" |` and `printf '%s' "$PW" |`
  // set the same password rather than two that differ by an invisible byte.
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

let password;
if (process.stdin.isTTY) {
  try {
    password = await promptHidden("New relay password: ");
    const again = await promptHidden("Repeat it: ");
    if (password !== again) die("the two entries did not match; nothing was written");
  } catch (error) { die(String(error?.message ?? error)); }
} else {
  password = await readAllStdin();
  if (password.length === 0) die("no password on stdin; nothing was written");
}

if (password.length < MIN_LENGTH) die(`the password must be at least ${MIN_LENGTH} characters; nothing was written`);

try { writeAuthFile(FILE, newAuthRecord(password)); }
catch (error) { die(`could not write ${FILE}: ${String(error?.message ?? error)}`); }

process.stdout.write(`wrote ${FILE} at mode 0600 (${password.length} characters, scrypt)\n`);
process.stdout.write("every existing session is now signed out; restart the relay to load it\n");
