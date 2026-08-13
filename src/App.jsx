import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  CloudCog,
  DatabaseBackup,
  Download,
  FileArchive,
  FileCheck2,
  FileUp,
  FolderKey,
  GitMerge,
  KeyRound,
  Layers3,
  Loader2,
  LockKeyhole,
  LogOut,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ALL_RESOURCE_TYPES, CATALOG, DEFAULT_REGIONS } from "./catalog.js";
import { apiRequest, downloadAuthenticatedFile } from "./api.js";

const TERMINAL_STATUSES = new Set(["complete", "failed", "applied"]);
const EMPTY_ACTION = { mode: "create", destinationId: "" };

function planSummary(plan) {
  const match = String(plan || "").match(/Plan:\s*(\d+) to add,\s*(\d+) to change,\s*(\d+) to destroy/i);
  if (!match) return null;
  return { add: Number(match[1]), change: Number(match[2]), destroy: Number(match[3]) };
}

function App() {
  const [tab, setTab] = useState("connect");
  const [health, setHealth] = useState(null);
  const [environments, setEnvironments] = useState([]);
  const [regions, setRegions] = useState(DEFAULT_REGIONS);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState("");
  const [environmentEditor, setEnvironmentEditor] = useState(null);
  const [connection, setConnection] = useState(null);
  const [sessionId, setSessionId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [toast, setToast] = useState(null);
  const [selected, setSelected] = useState(["genesyscloud_flow"]);
  const [regex, setRegex] = useState(".*");
  const [exportMode, setExportMode] = useState("dependencies");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState({ Architect: true });
  const [exportJob, setExportJob] = useState(null);
  const [packageFile, setPackageFile] = useState(null);
  const [packageResources, setPackageResources] = useState([]);
  const [packageSecurity, setPackageSecurity] = useState(null);
  const [resourceActions, setResourceActions] = useState({});
  const [discoveryResults, setDiscoveryResults] = useState({});
  const [inspecting, setInspecting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [importJob, setImportJob] = useState(null);
  const [plan, setPlan] = useState("");
  const [applyDialog, setApplyDialog] = useState(false);
  const pollRef = useRef(null);

  const selectedEnvironment = environments.find((item) => item.id === selectedEnvironmentId);
  const activeJob = [exportJob, importJob].find((job) => ["queued", "running", "applying"].includes(job?.status));
  const summary = useMemo(() => planSummary(plan), [plan]);
  const visibleCatalog = useMemo(
    () => Object.entries(CATALOG)
      .map(([name, items]) => [name, items.filter((item) => item.toLowerCase().includes(search.toLowerCase()))])
      .filter(([, items]) => items.length),
    [search],
  );

  useEffect(() => {
    void loadInitialData();
    return () => clearInterval(pollRef.current);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!activeJob) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "A Terraform job is still running.";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [activeJob]);

  async function loadInitialData() {
    const [healthResult, environmentResult] = await Promise.allSettled([
      apiRequest("/api/health"),
      apiRequest("/api/environments"),
    ]);
    setHealth(healthResult.status === "fulfilled" ? healthResult.value : { ok: false, error: healthResult.reason.message });
    if (environmentResult.status === "fulfilled") {
      const next = environmentResult.value.environments || [];
      setEnvironments(next);
      setRegions(environmentResult.value.regions || DEFAULT_REGIONS);
      setSelectedEnvironmentId((current) => current || next[0]?.id || "");
    } else {
      notify("error", "Could not load environments", environmentResult.reason.message);
    }
  }

  function notify(type, title, message) {
    setToast({ type, title, message });
  }

  async function authenticatedRequest(path, options = {}) {
    try {
      return await apiRequest(path, options, sessionId);
    } catch (error) {
      if (error.status === 401) {
        clearConnectionState();
        setTab("connect");
        notify("error", "Session ended", error.message);
      }
      throw error;
    }
  }

  function clearWorkflowState() {
    clearInterval(pollRef.current);
    setExportJob(null);
    setPackageFile(null);
    setPackageResources([]);
    setPackageSecurity(null);
    setResourceActions({});
    setDiscoveryResults({});
    setImportJob(null);
    setPlan("");
    setApplyDialog(false);
  }

  function clearConnectionState() {
    setConnection(null);
    setSessionId("");
    clearWorkflowState();
  }

  function invalidatePlan() {
    setImportJob((current) => current?.type === "import-plan" ? null : current);
    setPlan("");
    setApplyDialog(false);
  }

  async function saveEnvironment(values) {
    const data = await apiRequest("/api/environments", { method: "POST", body: JSON.stringify(values) });
    const result = await apiRequest("/api/environments");
    setEnvironments(result.environments || []);
    setRegions(result.regions || DEFAULT_REGIONS);
    setSelectedEnvironmentId(data.environment.id);
    setEnvironmentEditor(null);
    notify("success", values.id ? "Environment updated" : "Environment saved", "Credentials are stored only by the local runner and will be reused for future actions.");
  }

  async function deleteEnvironment(environment) {
    if (!window.confirm(`Remove ${environment.name} from this machine?`)) return;
    try {
      await apiRequest(`/api/environments/${encodeURIComponent(environment.id)}`, { method: "DELETE" });
      const remaining = environments.filter((item) => item.id !== environment.id);
      setEnvironments(remaining);
      setSelectedEnvironmentId((current) => current === environment.id ? remaining[0]?.id || "" : current);
      notify("success", "Environment removed", `${environment.name} and its saved credentials were removed.`);
    } catch (error) {
      notify("error", "Could not remove environment", error.message);
    }
  }

  async function connect() {
    if (!selectedEnvironment?.configured) {
      notify("error", "Environment is not ready", "Add a client ID and secret before connecting.");
      return;
    }
    setConnecting(true);
    notify("info", "Verifying organization", `Authenticating ${selectedEnvironment.name} and reading its organization identity.`);
    try {
      const data = await apiRequest("/api/connections/test", {
        method: "POST",
        body: JSON.stringify({ environmentId: selectedEnvironment.id }),
      });
      clearWorkflowState();
      setSessionId(data.sessionId);
      setConnection(data.connection);
      setTab("export");
      notify("success", "Secure session ready", `Connected to ${data.connection.organizationName}. Credentials will be reused by the local runner.`);
    } catch (error) {
      notify("error", "Connection failed", error.message);
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    if (activeJob) {
      notify("error", "Terraform is still working", "Wait for the active job to finish before disconnecting.");
      return;
    }
    try {
      if (sessionId) await apiRequest("/api/sessions/current", { method: "DELETE" }, sessionId);
    } catch (error) {
      if (error.status !== 401) {
        notify("error", "Could not disconnect", error.message);
        return;
      }
    }
    clearConnectionState();
    setTab("connect");
  }

  function watchJob(jobId, setter, onComplete) {
    clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const job = await authenticatedRequest(`/api/jobs/${jobId}`);
        setter(job);
        if (TERMINAL_STATUSES.has(job.status)) {
          clearInterval(pollRef.current);
          onComplete?.(job);
        }
      } catch (error) {
        clearInterval(pollRef.current);
        if (error.status !== 401) notify("error", "Job monitoring stopped", error.message);
      }
    };
    void poll();
    pollRef.current = setInterval(poll, 1200);
  }

  async function exportNow() {
    if (!connection) return setTab("connect");
    if (!selected.length) return notify("error", "Nothing selected", "Select at least one resource type.");
    try {
      const excludes = selected.includes("genesyscloud_user") || exportMode === "dependencies"
        ? ["genesyscloud_user.skills"]
        : [];
      const data = await authenticatedRequest("/api/exports", {
        method: "POST",
        body: JSON.stringify({
          resourceTypes: selected,
          regex,
          dependencyResolution: exportMode === "dependencies",
          splitFiles: true,
          excludeResources: [],
          excludeAttributes: excludes,
        }),
      });
      const queued = { id: data.jobId, type: "export", status: "queued", logs: [] };
      setExportJob(queued);
      notify("info", "Export started", `Building a portable package from ${connection.organizationName}.`);
      watchJob(data.jobId, setExportJob, (job) => {
        notify(job.status === "complete" ? "success" : "error", job.status === "complete" ? "Package ready" : "Export failed", job.status === "complete" ? "Your Terraform package is ready to download." : job.error);
      });
    } catch (error) {
      notify("error", "Export could not start", error.message);
    }
  }

  async function downloadExport() {
    try {
      await downloadAuthenticatedFile(`/api/jobs/${exportJob.id}/download`, sessionId, `${connection.environmentName}-portable-export.zip`);
    } catch (error) {
      notify("error", "Download failed", error.message);
    }
  }

  async function inspectPackage(file) {
    if (!file) return;
    setPackageFile(file);
    setPackageResources([]);
    setPackageSecurity(null);
    setResourceActions({});
    setDiscoveryResults({});
    invalidatePlan();
    setInspecting(true);
    const form = new FormData();
    form.append("package", file);
    try {
      const data = await authenticatedRequest("/api/imports/inspect", { method: "POST", body: form });
      setPackageResources(data.resources || []);
      setPackageSecurity(data.security || null);
      setResourceActions(Object.fromEntries((data.resources || []).map((resource) => [resource.address, { ...EMPTY_ACTION }])));
      notify("success", "Package verified", `Found ${(data.resources || []).length} managed Genesys Cloud resource(s).`);
    } catch (error) {
      setPackageFile(null);
      notify("error", "Package rejected", error.message);
    } finally {
      setInspecting(false);
    }
  }

  function updateResourceAction(address, patch) {
    setResourceActions((current) => ({
      ...current,
      [address]: { ...(current[address] || EMPTY_ACTION), ...patch },
    }));
    invalidatePlan();
  }

  async function discoverDestinationMatches() {
    if (!connection || !packageResources.length) return;
    setDiscovering(true);
    try {
      const data = await authenticatedRequest("/api/imports/discover", {
        method: "POST",
        body: JSON.stringify({ resources: packageResources }),
      });
      setDiscoveryResults(Object.fromEntries((data.results || []).map((result) => [result.address, result])));
      notify("success", "Discovery complete", `${data.summary?.exact || 0} exact match(es), ${data.summary?.missing || 0} not found, ${data.summary?.unsupported || 0} manual review.`);
    } catch (error) {
      notify("error", "Discovery failed", error.message);
    } finally {
      setDiscovering(false);
    }
  }

  function useAllExactMatches() {
    setResourceActions((current) => {
      const next = { ...current };
      for (const resource of packageResources) {
        const result = discoveryResults[resource.address];
        if (result?.status === "exact") next[resource.address] = { mode: "update", destinationId: result.destinationId };
      }
      return next;
    });
    invalidatePlan();
    notify("success", "Matches selected", "Every exact destination match is marked Update existing.");
  }

  function setAllCreate() {
    setResourceActions(Object.fromEntries(packageResources.map((resource) => [resource.address, { ...EMPTY_ACTION }])));
    invalidatePlan();
  }

  function downloadMappingCsv() {
    const rows = [
      ["resource_address", "resource_type", "object_name", "action", "destination_id"],
      ...packageResources.map((resource) => {
        const action = resourceActions[resource.address] || EMPTY_ACTION;
        return [resource.address, resource.type, resource.displayName, action.mode, action.destinationId];
      }),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value || "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "destination-reconciliation.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function uploadMappingCsv(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result).split(/\r?\n/).filter(Boolean);
      const next = { ...resourceActions };
      for (const line of lines.slice(1)) {
        const values = [];
        let current = "";
        let quoted = false;
        for (let index = 0; index < line.length; index += 1) {
          const character = line[index];
          if (character === '"' && line[index + 1] === '"') { current += '"'; index += 1; continue; }
          if (character === '"') { quoted = !quoted; continue; }
          if (character === "," && !quoted) { values.push(current); current = ""; }
          else current += character;
        }
        values.push(current);
        const [address, , , action, destinationId] = values;
        if (next[address]) next[address] = { mode: action === "update" ? "update" : "create", destinationId: destinationId || "" };
      }
      setResourceActions(next);
      invalidatePlan();
      notify("success", "Mapping imported", "Reconciliation actions and destination IDs were loaded from the CSV.");
    };
    reader.readAsText(file);
  }

  async function planImport() {
    if (!connection || !packageFile) return notify("error", "Package required", "Connect to a destination and select a verified ZIP package.");
    const existingResourceMappings = packageResources
      .filter((resource) => resourceActions[resource.address]?.mode === "update")
      .map((resource) => ({ address: resource.address, destinationId: (resourceActions[resource.address]?.destinationId || "").trim() }));
    const missing = existingResourceMappings.find((mapping) => !mapping.destinationId);
    if (missing) return notify("error", "Destination ID required", `Enter an existing destination ID for ${missing.address}.`);
    const form = new FormData();
    form.append("package", packageFile);
    form.append("metadata", JSON.stringify({ existingResourceMappings }));
    try {
      const data = await authenticatedRequest("/api/imports/plan", { method: "POST", body: form });
      const queued = { id: data.jobId, type: "import-plan", status: "queued", logs: [] };
      setImportJob(queued);
      setPlan("");
      notify("info", "Plan started", `Calculating changes for ${connection.organizationName}.`);
      watchJob(data.jobId, setImportJob, (job) => {
        setPlan(job.plan || "");
        notify(job.status === "complete" ? "success" : "error", job.status === "complete" ? "Plan ready for review" : "Plan failed", job.status === "complete" ? "Review the complete plan before approving any changes." : job.error);
      });
    } catch (error) {
      notify("error", "Plan could not start", error.message);
    }
  }

  async function applyPlan() {
    try {
      const data = await authenticatedRequest(`/api/imports/${importJob.id}/apply`, {
        method: "POST",
        body: JSON.stringify({ planHash: importJob.planHash, confirmOrganizationId: connection.organizationId }),
      });
      setApplyDialog(false);
      setImportJob((current) => ({ ...current, status: "applying" }));
      notify("info", "Applying approved plan", `The destination identity will be rechecked before changes reach ${connection.organizationName}.`);
      watchJob(data.jobId, setImportJob, (job) => {
        notify(job.status === "applied" ? "success" : "error", job.status === "applied" ? "Promotion completed" : "Apply failed", job.status === "applied" ? `Changes were applied to ${connection.organizationName}. Download the state backup for safekeeping.` : job.error);
      });
    } catch (error) {
      notify("error", "Apply was blocked", error.message);
    }
  }

  async function downloadState() {
    try {
      await downloadAuthenticatedFile(`/api/jobs/${importJob.id}/state`, sessionId, `${connection.environmentName}-terraform.tfstate`);
    } catch (error) {
      notify("error", "State download failed", error.message);
    }
  }

  function selectTab(nextTab) {
    if (nextTab !== "connect" && !connection) {
      notify("info", "Connect first", "Choose a configured environment to open the promotion workspace.");
      setTab("connect");
      return;
    }
    setTab(nextTab);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => selectTab("connect")} aria-label="Open connection workspace">
          <span className="brand-mark"><CloudCog /></span>
          <span><strong>CloudShift</strong><small>Genesys configuration promoter</small></span>
        </button>
        <nav className="topnav" aria-label="Promotion workflow">
          {[
            ["connect", FolderKey, "Environment"],
            ["export", Download, "Export"],
            ["import", Upload, "Import"],
          ].map(([value, Icon, label], index) => (
            <button key={value} className={tab === value ? "active" : ""} onClick={() => selectTab(value)}>
              <span>{index + 1}</span><Icon />{label}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          {connection ? (
            <>
              <div className="connection-pill"><span className="live-dot" /><div><small>CONNECTED</small><strong>{connection.organizationName}</strong></div></div>
              <button className="icon-button" onClick={disconnect} disabled={Boolean(activeJob)} title="Disconnect"><LogOut /></button>
            </>
          ) : <span className="offline-pill">No active session</span>}
        </div>
      </header>

      <main className="workspace">
        <section className="workspace-heading">
          <div>
            <span className="eyebrow"><ShieldCheck /> CONTROLLED TERRAFORM WORKSPACE</span>
            <h1>{tab === "connect" ? "Choose where you want to work." : tab === "export" ? "Build a portable configuration package." : "Promote with a plan—not a guess."}</h1>
            <p>{tab === "connect" ? "Save OAuth credentials once on this machine, then connect from a trusted environment profile." : tab === "export" ? "Select the Genesys Cloud objects you need and package them with traceable source metadata." : "Verify the package, reconcile destination objects, and apply only the plan you reviewed."}</p>
          </div>
          <div className={`runner-status ${health?.ok ? "ready" : "blocked"}`}>
            {health?.ok ? <CheckCircle2 /> : <AlertTriangle />}
            <div><small>LOCAL RUNNER</small><strong>{health ? health.ok ? "Ready" : "Needs attention" : "Checking…"}</strong><span>{health?.ok ? health.terraform : health?.error || "Connecting"}</span></div>
          </div>
        </section>

        {connection && tab !== "connect" && (
          <section className="context-bar">
            <div><BadgeCheck /><span><small>Verified organization</small><strong>{connection.organizationName}</strong></span></div>
            <div><span><small>Environment</small><strong>{connection.environmentName}</strong></span></div>
            <div><span><small>Region</small><strong>{connection.region}</strong></span></div>
            <div className="org-id"><span><small>Organization ID</small><code>{connection.organizationId}</code></span></div>
          </section>
        )}

        {tab === "connect" && (
          <ConnectWorkspace
            environments={environments}
            selectedId={selectedEnvironmentId}
            onSelect={setSelectedEnvironmentId}
            selectedEnvironment={selectedEnvironment}
            connection={connection}
            connecting={connecting}
            onConnect={connect}
            onDisconnect={disconnect}
            onCreate={() => setEnvironmentEditor({})}
            onEdit={(environment) => setEnvironmentEditor(environment)}
            onDelete={deleteEnvironment}
          />
        )}

        {tab === "export" && (
          <div className="split-layout">
            <section className="panel main-panel">
              <PanelHeading icon={Layers3} kicker="PACKAGE BUILDER" title="Choose configuration" detail={`${selected.length} of ${ALL_RESOURCE_TYPES.length} resource types selected`} />
              <div className="form-grid">
                <label><span>Export mode</span><select value={exportMode} onChange={(event) => setExportMode(event.target.value)}><option value="dependencies">Selected resources + dependencies</option><option value="exact">Selected resources only</option></select></label>
                <label><span>Object name regex</span><input value={regex} onChange={(event) => setRegex(event.target.value)} placeholder=".*" /></label>
              </div>
              <div className={`advisory ${exportMode === "dependencies" ? "positive" : "warning"}`}>
                {exportMode === "dependencies" ? <CheckCircle2 /> : <AlertTriangle />}
                <span>{exportMode === "dependencies" ? "Referenced queues, scripts, prompts, integrations, and schedules can be included automatically." : "Dependencies are excluded. Referenced objects must already exist in the destination."}</span>
              </div>
              <div className="catalog-toolbar">
                <div className="searchbox"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a Terraform resource" /></div>
                <button onClick={() => setSelected(ALL_RESOURCE_TYPES)}>Select all</button>
                <button onClick={() => setSelected([])}>Clear</button>
              </div>
              <div className="resource-catalog">
                {visibleCatalog.map(([category, items]) => (
                  <div className="catalog-group" key={category}>
                    <button className="catalog-heading" onClick={() => setExpanded((current) => ({ ...current, [category]: !current[category] }))}>
                      {expanded[category] ? <ChevronDown /> : <ChevronRight />}<strong>{category}</strong><span>{items.filter((item) => selected.includes(item)).length}/{items.length}</span>
                    </button>
                    {expanded[category] && <div className="catalog-items">
                      <div className="catalog-actions"><button onClick={() => setSelected((current) => [...new Set([...current, ...items])])}>Select group</button><button onClick={() => setSelected((current) => current.filter((item) => !items.includes(item)))}>Clear group</button></div>
                      {items.map((type) => <label className="resource-option" key={type}><input type="checkbox" checked={selected.includes(type)} onChange={() => setSelected((current) => current.includes(type) ? current.filter((item) => item !== type) : [...current, type])} /><span className="checkmark"><Check /></span><code>{type}</code></label>)}
                    </div>}
                  </div>
                ))}
              </div>
              <button className="primary-action" onClick={exportNow} disabled={Boolean(activeJob) || !selected.length}><Boxes />{exportJob && ["queued", "running"].includes(exportJob.status) ? "Building package…" : "Create export package"}<ArrowRight /></button>
            </section>
            <aside className="side-stack">
              <JobPanel title="Export activity" job={exportJob} empty="Your Terraform export logs will appear here." />
              {exportJob?.status === "complete" && <section className="panel completion-card"><div className="success-orb"><FileArchive /></div><h3>Package ready</h3><p>Source identity and unresolved GUID reports are included in the ZIP.</p><button className="secondary-action" onClick={downloadExport}><Download />Download ZIP</button></section>}
            </aside>
          </div>
        )}

        {tab === "import" && (
          <div className="split-layout import-layout">
            <section className="panel main-panel">
              <PanelHeading icon={GitMerge} kicker="DESTINATION RECONCILIATION" title="Inspect and match package" detail="Only Genesys Cloud Terraform packages are accepted" />
              <label className={`dropzone ${packageFile ? "has-file" : ""}`}>
                <input type="file" accept=".zip,application/zip" onChange={(event) => inspectPackage(event.target.files?.[0])} />
                {inspecting ? <Loader2 className="spin" /> : packageFile ? <FileCheck2 /> : <FileUp />}
                <strong>{inspecting ? "Verifying package…" : packageFile ? packageFile.name : "Choose a portable export ZIP"}</strong>
                <span>{packageFile ? `${packageResources.length} managed resource(s) detected` : "The runner checks paths, file types, providers, modules, and provisioners before planning."}</span>
              </label>
              {packageSecurity && <div className="verification-strip"><ShieldCheck /><strong>Safety checks passed</strong><span>{packageSecurity.resourceCount} resources · {packageSecurity.fileCount} Terraform files</span></div>}

              {packageResources.length > 0 && <>
                <div className="reconcile-toolbar">
                  <div><strong>Destination decisions</strong><span>{Object.values(resourceActions).filter((action) => action.mode === "update").length} update · {Object.values(resourceActions).filter((action) => action.mode === "create").length} create</span></div>
                  <div className="toolbar-buttons">
                    <button onClick={discoverDestinationMatches} disabled={discovering}>{discovering ? <Loader2 className="spin" /> : <Search />}Discover matches</button>
                    <button onClick={useAllExactMatches} disabled={!Object.values(discoveryResults).some((result) => result.status === "exact")}><CheckCircle2 />Use exact</button>
                    <button onClick={setAllCreate}><CirclePlus />All create</button>
                    <button onClick={downloadMappingCsv}><Download />CSV</button>
                    <label className="button-label"><Upload />Import CSV<input hidden type="file" accept=".csv,text/csv" onChange={(event) => uploadMappingCsv(event.target.files?.[0])} /></label>
                  </div>
                </div>
                <div className="resource-list">
                  {packageResources.map((resource) => {
                    const action = resourceActions[resource.address] || EMPTY_ACTION;
                    const discovery = discoveryResults[resource.address];
                    return <article className={`resource-row ${action.mode}`} key={resource.address}>
                      <div className="resource-copy"><small>{resource.type}</small><strong>{resource.displayName}</strong><code>{resource.address}</code></div>
                      {discovery && <div className={`match-badge ${discovery.status}`}><span>{discovery.status === "exact" ? "Exact match" : discovery.status === "missing" ? "Not found" : "Manual review"}</span>{discovery.destinationId && <code>{discovery.destinationId}</code>}<small>{discovery.message}</small></div>}
                      <div className="segmented-control"><button className={action.mode === "create" ? "active" : ""} onClick={() => updateResourceAction(resource.address, { mode: "create", destinationId: "" })}><CirclePlus />Create</button><button className={action.mode === "update" ? "active" : ""} onClick={() => updateResourceAction(resource.address, { mode: "update", destinationId: discovery?.destinationId || action.destinationId })}><RefreshCw />Update</button></div>
                      {action.mode === "update" && <label className="destination-field"><span>Destination object ID</span><input value={action.destinationId} onChange={(event) => updateResourceAction(resource.address, { destinationId: event.target.value })} placeholder="Existing Genesys Cloud object ID" /></label>}
                    </article>;
                  })}
                </div>
              </>}
              <button className="primary-action" onClick={planImport} disabled={!packageResources.length || Boolean(activeJob)}><RefreshCw />{importJob && ["queued", "running"].includes(importJob.status) ? "Calculating plan…" : "Validate and preview plan"}<ArrowRight /></button>
            </section>
            <aside className="side-stack sticky-stack">
              <section className="panel plan-panel">
                <PanelHeading icon={FileCheck2} kicker="APPROVAL GATE" title="Terraform plan" detail={importJob?.status ? `Status: ${importJob.status}` : "No plan generated"} />
                {summary && <div className="plan-summary"><div><strong>{summary.add}</strong><span>add</span></div><div><strong>{summary.change}</strong><span>change</span></div><div className={summary.destroy ? "danger" : ""}><strong>{summary.destroy}</strong><span>destroy</span></div></div>}
                {importJob?.status === "applied" && <div className="apply-success"><CheckCircle2 /><div><strong>Promotion completed</strong><span>The approved plan was applied to {connection.organizationName}.</span></div></div>}
                {importJob?.status === "failed" && <div className="apply-error"><AlertTriangle /><div><strong>Terraform stopped</strong><span>{importJob.error}</span></div></div>}
                <pre className="plan-output">{plan || importJob?.logs?.join("\n") || "The complete Terraform plan and runner output will appear here."}</pre>
                {importJob?.planHash && importJob.status === "complete" && <button className="danger-action" onClick={() => setApplyDialog(true)}><Play />Review and apply approved plan</button>}
                {importJob?.status === "applying" && <button className="danger-action" disabled><Loader2 className="spin" />Applying changes…</button>}
                {importJob?.status === "applied" && importJob.stateDownloadAvailable && <button className="secondary-action" onClick={downloadState}><DatabaseBackup />Download state backup</button>}
              </section>
            </aside>
          </div>
        )}
      </main>

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
      {environmentEditor && <EnvironmentEditor environment={environmentEditor} regions={regions} onCancel={() => setEnvironmentEditor(null)} onSave={saveEnvironment} />}
      {applyDialog && <ApplyDialog connection={connection} summary={summary} onCancel={() => setApplyDialog(false)} onConfirm={applyPlan} />}
    </div>
  );
}

function ConnectWorkspace({ environments, selectedId, onSelect, selectedEnvironment, connection, connecting, onConnect, onDisconnect, onCreate, onEdit, onDelete }) {
  return <div className="connect-grid">
    <section className="panel connect-card">
      <PanelHeading icon={KeyRound} kicker="SECURE SESSION" title="Connect an environment" detail="Credentials stay on the local runner" />
      {environments.length ? <>
        <label className="large-select"><span>Environment profile</span><select value={selectedId} onChange={(event) => onSelect(event.target.value)} disabled={Boolean(connection)}>{environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name} · {environment.region}</option>)}</select></label>
        {selectedEnvironment && <div className="environment-preview"><div className="environment-icon"><ServerCog /></div><div><small>SELECTED PROFILE</small><strong>{selectedEnvironment.name}</strong><span>{selectedEnvironment.region} · OAuth {selectedEnvironment.clientIdHint}</span></div><span className={selectedEnvironment.configured ? "ready-badge" : "needs-badge"}>{selectedEnvironment.configured ? "Ready" : "Needs credentials"}</span></div>}
        <div className="security-note"><LockKeyhole /><div><strong>No repeated credential prompts</strong><span>After connection, export, discovery, plan, and apply use this verified session. Secrets never enter browser storage.</span></div></div>
        {connection ? <button className="secondary-action" onClick={onDisconnect}><LogOut />Disconnect from {connection.organizationName}</button> : <button className="primary-action" onClick={onConnect} disabled={connecting || !selectedEnvironment?.configured}>{connecting ? <Loader2 className="spin" /> : <ShieldCheck />}{connecting ? "Verifying organization…" : "Verify and connect"}<ArrowRight /></button>}
      </> : <div className="empty-state"><FolderKey /><h3>No environments configured</h3><p>Add your first Genesys Cloud environment. You will enter its OAuth credentials only once.</p><button className="primary-action compact" onClick={onCreate}><Plus />Add environment</button></div>}
    </section>
    <section className="panel environments-card">
      <div className="panel-title-row"><div><span className="panel-kicker">LOCAL CREDENTIAL VAULT</span><h2>Saved environments</h2></div><button className="add-button" onClick={onCreate} disabled={Boolean(connection)}><Plus />Add environment</button></div>
      <p className="panel-intro">Profiles are stored in a Git-ignored file on this machine. The interface receives only masked client information.</p>
      <div className="environment-list">
        {environments.map((environment) => <article className={environment.id === selectedId ? "selected" : ""} key={environment.id} onClick={() => !connection && onSelect(environment.id)}>
          <div className="environment-icon small"><CloudCog /></div><div className="environment-details"><strong>{environment.name}</strong><span>{environment.region}</span><code>{environment.clientIdHint}</code></div><span className={environment.configured ? "status-dot ready" : "status-dot"} title={environment.configured ? "Configured" : "Missing credentials"} />
          <div className="row-actions"><button onClick={(event) => { event.stopPropagation(); onEdit(environment); }} disabled={Boolean(connection)} title="Edit environment"><Pencil /></button><button className="delete" onClick={(event) => { event.stopPropagation(); onDelete(environment); }} disabled={Boolean(connection)} title="Remove environment"><Trash2 /></button></div>
        </article>)}
      </div>
      <div className="vault-footer"><ShieldCheck /><span><strong>Backend-only secret storage</strong><small>Never commit environments.local.json to GitHub.</small></span></div>
    </section>
  </div>;
}

function EnvironmentEditor({ environment, regions, onCancel, onSave }) {
  const editing = Boolean(environment.id);
  const [values, setValues] = useState({ id: environment.id || "", name: environment.name || "", region: environment.region || regions[0] || "us-east-1", clientId: "", clientSecret: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try { await onSave(values); } catch (submitError) { setError(submitError.message); setSaving(false); }
  }
  return <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="environment-title">
    <button className="modal-close" onClick={onCancel} aria-label="Close"><X /></button>
    <div className="modal-icon"><FolderKey /></div><span className="panel-kicker">LOCAL ENVIRONMENT</span><h2 id="environment-title">{editing ? `Update ${environment.name}` : "Add a Genesys environment"}</h2><p>Credentials are written to the local vault with restricted file permissions and are never returned by the API.</p>
    <form onSubmit={submit} className="modal-form">
      <label><span>Environment name</span><input required maxLength="80" value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} placeholder="Non Production" /></label>
      <label><span>Genesys Cloud region</span><select value={values.region} onChange={(event) => setValues({ ...values, region: event.target.value })}>{regions.map((region) => <option key={region}>{region}</option>)}</select></label>
      <label><span>OAuth client ID {editing && <small>Leave blank to keep current</small>}</span><input required={!editing} value={values.clientId} onChange={(event) => setValues({ ...values, clientId: event.target.value })} autoComplete="off" /></label>
      <label><span>OAuth client secret {editing && <small>Leave blank to keep current</small>}</span><input required={!editing} type="password" value={values.clientSecret} onChange={(event) => setValues({ ...values, clientSecret: event.target.value })} autoComplete="new-password" /></label>
      {error && <div className="form-error"><AlertTriangle />{error}</div>}
      <div className="modal-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-action compact" disabled={saving}>{saving ? <Loader2 className="spin" /> : <LockKeyhole />}{saving ? "Saving…" : "Save securely"}</button></div>
    </form>
  </div></div>;
}

function ApplyDialog({ connection, summary, onCancel, onConfirm }) {
  const [confirmation, setConfirmation] = useState("");
  const matches = confirmation.trim() === connection.organizationName;
  return <div className="modal-backdrop" role="presentation"><div className="modal danger-modal" role="dialog" aria-modal="true" aria-labelledby="apply-title">
    <button className="modal-close" onClick={onCancel} aria-label="Close"><X /></button><div className="modal-icon danger"><AlertTriangle /></div><span className="panel-kicker">FINAL APPROVAL</span><h2 id="apply-title">Apply changes to {connection.organizationName}?</h2>
    <p>The runner will verify the organization again, compare the saved plan checksum, and apply only the plan currently shown.</p>
    {summary && <div className="plan-summary large"><div><strong>{summary.add}</strong><span>add</span></div><div><strong>{summary.change}</strong><span>change</span></div><div className={summary.destroy ? "danger" : ""}><strong>{summary.destroy}</strong><span>destroy</span></div></div>}
    <label className="confirmation-field"><span>Type <strong>{connection.organizationName}</strong> to confirm</span><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
    <div className="target-lock"><LockKeyhole /><span><small>LOCKED DESTINATION</small><code>{connection.organizationId}</code></span></div>
    <div className="modal-actions"><button onClick={onCancel}>Cancel</button><button className="danger-action compact" disabled={!matches} onClick={onConfirm}><Play />Apply approved plan</button></div>
  </div></div>;
}

function PanelHeading({ icon: Icon, kicker, title, detail }) {
  return <div className="panel-heading"><div className="heading-icon"><Icon /></div><div><span className="panel-kicker">{kicker}</span><h2>{title}</h2><p>{detail}</p></div></div>;
}

function JobPanel({ title, job, empty }) {
  return <section className="panel job-panel"><div className="job-heading"><div><span className="panel-kicker">RUNNER OUTPUT</span><h3>{title}</h3></div><StatusBadge status={job?.status} /></div><pre>{job?.logs?.join("\n") || empty}</pre>{job?.error && <div className="inline-error"><AlertTriangle />{job.error}</div>}</section>;
}

function StatusBadge({ status }) {
  if (!status) return <span className="job-status idle">Idle</span>;
  const busy = ["queued", "running", "applying"].includes(status);
  return <span className={`job-status ${status}`}>{busy && <Loader2 className="spin" />}{status}</span>;
}

function Toast({ toast, onClose }) {
  const Icon = toast.type === "success" ? CheckCircle2 : toast.type === "error" ? AlertTriangle : Activity;
  return <div className={`toast ${toast.type}`} role="status"><Icon className={toast.type === "info" ? "pulse" : ""} /><div><strong>{toast.title}</strong><span>{toast.message}</span></div><button onClick={onClose} aria-label="Close notification"><X /></button></div>;
}

export default App;
