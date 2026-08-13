import test from "node:test";
import assert from "node:assert/strict";
import { stripTerraformSetup } from "../runner/terraform-text.js";

test("removes exported terraform and Genesys provider blocks before import", () => {
  const exported = `terraform {
  required_providers {
    genesyscloud = {
      source  = "MyPureCloud/genesyscloud"
      version = "~> 1.84"
    }
  }
}

provider "genesyscloud" {}

resource "genesyscloud_routing_queue" "test" {
  name = "Test Queue"
}`;

  const prepared = stripTerraformSetup(exported);

  assert.doesNotMatch(prepared, /required_providers/);
  assert.doesNotMatch(prepared, /provider\s+"genesyscloud"/);
  assert.match(prepared, /resource\s+"genesyscloud_routing_queue"\s+"test"/);
  assert.match(prepared, /name = "Test Queue"/);
});

test("preserves data and resource blocks while removing setup blocks", () => {
  const exported = `terraform { required_providers { genesyscloud = { source = "MyPureCloud/genesyscloud" } } }
provider "genesyscloud" { aws_region = "us-east-1" }
data "genesyscloud_auth_division_home" "home" {}
resource "genesyscloud_routing_queue" "test" {
  division_id = data.genesyscloud_auth_division_home.home.id
  name        = "Test Queue"
}`;

  const prepared = stripTerraformSetup(exported);

  assert.match(prepared, /data "genesyscloud_auth_division_home" "home"/);
  assert.match(prepared, /division_id = data\.genesyscloud_auth_division_home\.home\.id/);
  assert.doesNotMatch(prepared, /^terraform/m);
  assert.doesNotMatch(prepared, /^provider/m);
});
