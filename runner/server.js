import express from "express";
import cors from "cors";
import multer from "multer";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  EnvironmentStore,
  SUPPORTED_REGIONS,
  resolveEnvironmentFile,
} from "./environment-store.js";
import {
  validateTerraformPackage,
  validateZipEntries,
} from "./package-security.js";
import { stripTerraformSetup } from "./terraform-text.js";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
try {
  process.loadEnvFile(path.join(PROJECT_ROOT, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(os.tmpdir(), "genesys-transfer-runner");
const UPLOAD_ROOT = path.join(ROOT, "uploads");
const PLUGIN_CACHE = path.join(ROOT, "plugin-cache");
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TERRAFORM_TIMEOUT_MS = 30 * 60 * 1000;
const GUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SAFE_RESOURCE_TYPE = /^genesyscloud_[a-z0-9_]+$/;
const SAFE_IMPORT_ID = /^[A-Za-z0-9._:/,@+-]{1,512}$/;
const jobs = new Map();
const sessions = new Map();
const environmentStore = new EnvironmentStore(resolveEnvironmentFile(PROJECT_ROOT));

await Promise.all([
  fs.mkdir(ROOT, { recursive: true }),
  fs.mkdir(UPLOAD_ROOT, { recursive: true }),
  fs.mkdir(PLUGIN_CACHE, { recursive: true }),
  environmentStore.initialize(),
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const app = express();
app.disable("x-powered-by");

function isAllowedBrowserOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin(origin, callback) {
      // Development runs on 5173, while `npm start` serves the UI from the
      // configurable runner port. Allow loopback origins on either surface.
      const allowed = isAllowedBrowserOrigin(origin);
      callback(allowed ? null : new Error("Origin is not allowed."), allowed);
    },
    allowedHeaders: ["Content-Type", "X-Session-Id"],
  }),
);
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  dest: UPLOAD_ROOT,
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter(_request, file, callback) {
    const isZip = path.extname(file.originalname || "").toLowerCase() === ".zip";
    callback(isZip ? null : new Error("Only ZIP packages are accepted."), isZip);
  },
});

const asyncRoute = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};
const makeId = () => crypto.randomUUID();
const safeName = (value = "") => String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
const quote = (value) => JSON.stringify(String(value));

function redact(text, profile = {}) {
  let result = String(text || "");
  for (const [label, value] of [
    ["CLIENT_ID", profile.clientId],
    ["CLIENT_SECRET", profile.clientSecret],
  ]) {
    if (value) result = result.split(value).join(`[REDACTED_${label}]`);
  }
  return result;
}

function addLog(job, line) {
  job.logs.push(String(line));
  if (job.logs.length > 1500) job.logs.shift();
  job.updatedAt = new Date().toISOString();
}

function run(command, args, cwd, env, onLine = () => {}, timeoutMs = TERRAFORM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    timer.unref();

    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (buffer) => {
        const text = redact(buffer.toString(), {
          clientId: env.GENESYSCLOUD_OAUTHCLIENT_ID,
          clientSecret: env.GENESYSCLOUD_OAUTHCLIENT_SECRET,
        });
        output += text;
        for (const line of text.split(/\r?\n/)) if (line) onLine(line);
      });
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${command} could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} exceeded the ${Math.round(timeoutMs / 60000)} minute timeout.`));
      if (code === 0) return resolve(output);
      const details = output.trim().slice(-12000);
      reject(new Error(`${command} exited with code ${code}${details ? `\n\n${details}` : ""}`));
    });
  });
}

function terraformEnvironment(profile) {
  return {
    GENESYSCLOUD_OAUTHCLIENT_ID: profile.clientId,
    GENESYSCLOUD_OAUTHCLIENT_SECRET: profile.clientSecret,
    GENESYSCLOUD_REGION: profile.region,
    TF_IN_AUTOMATION: "1",
    TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE,
  };
}

function providerHeader(region, includeProvider = true) {
  return `terraform {
  required_providers {
    genesyscloud = {
      source  = "MyPureCloud/genesyscloud"
      version = "~> 1.84"
    }
  }
}
${includeProvider ? `\nprovider "genesyscloud" {\n  aws_region = ${quote(region)}\n}\n` : ""}`;
}

function setJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    logs: job.logs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    plan: job.plan,
    planHash: job.planHash,
    manifest: job.manifest,
    target: job.target,
    stateDownloadAvailable: Boolean(job.statePath),
  };
}

async function authenticatedContext(request) {
  const sessionId = String(request.get("X-Session-Id") || "").trim();
  const session = sessions.get(sessionId);
  if (!session) throw new HttpError(401, "Your Genesys session is not active. Connect to an environment again.");
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    throw new HttpError(401, "Your Genesys session expired. Connect again.");
  }
  const profile = await environmentStore.get(session.environmentId);
  if (!profile || profile.updatedAt !== session.profileUpdatedAt) {
    sessions.delete(sessionId);
    throw new HttpError(401, "The selected environment changed. Connect again to refresh authentication.");
  }
  session.lastUsedAt = Date.now();
  return { sessionId, session, profile };
}

const requireSession = asyncRoute(async (request, _response, next) => {
  request.auth = await authenticatedContext(request);
  next();
});

function getOwnedJob(request) {
  const job = jobs.get(request.params.id);
  if (!job || job.sessionId !== request.auth.sessionId) throw new HttpError(404, "Job not found.");
  return job;
}

function connectionTestConfiguration(region) {
  return `${providerHeader(region)}
data "genesyscloud_organizations_me" "connected" {}

output "connected_organization" {
  value = {
    id     = data.genesyscloud_organizations_me.connected.id
    name   = data.genesyscloud_organizations_me.connected.name
    domain = data.genesyscloud_organizations_me.connected.domain
  }
}
`;
}

async function verifyEnvironment(profile, onLine = () => {}) {
  const directory = path.join(ROOT, `connect-${makeId()}`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(path.join(directory, "main.tf"), connectionTestConfiguration(profile.region));
    const env = terraformEnvironment(profile);
    await run("terraform", ["init", "-input=false", "-no-color"], directory, env, onLine);
    await run("terraform", ["apply", "-auto-approve", "-input=false", "-no-color"], directory, env, onLine);
    const raw = await run("terraform", ["output", "-json", "connected_organization"], directory, env, onLine);
    const organization = JSON.parse(raw);
    if (!organization?.id || !organization?.name) throw new Error("Genesys organization identity was not returned.");
    return organization;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function terraformVersion() {
  return run("terraform", ["version"], ROOT, {}, () => {}, 15000);
}

function exportConfiguration(body, profile) {
  const excludedTypes = new Set((body.excludeResources || []).map((value) => String(value).trim()).filter(Boolean));
  const effectiveTypes = body.resourceTypes.filter((type) => !excludedTypes.has(type));
  const filters = effectiveTypes.map((type) => body.regex && body.regex !== ".*" ? `${type}::${body.regex}` : type);
  const arrayLines = (values) => (values || []).map((value) => `    ${quote(value)},`).join("\n");
  if (!filters.length) throw new HttpError(400, "No export resource types remain after applying exclusions.");
  return `${providerHeader(profile.region)}
resource "genesyscloud_tf_export" "portable" {
  directory                    = "./exported-package"
  export_format                = "hcl"
  include_state_file           = false
  enable_dependency_resolution = ${body.dependencyResolution !== false}
  split_files_by_resource      = ${body.splitFiles !== false}
  log_permission_errors        = true
  include_filter_resources = [
${arrayLines(filters)}
  ]
  exclude_attributes = [
${arrayLines(body.excludeAttributes)}
  ]
}
`;
}

function validateExportRequest(body) {
  if (!Array.isArray(body.resourceTypes) || !body.resourceTypes.length || body.resourceTypes.length > 250) {
    throw new HttpError(400, "Select between 1 and 250 resource types.");
  }
  if (!body.resourceTypes.every((type) => SAFE_RESOURCE_TYPE.test(type))) {
    throw new HttpError(400, "Export request contains an invalid resource type.");
  }
  const regex = String(body.regex || ".*");
  if (regex.length > 300) throw new HttpError(400, "Object-name regex must be 300 characters or fewer.");
  try { new RegExp(regex); } catch { throw new HttpError(400, "Object-name regex is invalid."); }
}

async function scanFiles(directory) {
  const result = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else {
        const extension = path.extname(entry.name).toLowerCase();
        if ([".tf", ".json", ".yaml", ".yml"].includes(extension)) {
          const text = await fs.readFile(fullPath, "utf8").catch(() => "");
          const identifiers = [...new Set(text.match(GUID_PATTERN) || [])];
          if (identifiers.length) result.push({ file: path.relative(directory, fullPath), guids: identifiers });
        }
      }
    }
  }
  await walk(directory);
  return result;
}

async function zipDirectory(sourceDirectory, outputZipPath) {
  const zip = new AdmZip();
  zip.addLocalFolder(sourceDirectory);
  await new Promise((resolve, reject) => zip.writeZip(outputZipPath, (error) => error ? reject(error) : resolve()));
}

async function listTopLevelFiles(directory, extension) {
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(directory, entry.name));
}

function stripTerraformAndProviderBlocks(text) {
  return stripTerraformSetup(text);
}

async function consolidateExport(directory) {
  const terraformFiles = await listTopLevelFiles(directory, ".tf");
  const parts = [providerHeader("us-east-1", false) + '\nprovider "genesyscloud" {}'];
  const order = (file) => {
    const name = path.basename(file).toLowerCase();
    if (name === "variables.tf") return 1;
    if (name.includes("flow")) return 2;
    return 3;
  };
  for (const file of terraformFiles.sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const cleaned = stripTerraformAndProviderBlocks(await fs.readFile(file, "utf8"));
    if (cleaned) parts.push(`# Source: ${path.basename(file)}\n${cleaned}`);
  }
  const tfvarsPath = path.join(directory, "terraform.tfvars");
  const tfvars = await fs.readFile(tfvarsPath, "utf8").catch(() => "");
  const safeTfvars = tfvars
    .split(/\r?\n/)
    .filter((line) => !/(secret|password|token|credential|oauth|client[_-]?id|private[_-]?key|access[_-]?key)/i.test(line))
    .join("\n");
  if (safeTfvars.trim()) {
    const encoded = Buffer.from(safeTfvars, "utf8").toString("base64");
    parts.push(`# The runner restores non-secret variable values during import.\n# __GENESYS_TFVARS_BEGIN__\n# ${encoded}\n# __GENESYS_TFVARS_END__`);
  }
  await fs.writeFile(path.join(directory, "genesyscloud.tf"), `${parts.join("\n\n")}\n`);
  for (const file of terraformFiles) {
    if (path.basename(file).toLowerCase() !== "genesyscloud.tf") await fs.rm(file, { force: true });
  }
  await fs.rm(tfvarsPath, { force: true });
  return { mergedFiles: terraformFiles.map((file) => path.basename(file)), embeddedTfvars: Boolean(safeTfvars.trim()) };
}

function safeExtract(zipPath, destination) {
  const zip = new AdmZip(zipPath);
  validateZipEntries(zip.getEntries());
  zip.extractAllTo(destination, true);
}

async function listTerraformFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".tf")) files.push(fullPath);
    }
  }
  await walk(root);
  return files;
}

async function findTerraformModuleRoot(extractionRoot) {
  const terraformFiles = await listTerraformFiles(extractionRoot);
  if (!terraformFiles.length) throw new Error("Package does not contain Terraform .tf files.");
  const preferred = terraformFiles.find((file) => path.basename(file).toLowerCase() === "genesyscloud.tf");
  if (preferred) return path.dirname(preferred);
  const counts = new Map();
  for (const file of terraformFiles) counts.set(path.dirname(file), (counts.get(path.dirname(file)) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function normalizeTerraformText(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

async function removeDuplicateTerraformCopies(moduleDirectory) {
  const files = (await fs.readdir(moduleDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".tf"))
    .map((entry) => path.join(moduleDirectory, entry.name));
  const canonical = files.find((file) => path.basename(file).toLowerCase() === "genesyscloud.tf");
  if (!canonical) return [];
  const canonicalText = normalizeTerraformText(await fs.readFile(canonical, "utf8"));
  const removed = [];
  for (const file of files) {
    if (file === canonical) continue;
    const name = path.basename(file);
    const text = normalizeTerraformText(await fs.readFile(file, "utf8"));
    if (/^genesyscloud\s*-\s*copy(?:\s*\(\d+\))?\.tf$/i.test(name) || text === canonicalText) {
      await fs.rm(file, { force: true });
      removed.push(name);
    }
  }
  return removed;
}

async function restoreEmbeddedTfvars(root) {
  for (const file of await listTerraformFiles(root)) {
    const text = await fs.readFile(file, "utf8");
    const match = text.match(/# __GENESYS_TFVARS_BEGIN__\s*\r?\n# ([A-Za-z0-9+/=]+)\s*\r?\n# __GENESYS_TFVARS_END__/);
    if (match) {
      await fs.writeFile(path.join(root, "terraform.auto.tfvars"), Buffer.from(match[1], "base64").toString("utf8"));
      return true;
    }
  }
  return false;
}

async function prepareTargetModule(root, region) {
  const terraformFiles = await listTerraformFiles(root);
  if (!terraformFiles.length) throw new Error("Package does not contain Terraform .tf files.");
  for (const file of terraformFiles) {
    const original = await fs.readFile(file, "utf8");
    const normalizedSource = original.replace(
      new RegExp(String.raw`source\s*=\s*["'\`](?:hashicorp|mypurecloud)/genesyscloud["'\`]`, "ig"),
      'source = "MyPureCloud/genesyscloud"',
    );
    // Every imported file may already contain its own terraform and provider
    // blocks. Remove them before writing one canonical destination-specific
    // setup file; Terraform permits only one required_providers declaration.
    const withoutSetup = stripTerraformSetup(normalizedSource);
    await fs.writeFile(file, `${withoutSetup}\n`);
  }
  await fs.writeFile(path.join(root, "zz-promoter-provider.tf"), providerHeader(region));
  return { tfFileCount: terraformFiles.length };
}

function extractResourceBlocks(text, file) {
  const resources = [];
  const pattern = /resource\s+["'](genesyscloud_[^"']+)["']\s+["']([^"']+)["']\s*\{/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    let cursor = pattern.lastIndex;
    let depth = 1;
    let inString = false;
    let quoteCharacter = "";
    let escaped = false;
    for (; cursor < text.length && depth > 0; cursor += 1) {
      const character = text[cursor];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (character === "\\") { escaped = true; continue; }
        if (character === quoteCharacter) inString = false;
        continue;
      }
      if (character === '"' || character === "'") { inString = true; quoteCharacter = character; continue; }
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    const block = text.slice(start, cursor);
    const nameMatch = block.match(/\n\s*name\s*=\s*["']([^"']+)["']/);
    resources.push({
      type: match[1],
      label: match[2],
      address: `${match[1]}.${match[2]}`,
      displayName: nameMatch?.[1] || match[2],
      file,
    });
  }
  return resources;
}

async function inspectTerraformResources(moduleDirectory) {
  const resources = [];
  for (const file of await listTerraformFiles(moduleDirectory)) {
    resources.push(...extractResourceBlocks(await fs.readFile(file, "utf8"), path.relative(moduleDirectory, file)));
  }
  return resources.filter((resource) => resource.type !== "genesyscloud_tf_export");
}

function discoveryConfiguration(resourceType, resourceName, region) {
  if (!SAFE_RESOURCE_TYPE.test(resourceType)) throw new Error("Invalid resource type for destination discovery.");
  return `${providerHeader(region)}
data "${resourceType}" "destination_lookup" {
  name = ${quote(resourceName)}
}

output "match" {
  value = {
    id   = data.${resourceType}.destination_lookup.id
    name = try(data.${resourceType}.destination_lookup.name, ${quote(resourceName)})
  }
}
`;
}

async function discoverOneResource(resource, profile, parentDirectory) {
  const lookupDirectory = path.join(parentDirectory, safeName(resource.address));
  await fs.mkdir(lookupDirectory, { recursive: true });
  await fs.writeFile(path.join(lookupDirectory, "main.tf"), discoveryConfiguration(resource.type, resource.displayName, profile.region));
  const env = terraformEnvironment(profile);
  const lines = [];
  const onLine = (line) => lines.push(line);
  try {
    await run("terraform", ["init", "-input=false", "-no-color"], lookupDirectory, env, onLine);
    await run("terraform", ["apply", "-auto-approve", "-input=false", "-no-color"], lookupDirectory, env, onLine);
    const raw = await run("terraform", ["output", "-json", "match"], lookupDirectory, env, onLine);
    const match = JSON.parse(raw);
    return { ...resource, status: "exact", destinationId: match.id, destinationName: match.name, message: "One exact destination match was found." };
  } catch (error) {
    const message = String(error.message || error);
    const unsupported = /Invalid data source|does not support data source|not a valid data source|reference to undeclared resource/i.test(message);
    const missing = /not found|no .* found|failed to find|404/i.test(message);
    return {
      ...resource,
      status: unsupported ? "unsupported" : missing ? "missing" : "error",
      destinationId: "",
      destinationName: "",
      message: unsupported
        ? "Automatic lookup is not supported for this resource type. Enter the destination ID manually."
        : missing
          ? "No exact destination object was found."
          : message.slice(-2800),
    };
  } finally {
    await fs.rm(lookupDirectory, { recursive: true, force: true });
  }
}

async function hashFile(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function removeExpiredWorkspaces() {
  const now = Date.now();
  for (const [id, session] of sessions) if (now > session.expiresAt) sessions.delete(id);
  for (const [id, job] of jobs) {
    const updated = Date.parse(job.updatedAt || job.createdAt);
    if (Number.isFinite(updated) && now - updated > JOB_TTL_MS) {
      jobs.delete(id);
      if (job.rootDirectory) await fs.rm(job.rootDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
  for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["uploads", "plugin-cache"].includes(entry.name)) continue;
    const fullPath = path.join(ROOT, entry.name);
    const stats = await fs.stat(fullPath).catch(() => null);
    if (stats && now - stats.mtimeMs > JOB_TTL_MS && ![...jobs.values()].some((job) => job.rootDirectory === fullPath)) {
      await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

await removeExpiredWorkspaces();
const cleanupTimer = setInterval(() => removeExpiredWorkspaces().catch(() => {}), 15 * 60 * 1000);
cleanupTimer.unref();

app.get("/api/health", asyncRoute(async (_request, response) => {
  try {
    const version = await terraformVersion();
    response.json({ ok: true, terraform: version.split(/\r?\n/)[0] });
  } catch {
    response.status(503).json({ ok: false, error: "Terraform CLI was not found in PATH." });
  }
}));

app.get("/api/environments", asyncRoute(async (_request, response) => {
  response.json({ environments: await environmentStore.list(), regions: SUPPORTED_REGIONS });
}));

app.post("/api/environments", asyncRoute(async (request, response) => {
  let environment;
  try {
    environment = await environmentStore.upsert(request.body || {});
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  for (const [sessionId, session] of sessions) if (session.environmentId === environment.id) sessions.delete(sessionId);
  response.status(request.body?.id ? 200 : 201).json({ environment });
}));

app.delete("/api/environments/:id", asyncRoute(async (request, response) => {
  for (const job of jobs.values()) {
    if (job.environmentId === request.params.id && ["queued", "running", "applying"].includes(job.status)) {
      throw new HttpError(409, "This environment has an active Terraform job and cannot be removed yet.");
    }
  }
  if (!(await environmentStore.remove(request.params.id))) throw new HttpError(404, "Environment not found.");
  for (const [sessionId, session] of sessions) if (session.environmentId === request.params.id) sessions.delete(sessionId);
  response.status(204).end();
}));

app.post("/api/connections/test", asyncRoute(async (request, response) => {
  const environmentId = String(request.body?.environmentId || "").trim();
  const profile = await environmentStore.get(environmentId);
  if (!profile) throw new HttpError(404, "Select a configured environment.");
  const logs = [];
  try {
    const organization = await verifyEnvironment(profile, (line) => logs.push(line));
    const sessionId = makeId();
    const now = Date.now();
    sessions.set(sessionId, {
      environmentId: profile.id,
      profileUpdatedAt: profile.updatedAt,
      organizationId: organization.id,
      organizationName: organization.name,
      organizationDomain: organization.domain || "",
      region: profile.region,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    response.json({
      ok: true,
      sessionId,
      connection: {
        environmentId: profile.id,
        environmentName: profile.name,
        region: profile.region,
        organizationId: organization.id,
        organizationName: organization.name,
        organizationDomain: organization.domain || "",
        expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      },
      logs,
    });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message, logs });
  }
}));

app.delete("/api/sessions/current", requireSession, asyncRoute(async (request, response) => {
  const activeJob = [...jobs.values()].find((job) => job.sessionId === request.auth.sessionId && ["running", "applying"].includes(job.status));
  if (activeJob) throw new HttpError(409, "Wait for the active Terraform job to finish before disconnecting.");
  sessions.delete(request.auth.sessionId);
  response.status(204).end();
}));

app.post("/api/exports", requireSession, asyncRoute(async (request, response) => {
  validateExportRequest(request.body || {});
  const { session, sessionId, profile } = request.auth;
  const job = {
    id: makeId(),
    type: "export",
    status: "queued",
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId,
    environmentId: profile.id,
    target: { organizationId: session.organizationId, organizationName: session.organizationName, region: profile.region },
  };
  jobs.set(job.id, job);
  response.status(202).json({ jobId: job.id });
  const body = structuredClone(request.body);
  void (async () => {
    const directory = path.join(ROOT, job.id);
    const outputDirectory = path.join(directory, "exported-package");
    job.rootDirectory = directory;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "main.tf"), exportConfiguration(body, profile));
      setJob(job, { status: "running" });
      const env = terraformEnvironment(profile);
      await run("terraform", ["init", "-input=false", "-no-color"], directory, env, (line) => addLog(job, line));
      await run("terraform", ["apply", "-auto-approve", "-input=false", "-no-color"], directory, env, (line) => addLog(job, line));
      await fs.access(outputDirectory);
      const consolidated = await consolidateExport(outputDirectory);
      addLog(job, `[INFO] Consolidated ${consolidated.mergedFiles.length} Terraform files into genesyscloud.tf.`);
      const unresolved = await scanFiles(outputDirectory);
      const manifest = {
        formatVersion: 2,
        source: {
          environmentId: profile.id,
          environmentName: profile.name,
          organizationId: session.organizationId,
          organizationName: session.organizationName,
          region: profile.region,
        },
        createdAt: new Date().toISOString(),
        resourceTypes: body.resourceTypes,
        regex: body.regex || ".*",
        includeStateFile: false,
        dependencyResolution: body.dependencyResolution !== false,
        unresolvedGuidFiles: unresolved,
      };
      await fs.writeFile(path.join(outputDirectory, "promotion-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await fs.writeFile(path.join(outputDirectory, "unresolved-references.json"), `${JSON.stringify(unresolved, null, 2)}\n`);
      const zipPath = path.join(directory, `${safeName(profile.name)}-portable-export.zip`);
      await zipDirectory(outputDirectory, zipPath);
      setJob(job, { status: "complete", downloadPath: zipPath, manifest });
    } catch (error) {
      setJob(job, { status: "failed", error: error.message });
    }
  })();
}));

app.get("/api/jobs/:id", requireSession, (request, response, next) => {
  try { response.json(publicJob(getOwnedJob(request))); } catch (error) { next(error); }
});

app.get("/api/jobs/:id/download", requireSession, (request, response, next) => {
  try {
    const job = getOwnedJob(request);
    if (job.status !== "complete" || !job.downloadPath) throw new HttpError(404, "Package is not ready.");
    response.download(job.downloadPath, path.basename(job.downloadPath));
  } catch (error) { next(error); }
});

app.get("/api/jobs/:id/state", requireSession, (request, response, next) => {
  try {
    const job = getOwnedJob(request);
    if (job.status !== "applied" || !job.statePath) throw new HttpError(404, "Terraform state backup is not available.");
    response.download(job.statePath, `${safeName(job.target.organizationName)}-${job.id.slice(0, 8)}.tfstate`);
  } catch (error) { next(error); }
});

app.post("/api/imports/inspect", requireSession, upload.single("package"), asyncRoute(async (request, response) => {
  if (!request.file) throw new HttpError(400, "A ZIP package is required.");
  const extractionRoot = path.join(ROOT, `inspect-${makeId()}`);
  try {
    await fs.mkdir(extractionRoot, { recursive: true });
    safeExtract(request.file.path, extractionRoot);
    const moduleDirectory = await findTerraformModuleRoot(extractionRoot);
    const removedDuplicates = await removeDuplicateTerraformCopies(moduleDirectory);
    const security = await validateTerraformPackage(moduleDirectory);
    const resources = await inspectTerraformResources(moduleDirectory);
    response.json({ ok: true, moduleDirectory: path.relative(extractionRoot, moduleDirectory) || ".", removedDuplicates, resources, security });
  } catch (error) {
    throw new HttpError(400, error.message);
  } finally {
    await fs.rm(request.file.path, { force: true }).catch(() => {});
    await fs.rm(extractionRoot, { recursive: true, force: true }).catch(() => {});
  }
}));

app.post("/api/imports/discover", requireSession, asyncRoute(async (request, response) => {
  const resources = request.body?.resources;
  if (!Array.isArray(resources) || !resources.length || resources.length > 500) throw new HttpError(400, "Provide between 1 and 500 package resources.");
  for (const resource of resources) {
    if (!SAFE_RESOURCE_TYPE.test(String(resource.type || "")) || !String(resource.address || "").startsWith(`${resource.type}.`)) {
      throw new HttpError(400, "Destination discovery contains an invalid resource.");
    }
    if (!String(resource.displayName || "").trim() || String(resource.displayName).length > 300) throw new HttpError(400, "Resource display name is invalid.");
  }
  const discoveryRoot = path.join(ROOT, `discover-${makeId()}`);
  await fs.mkdir(discoveryRoot, { recursive: true });
  try {
    const results = [];
    for (const resource of resources) results.push(await discoverOneResource(resource, request.auth.profile, discoveryRoot));
    response.json({
      ok: true,
      results,
      summary: {
        exact: results.filter((item) => item.status === "exact").length,
        missing: results.filter((item) => item.status === "missing").length,
        unsupported: results.filter((item) => item.status === "unsupported").length,
        error: results.filter((item) => item.status === "error").length,
      },
    });
  } finally {
    await fs.rm(discoveryRoot, { recursive: true, force: true }).catch(() => {});
  }
}));

app.post("/api/imports/plan", requireSession, upload.single("package"), asyncRoute(async (request, response) => {
  let metadata;
  try { metadata = JSON.parse(request.body.metadata || "{}"); }
  catch { throw new HttpError(400, "Invalid import metadata."); }
  if (!request.file) throw new HttpError(400, "A ZIP package is required.");
  const mappings = Array.isArray(metadata.existingResourceMappings) ? metadata.existingResourceMappings : [];
  const { session, sessionId, profile } = request.auth;
  const job = {
    id: makeId(),
    type: "import-plan",
    status: "queued",
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId,
    environmentId: profile.id,
    target: { organizationId: session.organizationId, organizationName: session.organizationName, region: profile.region },
  };
  jobs.set(job.id, job);
  response.status(202).json({ jobId: job.id });
  void (async () => {
    const rootDirectory = path.join(ROOT, job.id);
    const extractionRoot = path.join(rootDirectory, "workspace");
    job.rootDirectory = rootDirectory;
    try {
      await fs.mkdir(extractionRoot, { recursive: true });
      const packageHash = await hashFile(request.file.path);
      safeExtract(request.file.path, extractionRoot);
      const moduleDirectory = await findTerraformModuleRoot(extractionRoot);
      const removedDuplicates = await removeDuplicateTerraformCopies(moduleDirectory);
      const security = await validateTerraformPackage(moduleDirectory);
      const resources = await inspectTerraformResources(moduleDirectory);
      const knownAddresses = new Set(resources.map((resource) => resource.address));
      for (const mapping of mappings) {
        if (!knownAddresses.has(mapping?.address)) throw new Error(`Unknown mapped resource address: ${mapping?.address || "(empty)"}`);
        if (!SAFE_IMPORT_ID.test(String(mapping.destinationId || ""))) throw new Error(`Invalid destination ID for ${mapping.address}.`);
      }
      const restoredTfvars = await restoreEmbeddedTfvars(moduleDirectory);
      const preparation = await prepareTargetModule(moduleDirectory, profile.region);
      const onLine = (line) => addLog(job, line);
      addLog(job, `[INFO] Verified ${security.resourceCount} Genesys Cloud resource(s) in ${security.fileCount} Terraform file(s).`);
      addLog(job, `[INFO] Terraform module directory: ${path.relative(extractionRoot, moduleDirectory) || "."}`);
      if (removedDuplicates.length) addLog(job, `[INFO] Removed duplicate Terraform copies: ${removedDuplicates.join(", ")}`);
      if (restoredTfvars) addLog(job, "[INFO] Restored embedded non-secret variable values for this job.");
      addLog(job, `[INFO] Prepared ${preparation.tfFileCount} Terraform files for ${session.organizationName}.`);
      setJob(job, { status: "running", packageHash });
      const env = terraformEnvironment(profile);
      await run("terraform", ["init", "-input=false", "-no-color"], moduleDirectory, env, onLine);
      await run("terraform", ["validate", "-no-color"], moduleDirectory, env, onLine);
      for (const mapping of mappings) {
        addLog(job, `[IMPORT] Binding ${mapping.address} to destination object ${mapping.destinationId}`);
        await run("terraform", ["import", "-input=false", "-no-color", mapping.address, mapping.destinationId], moduleDirectory, env, onLine);
      }
      if (mappings.length) addLog(job, `[INFO] Imported ${mappings.length} existing destination object(s) into isolated state.`);
      await run("terraform", ["plan", "-input=false", "-no-color", "-out=promotion.tfplan"], moduleDirectory, env, onLine);
      const planText = await run("terraform", ["show", "-no-color", "promotion.tfplan"], moduleDirectory, env, onLine);
      const planPath = path.join(moduleDirectory, "promotion.tfplan");
      const planHash = await hashFile(planPath);
      setJob(job, { status: "complete", plan: planText, planHash, planPath, workspace: moduleDirectory });
    } catch (error) {
      setJob(job, { status: "failed", error: error.message });
    } finally {
      await fs.rm(request.file.path, { force: true }).catch(() => {});
    }
  })();
}));

app.post("/api/imports/:id/apply", requireSession, asyncRoute(async (request, response) => {
  const job = getOwnedJob(request);
  if (job.type !== "import-plan" || job.status !== "complete") throw new HttpError(409, "A completed plan is required before apply.");
  if (request.body?.planHash !== job.planHash) throw new HttpError(409, "Plan checksum does not match.");
  if (request.body?.confirmOrganizationId !== job.target.organizationId) throw new HttpError(409, "Destination organization confirmation does not match the approved plan.");
  if (request.auth.session.organizationId !== job.target.organizationId || request.auth.profile.region !== job.target.region) {
    throw new HttpError(409, "The active environment does not match the destination used to create this plan.");
  }
  setJob(job, { status: "applying" });
  response.status(202).json({ jobId: job.id });
  const profile = request.auth.profile;
  void (async () => {
    try {
      const currentHash = await hashFile(job.planPath);
      if (currentHash !== job.planHash) throw new Error("Saved plan changed after approval.");
      addLog(job, "[VERIFY] Re-checking destination organization identity before apply.");
      const organization = await verifyEnvironment(profile, (line) => addLog(job, line));
      if (organization.id !== job.target.organizationId) throw new Error("Destination organization changed after the plan was created. Apply was blocked.");
      await run("terraform", ["apply", "-input=false", "-no-color", job.planPath], job.workspace, terraformEnvironment(profile), (line) => addLog(job, line));
      const statePath = path.join(job.workspace, "terraform.tfstate");
      const hasState = await fs.access(statePath).then(() => true).catch(() => false);
      setJob(job, { status: "applied", statePath: hasState ? statePath : null });
    } catch (error) {
      setJob(job, { status: "failed", error: error.message });
    }
  })();
}));

if (await fs.access(DIST_ROOT).then(() => true).catch(() => false)) {
  app.use(express.static(DIST_ROOT, { index: "index.html" }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
    response.sendFile(path.join(DIST_ROOT, "index.html"));
  });
}

app.use((error, _request, response, _next) => {
  if (_request.file?.path) void fs.rm(_request.file.path, { force: true }).catch(() => {});
  const status = error.status || (error instanceof multer.MulterError ? 400 : 500);
  const message = error.message || "Unexpected runner error.";
  if (status >= 500) console.error(redact(error.stack || message));
  response.status(status).json({ error: message });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Genesys promotion runner listening on http://127.0.0.1:${PORT}`);
});
