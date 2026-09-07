import { test } from "node:test";
import assert from "node:assert/strict";
import { mailAddresses, routeMail } from "../ui/mail-edge.mjs";

const roster = [
  { id: "a1", name: "Titan" },
  { id: "a2", name: "Books" },
  { id: "g1", name: "Books", isGroup: true },
];
const settings = { domain: "titanium.bot", routes: {}, catchAllAgentId: "" };

test("a group chat never gets an address and never receives mail", () => {
  const rows = mailAddresses(roster, "titanium.bot");
  assert.equal(rows.some((r) => r.agentId === "g1"), false);
  const route = routeMail({ addresses: ["books@titanium.bot"], agents: roster, settings });
  assert.equal(route?.agentId, "a2");
});

test("mail addressed to a group's name with no agent of that name goes to the catch-all, not the group", () => {
  const agents = [{ id: "a1", name: "Titan" }, { id: "g2", name: "Sales", isGroup: true }];
  const route = routeMail({ addresses: ["sales@titanium.bot"], agents, settings });
  assert.equal(route?.agentId, "a1");
});
