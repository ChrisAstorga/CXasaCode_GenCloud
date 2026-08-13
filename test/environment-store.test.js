import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { EnvironmentStore } from "../runner/environment-store.js";

test("environment vault never returns secrets from list", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "environment-store-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(path.join(directory, "environments.json"));
  await store.initialize();

  const created = await store.upsert({
    name: "Non Production",
    region: "us-east-1",
    clientId: "client-12345678",
    clientSecret: "top-secret-value",
  });
  const listed = await store.list();
  const privateProfile = await store.get(created.id);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].configured, true);
  assert.equal("clientSecret" in listed[0], false);
  assert.equal("clientId" in listed[0], false);
  assert.equal(privateProfile.clientSecret, "top-secret-value");
});

test("blank credential fields preserve existing credentials during edit", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "environment-store-update-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(path.join(directory, "environments.json"));
  const created = await store.upsert({
    name: "Production",
    region: "us-east-1",
    clientId: "original-client",
    clientSecret: "original-secret",
  });

  await store.upsert({ id: created.id, name: "Production US", region: "us-west-2", clientId: "", clientSecret: "" });
  const updated = await store.get(created.id);

  assert.equal(updated.name, "Production US");
  assert.equal(updated.region, "us-west-2");
  assert.equal(updated.clientId, "original-client");
  assert.equal(updated.clientSecret, "original-secret");
});
