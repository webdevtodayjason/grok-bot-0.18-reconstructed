// The name in anything a person or a model reads. PERSONA-1 put it in the system prompt and left
// it written out by hand in the tool descriptions, which go to the model on EVERY turn: measured
// inside the running bundle on the R750 on 2026-09-09, the persona section said "This product is
// called Titanium Bot" once and four tool strings in the same request said the old one. A name
// that is a literal in more than one file is a name that goes stale in all but one of them.
export const SAND_PRODUCT_NAME = "Titanium Bot";

// NAME-1. The old name, still the identity of the desktop application: it is the macOS bundle
// name, the Squirrel update feed's product name and the token in the outgoing user agent, and
// changing it renames an installed app and breaks an update feed. Nothing a model reads may use
// it -- tests/standing-persona.test.mjs enforces that -- and nothing new should.
export const SAND_PRODUCT_DISPLAY_NAME = "Grok Bot";
export const SAND_PRODUCT_HTTP_TOKEN = SAND_PRODUCT_DISPLAY_NAME.replaceAll(/\s+/g, "");
