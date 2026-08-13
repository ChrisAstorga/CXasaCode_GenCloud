import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { validateTerraformPackage, validateZipEntries } from "../runner/package-security.js";

async function fixture(t, terraform) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "terraform-package-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "genesyscloud.tf"), terraform);
  return directory;
}

test("accepts a Genesys-only Terraform package", async (t) => {
  const directory = await fixture(t, `
terraform {
  required_providers {
    genesyscloud = { source = "MyPureCloud/genesyscloud" }
  }
}
provider "genesyscloud" {}
resource "genesyscloud_routing_queue" "support" {
  name = "Support"
}
`);
  const result = await validateTerraformPackage(directory);
  assert.equal(result.resourceCount, 1);
});

test("rejects modules, provisioners, and non-Genesys resources", async (t) => {
  const moduleDirectory = await fixture(t, `module "unsafe" { source = "example/unsafe" }`);
  await assert.rejects(() => validateTerraformPackage(moduleDirectory), /module blocks are not allowed/i);

  const resourceDirectory = await fixture(t, `resource "local_file" "unsafe" { filename = "x" }`);
  await assert.rejects(() => validateTerraformPackage(resourceDirectory), /Unsupported Terraform resource type/i);
});

test("rejects traversal paths and executable files in ZIP entries", () => {
  assert.throws(
    () => validateZipEntries([{ entryName: "../escape.tf", isDirectory: false, header: { size: 1, attr: 0 } }]),
    /Unsafe ZIP path/i,
  );
  assert.throws(
    () => validateZipEntries([{ entryName: "payload.sh", isDirectory: false, header: { size: 1, attr: 0 } }]),
    /Executable file type/i,
  );
});

test("allows export metadata JSON files beside the Terraform configuration", () => {
  assert.doesNotThrow(() => validateZipEntries([
    { entryName: "genesyscloud.tf", isDirectory: false, header: { size: 100, attr: 0 } },
    { entryName: "promotion-manifest.json", isDirectory: false, header: { size: 100, attr: 0 } },
    { entryName: "unresolved-references.json", isDirectory: false, header: { size: 100, attr: 0 } },
  ]));
});
