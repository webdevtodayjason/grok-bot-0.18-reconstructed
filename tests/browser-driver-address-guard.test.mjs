// BROWSER-1. Where the box's browser is allowed to go, checked at the driver itself.
//
// The host refuses an off-limits address before the box is touched, and this is the second
// refusal: the one standing next to Chrome, where a name has already been turned into an address.
// It exists because a name is free to point wherever it likes. `internal.example.com` resolving to
// 127.0.0.1 reaches the same files `file:///etc/passwd` does, and the host's literal check cannot
// see that.
//
// Measured on grok-bot-local-vm 2026-09-07 with no check on the path at all: file:///etc/passwd
// came back as page text plus a JPEG, and so did another seat's Chrome banner on 127.0.0.1:9232,
// the noVNC listing on 6080, and the operator console on host.docker.internal:7777.

import assert from "node:assert/strict";
import test from "node:test";

import { NOT_PUBLIC_WEB, checkPublicWebUrl, isPrivateAddress } from "../runtime/browser-driver/driver.mjs";

/** A resolver that answers whatever this case is about, so no test touches real DNS. */
const resolves = (address) => async () => [{ address, family: address.includes(":") ? 6 : 4 }];

const refuses = async (url, options) => {
  await assert.rejects(
    checkPublicWebUrl(url, { resolve: resolves("93.184.216.34"), ...options }),
    (error) => {
      assert.ok(error.message.startsWith(NOT_PUBLIC_WEB), `${url}: ${error.message}`);
      return true;
    },
    `${url} was allowed`,
  );
};

test("only http and https are addresses at all", async () => {
  for (const url of [
    "file:///etc/passwd",
    "file:///home/box/sand-data/box-secrets.json",
    "chrome://net-internals",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com",
    "data:text/html,<h1>hi</h1>",
    "javascript:alert(1)",
    "ftp://files.example.com/",
  ]) await refuses(url);
});

test("this machine, this network, and the computer underneath the box are all off limits", async () => {
  for (const url of [
    "http://127.0.0.1:9232/json/version",
    "http://127.0.0.1:6080/",
    "http://localhost:7777/",
    "http://box.localhost/",
    "http://host.docker.internal:7777/",
    "http://gateway.docker.internal/",
    "http://wiki.internal/",
    "http://10.1.2.3/",
    "http://172.20.0.9/",
    "http://192.168.48.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.101.102.103/",
    "http://[::1]:7777/",
    "http://0.0.0.0:8080/",
  ]) await refuses(url);
});

test("a name that points at this machine is caught too, because the name is not the address", async () => {
  await refuses("https://internal.example.com/", { resolve: resolves("127.0.0.1") });
  await refuses("https://metadata.example.com/", { resolve: resolves("169.254.169.254") });
  await refuses("https://six.example.com/", { resolve: resolves("::1") });
  await refuses("https://mapped.example.com/", { resolve: resolves("::ffff:10.0.0.4") });
});

test("an ordinary public page is opened, with the scheme filled in when it was left off", async () => {
  const publicDns = resolves("93.184.216.34");
  assert.equal(await checkPublicWebUrl("https://example.com/page", { resolve: publicDns }), "https://example.com/page");
  assert.equal(await checkPublicWebUrl("example.com", { resolve: publicDns }), "https://example.com");
  assert.equal(await checkPublicWebUrl("http://93.184.216.34/", { resolve: publicDns }), "http://93.184.216.34/");
  // A name nobody can resolve is the browser's to report a moment from now, in its own words.
  const dead = async () => { throw new Error("ENOTFOUND"); };
  assert.equal(await checkPublicWebUrl("https://nowhere.example/", { resolve: dead }), "https://nowhere.example/");
});

test("the operator's own list is the one way through, and it is exact", async () => {
  const allowHosts = ["host.docker.internal"];
  assert.equal(
    await checkPublicWebUrl("http://host.docker.internal:18791/", { allowHosts, resolve: resolves("192.168.65.254") }),
    "http://host.docker.internal:18791/",
  );
  // The list names hosts, not schemes, and nothing else on it comes along.
  await refuses("file:///etc/passwd", { allowHosts });
  await refuses("http://evil.host.docker.internal/", { allowHosts, resolve: resolves("1.2.3.4") });
  await refuses("http://127.0.0.1:9232/", { allowHosts });
});

test("an empty address is still the old plain complaint", async () => {
  await assert.rejects(checkPublicWebUrl("  "), /no address was given to open/);
});

test("the address ranges themselves", () => {
  for (const address of ["0.0.0.0", "10.255.1.1", "127.0.0.1", "172.16.0.1", "172.31.255.254",
    "192.168.1.1", "192.0.0.1", "169.254.1.1", "100.64.0.1", "239.1.2.3", "::1", "fe80::1", "fd00::1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "99.1.2.3", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});
