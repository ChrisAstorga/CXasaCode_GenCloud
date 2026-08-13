import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

export const SUPPORTED_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
];

const EMPTY_STORE = { version: 1, environments: [] };
const ENVIRONMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

function clean(value) {
  return String(value ?? "").trim();
}

function createId(name) {
  const slug = clean(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 38);
  return `${slug || "environment"}-${crypto.randomBytes(3).toString("hex")}`;
}

function clientIdHint(clientId) {
  const value = clean(clientId);
  if (!value) return "Not configured";
  if (value.length <= 8) return `${value.slice(0, 2)}••••${value.slice(-2)}`;
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}

function publicEnvironment(environment) {
  return {
    id: environment.id,
    name: environment.name,
    region: environment.region,
    clientIdHint: clientIdHint(environment.clientId),
    configured: Boolean(environment.clientId && environment.clientSecret),
    updatedAt: environment.updatedAt || null,
  };
}

export class EnvironmentStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      return;
    }
    await this.read();
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.environments)) {
        throw new Error("Environment vault has an unsupported format.");
      }
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY_STORE);
      if (error instanceof SyntaxError) {
        throw new Error(`Environment vault contains invalid JSON: ${error.message}`);
      }
      throw error;
    }
  }

  async list() {
    const data = await this.read();
    return data.environments
      .map(publicEnvironment)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id) {
    const data = await this.read();
    const environment = data.environments.find((item) => item.id === id);
    return environment ? structuredClone(environment) : null;
  }

  async upsert(input) {
    return this.enqueueWrite(async () => {
      const data = await this.read();
      const requestedId = clean(input.id);
      const existingIndex = requestedId
        ? data.environments.findIndex((item) => item.id === requestedId)
        : -1;
      const existing = existingIndex >= 0 ? data.environments[existingIndex] : null;
      const id = requestedId || createId(input.name);
      const name = clean(input.name || existing?.name);
      const region = clean(input.region || existing?.region);
      const clientId = clean(input.clientId) || existing?.clientId || "";
      const clientSecret = clean(input.clientSecret) || existing?.clientSecret || "";

      if (!ENVIRONMENT_ID_PATTERN.test(id)) {
        throw new Error("Environment ID must contain 3-50 lowercase letters, numbers, or hyphens.");
      }
      if (!name || name.length > 80) throw new Error("Environment name is required and must be 80 characters or fewer.");
      if (!SUPPORTED_REGIONS.includes(region)) throw new Error("Select a supported Genesys Cloud region.");
      if (!clientId || clientId.length > 256) throw new Error("OAuth client ID is required.");
      if (!clientSecret || clientSecret.length > 512) throw new Error("OAuth client secret is required.");
      if (!existing && data.environments.some((item) => item.id === id)) throw new Error("Environment ID already exists.");

      const environment = {
        id,
        name,
        region,
        clientId,
        clientSecret,
        updatedAt: new Date().toISOString(),
      };
      if (existingIndex >= 0) data.environments[existingIndex] = environment;
      else data.environments.push(environment);
      await this.write(data);
      return publicEnvironment(environment);
    });
  }

  async remove(id) {
    return this.enqueueWrite(async () => {
      const data = await this.read();
      const next = data.environments.filter((item) => item.id !== id);
      if (next.length === data.environments.length) return false;
      data.environments = next;
      await this.write(data);
      return true;
    });
  }

  enqueueWrite(operation) {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async write(data) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
    await fs.chmod(this.filePath, 0o600).catch(() => {});
  }
}

export function resolveEnvironmentFile(projectRoot) {
  const configuredPath = clean(process.env.GENESYS_ENVIRONMENTS_FILE);
  return configuredPath
    ? path.resolve(projectRoot, configuredPath)
    : path.join(projectRoot, "config", "environments.local.json");
}
