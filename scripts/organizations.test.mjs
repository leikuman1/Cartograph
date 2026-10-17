import assert from "node:assert/strict";
import test from "node:test";
import { synchronizeOrganizations } from "./organizations.mjs";

function database(ids = []) {
  const writes = [];
  return {
    writes,
    async rpc(name, args) {
      if (name === "list_organization_ids") {
        return { data: ids.filter(id => id > args.p_after_id).slice(0, 100).map(id => ({ id })), error: null };
      }
      assert.equal(name, "sync_organization");
      writes.push(args);
      return { data: null, error: null };
    },
  };
}

test("only a confirmed missing organization is deleted; newly created organizations survive a stale list", async () => {
  const client = database(["org_deleted", "org_new"]);
  const result = await synchronizeOrganizations(client, async (path, allowMissing) => {
    if (path.startsWith("/organizations?")) return { data: [{ id: "org_current" }], total_count: 1 };
    assert.equal(allowMissing, true);
    return path.endsWith("org_deleted") ? null : { id: "org_new" };
  });
  assert.deepEqual(result, { synchronized: 1, deleted: 1 });
  assert.deepEqual(client.writes, [
    { p_organization_id: "org_current", p_deleted: false },
    { p_organization_id: "org_deleted", p_deleted: true },
  ]);
});

test("a Clerk failure cannot turn a partial deletion plan into database writes", async () => {
  const client = database(["org_a", "org_b"]);
  await assert.rejects(synchronizeOrganizations(client, async path => {
    if (path.startsWith("/organizations?")) return { data: [], total_count: 0 };
    if (path.endsWith("org_a")) return null;
    throw new Error("HTTP 429");
  }), /429/);
  assert.equal(client.writes.length, 0);
});

test("incomplete Clerk pagination cannot delete organizations", async () => {
  const client = database(["org_existing"]);
  await assert.rejects(synchronizeOrganizations(client, async path => {
    return path.includes("offset=0")
      ? { data: [{ id: "org_one" }], total_count: 2 }
      : { data: [], total_count: 2 };
  }), /incomplete/);
  assert.equal(client.writes.length, 0);
});

test("all pages of the private registry are checked", async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `org_${String(index).padStart(3, "0")}`);
  const client = database(ids);
  const checked = [];
  const result = await synchronizeOrganizations(client, async path => {
    if (path.startsWith("/organizations?")) return { data: [], total_count: 0 };
    const id = path.split("/").at(-1);
    checked.push(id);
    return { id };
  });
  assert.deepEqual(checked, ids);
  assert.equal(result.deleted, 0);
});
