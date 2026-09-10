// DOOR-1. The front door, in the bytes the relay actually serves.
//
// scripts/verify-door.mjs measures this page in a real browser at real phone sizes, which is the only
// way to know a computed font-size or a document width. This file is the half that needs no browser and
// therefore runs on every `npm test`: the attributes and the declarations a browser would be computing
// FROM. A regression in either one shows up here in two seconds instead of in a 300 s gate.
//
// What each assertion is standing in for, measured on grok-bot-local-vm at 390x844 on 2026-09-09:
//
//   - document scrollWidth 400 against a 390 px screen, because the form was content-box: 360 - 48
//     plus 28 px of padding and a 1 px border each side laid out 342 + 56 + 2.
//   - iOS Safari zooming the first screen a customer ever sees, because body set 14 px and both the
//     inputs and the button carried `font: inherit`.
//   - autofocus on the first field, which is what makes that zoom happen on arrival rather than on a tap.
//   - the page titled "Machine Room" in a purple nothing else in the product uses.
import assert from "node:assert/strict";
import test from "node:test";

import { RELAY_TOKEN, startRelay, tenantRow, tenantsFile } from "./relay-tenant-support.mjs";

const htmlHeaders = { accept: "text/html" };

const doorOf = async (relay) => {
  const res = await fetch(`${relay.base}/login`, { headers: htmlHeaders });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store", "a login page is never cached anywhere");
  return await res.text();
};

// Both branches of the one template, because a page that offered the email field on one route and not
// another would be a bug nobody notices until a customer meets the wrong one after a mistyped password.
async function bothDoors(run) {
  const single = await startRelay();
  try { await run(await doorOf(single), "no control plane"); } finally { single.stop(); }
  const demo = tenantRow("demo");
  const fleet = await startRelay({
    CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN, SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
  }, { pathValue: "/nonexistent" });
  try { await run(await doorOf(fleet), "with a control plane"); } finally { fleet.stop(); }
}

test("every control on the door declares 16px, which is the size iOS stops zooming at", async () => {
  await bothDoors((html, which) => {
    // body is 14px and both controls carry `font: inherit`, so BOTH have to say 16px for themselves.
    // One of the two moving is the failure this catches: the button at 14px zooms on its own tap.
    const inputRule = /\n\s*input \{([^}]*)\}/.exec(html)?.[1] ?? "";
    const buttonRule = /\n\s*button \{([^}]*)\}/.exec(html)?.[1] ?? "";
    assert.match(inputRule, /font-size:\s*16px/, `${which}: the inputs`);
    assert.match(buttonRule, /font-size:\s*16px/, `${which}: the button`);
    // 44px is the touch target, on the same two rules.
    assert.match(inputRule, /min-height:\s*44px/, `${which}: the inputs are a thumb tall`);
    assert.match(buttonRule, /min-height:\s*44px/, `${which}: and so is the button`);
  });
});

test("the autofocus attribute is gone outright, rather than media-queried", async () => {
  await bothDoors((html, which) => {
    // HTML has no media query, so there is no such thing as autofocus-on-desktop-only in one template.
    // It is removed, and the gate's honest evidence is the absent attribute plus document.activeElement
    // being body -- because Chrome cannot prove the iOS zoom either way.
    assert.equal(/autofocus/i.test(html), false, `${which}: no autofocus anywhere in the served bytes`);
  });
});

test("the viewport covers the notch and the form is border-box, which is the 10 px", async () => {
  await bothDoors((html, which) => {
    const meta = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
    assert.match(meta, /width=device-width/, which);
    assert.match(meta, /initial-scale=1/, which);
    assert.match(meta, /viewport-fit=cover/, `${which}: without this the card sits under the notch`);

    const formRule = /\n\s*form \{([^}]*)\}/.exec(html)?.[1] ?? "";
    assert.match(formRule, /box-sizing:\s*border-box/, `${which}: the padding and the border are INSIDE the 360`);
    // And the arithmetic is gone with it: `min(360px, 100%)` inside a padded body rather than
    // `calc(100vw - 48px)`, which was one padding change away from being wrong again.
    assert.match(formRule, /width:\s*min\(360px,\s*100%\)/, which);
    assert.equal(/100vw/.test(html), false, `${which}: no viewport-width arithmetic is left to get wrong`);
    // The safe area, so a notch in landscape and the home indicator are both cleared.
    assert.match(html, /env\(safe-area-inset-left\)/, which);
    assert.match(html, /env\(safe-area-inset-bottom\)/, which);
  });
});

test("the door is Midnight and Signal Cyan, with the Ti mark inline and the product's name on it", async () => {
  await bothDoors((html, which) => {
    assert.match(html, /--midnight:\s*#090D14/i, `${which}: the product's ground`);
    assert.match(html, /--cyan:\s*#00C8F0/i, `${which}: Signal Cyan`);
    assert.match(html, /--titanium:\s*#E6EBF2/i, which);
    assert.match(html, /--graphite:\s*#172232/i, which);
    // The purple is gone. It was #8b69ea on the button and the focus ring and belonged to nothing.
    assert.equal(/8b69ea|9a7cf0/i.test(html), false, `${which}: no purple from the old page`);

    // Inline, because the comment above loginPage says an asset path exempted from the session check
    // would be a hole in the thing this page exists to close.
    assert.match(html, /<svg class="mark"/, `${which}: the Ti mark is in this response`);
    assert.match(html, /<rect[^>]*fill="#00C8F0"/, `${which}: and the i's dot is the cyan one`);
    assert.equal(/<link[^>]*stylesheet/.test(html), false, `${which}: no stylesheet to exempt`);
    assert.equal(/<img|<script/.test(html), false, `${which}: and no subresource at all`);

    assert.match(html, /<title>Sign in - Titanium Bot<\/title>/, which);
    assert.match(html, /<h1>.*Titanium <b>Bot<\/b>/s, `${which}: the brand lockup IS the heading`);
    // The product is Titanium Bot. "Machine Room" is the console's own room name and has no business
    // on the first screen a customer ever sees.
    assert.equal(/Machine Room/.test(html), false, `${which}: the string appears nowhere`);
  });
});

test("the two doors behave exactly as they did: the email field only with a control plane", async () => {
  const single = await startRelay();
  try {
    const html = await doorOf(single);
    assert.equal(html.includes('name="email"'), false, "one workspace, one password, no email field");
    assert.match(html, /This console drives the box/);
    assert.equal(html.includes("Titanium Bot account"), false);
    // Still one form and one button: two forms would make a customer choose between two words for the
    // same thing before they had any way of knowing which one they hold.
    assert.equal((html.match(/<form/g) ?? []).length, 1);
    assert.equal((html.match(/<button/g) ?? []).length, 1);
  } finally { single.stop(); }

  const demo = tenantRow("demo");
  const fleet = await startRelay({
    CP_URL: "http://127.0.0.1:1", CP_RELAY_TOKEN: RELAY_TOKEN, SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
  }, { pathValue: "/nonexistent" });
  try {
    const html = await doorOf(fleet);
    assert.match(html, /Sign in with your Titanium Bot account/);
    assert.match(html, /id="email"[^>]*type="email"/);
    assert.match(html, /or the instance password/);
    assert.equal((html.match(/<form/g) ?? []).length, 1);
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    assert.match(html, /id="password"[^>]*type="password"/);
  } finally { fleet.stop(); }
});

test("an error and a next path are escaped into the page rather than pasted into it", async () => {
  const relay = await startRelay();
  try {
    // A wrong password renders the same template with the sentence inline, which is the one path that
    // puts a string this process did not author into the page.
    const refused = await fetch(`${relay.base}/login?next=${encodeURIComponent('/"><script>x</script>')}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ password: "not it" }).toString(),
    });
    assert.equal(refused.status, 401);
    const html = await refused.text();
    assert.match(html, /class="error" role="alert"/);
    assert.equal(/<script>/.test(html), false, "nothing off the query string becomes markup");
  } finally { relay.stop(); }
});
