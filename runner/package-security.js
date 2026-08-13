import path from "node:path";
import { promises as fs } from "node:fs";

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set([
  ".bat", ".cmd", ".com", ".dll", ".dylib", ".exe", ".jar", ".js",
  ".mjs", ".cjs", ".pl", ".ps1", ".py", ".rb", ".sh", ".so",
]);

export function validateZipEntries(entries) {
  if (!entries.length) throw new Error("The ZIP package is empty.");
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP package contains more than ${MAX_ENTRIES} entries.`);
  let totalBytes = 0;
  for (const entry of entries) {
    const normalized = path.posix.normalize(String(entry.entryName || "").replaceAll("\\", "/"));
    if (
      !normalized ||
      normalized.includes("\0") ||
      normalized.startsWith("../") ||
      normalized.startsWith("/") ||
      normalized.includes("/../") ||
      /^[a-zA-Z]:\//.test(normalized)
    ) {
      throw new Error("Unsafe ZIP path detected.");
    }
    if (normalized === ".terraform" || normalized.includes("/.terraform/")) {
      throw new Error("Packages may not contain a pre-installed .terraform directory.");
    }
    const unixMode = (Number(entry.header?.attr || 0) >>> 16) & 0o170000;
    if (unixMode === 0o120000) throw new Error("Symbolic links are not allowed in packages.");
    if (!entry.isDirectory && BLOCKED_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
      throw new Error(`Executable file type is not allowed in packages: ${path.basename(normalized)}`);
    }
    totalBytes += Number(entry.header?.size || entry.getData?.().length || 0);
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("ZIP package expands beyond the 500 MB safety limit.");
    }
  }
}

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in packages.");
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  await walk(root);
  return files;
}

export async function validateTerraformPackage(moduleRoot) {
  const files = await listFiles(moduleRoot);
  const terraformFiles = files.filter((file) => file.toLowerCase().endsWith(".tf"));
  if (!terraformFiles.length) throw new Error("Package does not contain Terraform .tf files.");

  let genesysResourceCount = 0;
  for (const file of terraformFiles) {
    const text = await fs.readFile(file, "utf8");
    if (/\bprovisioner\s+["']/i.test(text)) throw new Error("Terraform provisioners are not allowed in promotion packages.");
    if (/\bmodule\s+["']/i.test(text)) throw new Error("Terraform module blocks are not allowed in promotion packages.");
    if (/\bbackend\s+["']/i.test(text)) throw new Error("Remote or local backend blocks are not allowed in promotion packages.");

    for (const match of text.matchAll(/\bresource\s+["']([^"']+)["']/gi)) {
      if (!match[1].startsWith("genesyscloud_")) throw new Error(`Unsupported Terraform resource type: ${match[1]}`);
      if (match[1] !== "genesyscloud_tf_export") genesysResourceCount += 1;
    }
    for (const match of text.matchAll(/\bdata\s+["']([^"']+)["']/gi)) {
      if (!match[1].startsWith("genesyscloud_")) throw new Error(`Unsupported Terraform data source: ${match[1]}`);
    }
    for (const match of text.matchAll(/\bprovider\s+["']([^"']+)["']/gi)) {
      if (match[1] !== "genesyscloud") throw new Error(`Unsupported Terraform provider: ${match[1]}`);
    }
    for (const match of text.matchAll(/\bsource\s*=\s*["']([^"']+\/[^"']+)["']/gi)) {
      if (match[1].toLowerCase() !== "mypurecloud/genesyscloud") {
        throw new Error(`Unsupported Terraform provider source: ${match[1]}`);
      }
    }
  }
  if (!genesysResourceCount) throw new Error("Package does not contain managed Genesys Cloud resources.");
  return { fileCount: terraformFiles.length, resourceCount: genesysResourceCount };
}
