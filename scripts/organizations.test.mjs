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

test("explicit confirmation deletes only verified missing organizations; newly created organizations survive a stale list", async () => {
  const client = database(["org_deleted", "org_new"]);
  const result = await synchronizeOrganizations(client, async (path, allowMissing) => {
    if (path.startsWith("/organizations?")) return { data: [{ id: "org_current" }], total_count: 1 };
    assert.equal(allowMissing, true);
    return path.endsWith("org_deleted") ? null : { id: "org_new" };
  }, { confirmDelete: true });
  assert.deepEqual(result, { synchronized: 1, deleted: 1 });
  assert.deepEqual(client.writes, [
    { p_organization_id: "org_current", p_deleted: false },
    { p_organization_id: "org_deleted", p_deleted: true },
  ]);
});

test("one missing organization requires confirmation before any database writes", async () => {
  const client = database(["org_current", "org_deleted"]);
  await assert.rejects(synchronizeOrganizations(client, async path => {
    if (path.startsWith("/organizations?")) return { data: [{ id: "org_current" }], total_count: 1 };
    return null;
  }), error => {
    assert.match(error.message, /1 organization\(s\)/);
    assert.match(error.message, /\n  org_deleted\n/);
    assert.match(error.message, /cascading foreign keys/);
    assert.match(error.message, /CLERK_SECRET_KEY/);
    assert.match(error.message, /--confirm-delete/);
    assert.match(error.message, /No database writes/);
    return true;
  });
  assert.deepEqual(client.writes, []);
});

test("a different Clerk instance cannot delete every stored organization without confirmation", async () => {
  const client = database(["org_a", "org_b"]);
  await assert.rejects(synchronizeOrganizations(client, async path => {
    if (path.startsWith("/organizations?")) return { data: [{ id: "org_other" }], total_count: 1 };
    return null;
  }), error => {
    assert.match(error.message, /2 organization\(s\)/);
    assert.match(error.message, /\n  org_a\n  org_b\n/);
    return true;
  });
  assert.deepEqual(client.writes, []);
});

test("organization synchronization needs no confirmation when there are no deletions", async () => {
  const client = database(["org_current"]);
  const result = await synchronizeOrganizations(client, async path => {
    assert.ok(path.startsWith("/organizations?"));
    return { data: [{ id: "org_current" }, { id: "org_new" }], total_count: 2 };
  });
  assert.deepEqual(result, { synchronized: 2, deleted: 0 });
  assert.deepEqual(client.writes, [
    { p_organization_id: "org_current", p_deleted: false },
    { p_organization_id: "org_new", p_deleted: false },
  ]);
});

test("confirmation cannot bypass Clerk verification failures", async () => {
  const client = database(["org_a", "org_b"]);
  await assert.rejects(synchronizeOrganizations(client, async path => {
    if (path.startsWith("/organizations?")) return { data: [], total_count: 0 };
    if (path.endsWith("org_a")) return null;
    throw new Error("HTTP 429");
  }, { confirmDelete: true }), /429/);
  assert.deepEqual(client.writes, []);
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
