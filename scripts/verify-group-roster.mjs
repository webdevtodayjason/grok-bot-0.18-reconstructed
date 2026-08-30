// Proves the roster tells the truth about groups: create a probe group, assert listAgents
// reports isGroup:true with the exact member set, clean up. Exit 0 only on truth.
const RELAY = "http://127.0.0.1:7777";
const call = async (m, a = {}) => {
  const res = await fetch(`${RELAY}/api/${m}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
  const t = await res.text();
  if (!res.ok) throw new Error(`${m} -> ${res.status} ${t.slice(0, 160)}`);
  return JSON.parse(t);
};
const members = (await call("listAgents")).filter((a) => !a.isGroup).slice(0, 2).map((a) => a.id);
if (members.length < 2) throw new Error("need two individual agents to probe with");
const made = await call("createGroup", { name: "Roster Probe", description: "", memberAgentIds: members });
const gid = made?.agent?.id ?? made?.id;
// createGroup dedupes by member set: an existing group with these members is returned
// instead of created. Deleting it would destroy a real room -- only clean up a fresh one.
const created = (made?.agent?.name ?? "") === "Roster Probe";
try {
  const room = (await call("listAgents")).find((a) => a.id === gid);
  if (room == null) throw new Error("group missing from roster");
  const got = [...(room.memberIds ?? [])].sort().join(",");
  const want = [...members].sort().join(",");
  if (room.isGroup !== true) throw new Error(`isGroup=${room.isGroup}, want true`);
  if (got !== want) throw new Error(`memberIds=[${got}], want [${want}]`);
  console.log(`PASS — roster reports isGroup:true with ${members.length} members`);
} finally {
  if (created) await call("deleteAgent", { id: gid }).catch(() => {});
}
