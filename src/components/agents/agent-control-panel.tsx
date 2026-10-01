'use client';

// ============================================================================
// PHASE 10A — AGENT CONTROL PANEL (dashboard layer of the control center)
// ============================================================================
// Client UI for the governed control layer. Every mutation goes through the
// admin-only control APIs (/api/agents/control*), which re-validate server-
// side — this UI can never widen permissions, disable safety, or fake state.
// Statuses shown here come from the real control/read model; nothing is
// fabricated as RUNNING/LIVE. The existing AgentControlCenter component above
// (roster, reviews, growth) remains untouched.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import {
  Bot, RefreshCw, PauseCircle, PlayCircle, Square, RotateCcw, Save, History,
  AlertTriangle, ShieldAlert, Undo2, OctagonX, ShieldCheck, CircleDot,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type RuntimeConfig = {
  mission: string;
  allowedTools: string[];
  allowedStages: string[];
  forbiddenActions: string[];
  budgetLimitUsd: number;
  timeoutMs: number;
  maxRetries: number;
  requiresApproval: boolean;
  stopConditions: string[];
  evidenceRequirement: string;
};

type AgentControlView = {
  agentId: string;
  role: string;
  isExecutable: boolean;
  executableDetail: string;
  control: {
    desiredState: string;
    derivedState: string;
    pendingRestart: boolean;
    stopReason: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
  };
  health: { state: string; reasons: string[] } | null;
  currentTask: { jobId: string | null; jobType: string; stage: string; correlationId: string; startedAt: string } | null;
  lastRun: { jobType: string; stage: string; status: string; startedAt: string; completedAt: string | null; failureReason: string | null; safetyVerdict: string | null } | null;
  modelProvider: string | null;
  budget: { limitUsd: number; consumedUsd: number | null; quality: string };
  permissions: string[];
  governance: { requiresApproval: boolean; approvalLocked: boolean; globalPaused: boolean };
  config: {
    activeVersion: number | null;
    lastConfigUpdateAt: string | null;
    lastConfigChangedBy: string | null;
    pendingRestart: boolean;
    drift: boolean;
    driftDetail: string | null;
  };
  effectiveConfig: RuntimeConfig;
  baseConfig: RuntimeConfig;
  lastControlAction: { action: string; result: string; at: string; by: string; configVersion: number | null; detail: string } | null;
};

type ControlPayload = {
  ok: boolean;
  view?: {
    generatedAt: string;
    globalControl: { paused: boolean; pauseReason: string | null; pausedBy: string | null; pausedAt: string | null };
    agents: AgentControlView[];
    externalExecution: { freebuff: { name: string; status: string; detail: string; requiredForConnected: string[] }; ruflo: { name: string; status: string; detail: string }; policy: string };
  };
  error?: string;
};

type ConfigVersion = {
  version: number;
  changedFields: string[];
  reason: string | null;
  changedBy: string;
  action: string;
  createdAt: string;
  active: boolean;
};

type HistoryPayload = { ok: boolean; versions?: ConfigVersion[]; activeVersion?: number | null; error?: string };

type ActionResponse = { ok: boolean; error?: string; detail?: string; newState?: string; correlationId?: string; resumedAgents?: string[]; skippedAgents?: { agentId: string; reason: string }[]; changedAgents?: string[] };

const DERIVED_TONE: Record<string, string> = {
  READY: 'bg-emerald-100 text-emerald-800',
  RUNNING: 'bg-blue-100 text-blue-800',
  PAUSED: 'bg-slate-200 text-slate-700',
  STOPPED: 'bg-zinc-200 text-zinc-700',
  RESTART_PENDING: 'bg-amber-100 text-amber-800',
  BLOCKED: 'bg-red-100 text-red-800',
  ERROR: 'bg-red-100 text-red-800',
  DEGRADED: 'bg-orange-100 text-orange-800',
};

export function AgentControlPanel() {
  const [view, setView] = useState<ControlPayload['view'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<RuntimeConfig | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, ConfigVersion[]>>({});
  const [confirmStopAll, setConfirmStopAll] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/agents/control');
      if (res.status === 401) {
        setError('Admin session required. Sign in at /login.');
        return;
      }
      const json = (await res.json()) as ControlPayload;
      if (json.ok && json.view) {
        setView(json.view);
      } else {
        setError(json.error ?? 'Control view unavailable.');
      }
    } catch {
      setError('The control center could not be reached.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // Initial load inside an async callback (not synchronously in the effect
    // body) — the same pattern the existing AgentControlCenter uses.
    void (async () => {
      await load();
    })();
  }, [load]);

  async function act(action: string, agentId?: string) {
    setBusy(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/agents/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(agentId ? { agentId } : {}) }),
      });
      const json = (await res.json()) as ActionResponse;
      if (json.ok) {
        if (action === 'STOP_ALL') {
          setActionMessage(`STOP ALL applied: ${json.changedAgents?.length ?? 0} newly paused, all new dispatch held.`);
          setConfirmStopAll(false);
        } else if (action === 'RESUME_ALL') {
          const skipped = json.skippedAgents?.length ?? 0;
          setActionMessage(`RESUME ALL: ${json.resumedAgents?.length ?? 0} resumed, ${skipped} skipped by governance.`);
        } else {
          setActionMessage(`${action} ${agentId}: ${json.detail ?? json.newState ?? 'applied'}.`);
        }
        await load();
      } else {
        setActionMessage(json.error ?? `Action refused (${res.status}).`);
      }
    } catch {
      setActionMessage('The control endpoint could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  function openEditor(agent: AgentControlView) {
    setSelected(agent.agentId);
    setEditing({ ...agent.effectiveConfig });
    setConfigMessage(null);
    setActionMessage(null);
  }

  async function loadHistory(agentId: string) {
    setSelected(agentId);
    setConfigMessage(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/configuration`);
      const json = (await res.json()) as HistoryPayload;
      if (json.ok && json.versions) {
        setHistory((prev) => ({ ...prev, [agentId]: json.versions ?? [] }));
        if (json.versions.length === 0) setConfigMessage('No runtime configuration versions saved — the static contract is active.');
      } else {
        setConfigMessage(json.error ?? 'History unavailable.');
      }
    } catch {
      setConfigMessage('History could not be loaded.');
    }
  }

  async function saveConfig(agentId: string, restart: boolean) {
    if (!editing) return;
    setBusy(true);
    setConfigMessage(null);
    try {
      const res = await fetch(
        restart ? `/api/agents/${agentId}/configuration/save-restart` : `/api/agents/${agentId}/configuration`,
        {
          method: restart ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: editing, reason: restart ? 'SAVE & RESTART from the Agent Control Center' : 'edited in the Agent Control Center' }),
        },
      );
      const json = (await res.json()) as { ok: boolean; version?: number; changedFields?: string[]; errors?: string[]; error?: string; stage?: string };
      if (json.ok) {
        setConfigMessage(`Saved configuration v${json.version}${restart ? ' and restarted through the governed path' : ''} (changed: ${json.changedFields?.join(', ') || 'none'}).`);
        setEditing(null);
        await load();
      } else {
        setConfigMessage(json.errors?.join('; ') || json.error || `Refused (${res.status}).`);
      }
    } catch {
      setConfigMessage('The configuration endpoint could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  async function rollback(agentId: string, toVersion: number) {
    setBusy(true);
    setConfigMessage(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/configuration/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toVersion }),
      });
      const json = (await res.json()) as { ok: boolean; newVersion?: number; error?: string };
      if (json.ok) {
        setConfigMessage(`Rollback complete: v${json.newVersion} created as a restored copy of v${toVersion}. Restart the agent to apply.`);
        await load();
        await loadHistory(agentId);
      } else {
        setConfigMessage(json.error ?? `Rollback refused (${res.status}).`);
      }
    } catch {
      setConfigMessage('The rollback endpoint could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  const globalControl = view?.globalControl;
  const agents = view?.agents ?? [];

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {/* Global + emergency control */}
      <div className="rounded-xl border bg-card p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <OctagonX className={cn('h-5 w-5', globalControl?.paused ? 'text-red-600' : 'text-muted-foreground')} />
          <div>
            <h2 className="text-sm font-semibold">Runtime control</h2>
            <p className="text-xs text-muted-foreground">
              {globalControl
                ? globalControl.paused
                  ? `Agency globally PAUSED — ${globalControl.pauseReason ?? 'no reason recorded'}${globalControl.pausedBy ? ` (by ${globalControl.pausedBy})` : ''}`
                  : 'Agency running — supervised dispatch allowed; per-agent control below.'
                : 'Loading…'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => act('RESUME_ALL')}
            disabled={busy || !view}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
          >
            <PlayCircle className="h-3.5 w-3.5" /> Resume all
          </button>
          {confirmStopAll ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-xs font-medium text-red-700">Stop ALL agents? No new work will begin.</span>
              <button
                onClick={() => act('STOP_ALL')}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
              >
                <OctagonX className="h-3.5 w-3.5" /> Confirm STOP ALL
              </button>
              <button onClick={() => setConfirmStopAll(false)} disabled={busy} className="rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
                Cancel
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmStopAll(true)}
              disabled={busy || !view}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              <OctagonX className="h-3.5 w-3.5" /> Stop all agents
            </button>
          )}
          <button onClick={load} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {actionMessage && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">{actionMessage}</div>
      )}

      {/* Freebuff / Ruflo seams — truthful, never fabricated */}
      {view && (
        <div className="rounded-xl border bg-card p-4 shadow-sm space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-slate-500" />
            <h2 className="text-sm font-semibold">External execution providers</h2>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <p className="font-semibold">{view.externalExecution.freebuff.name}: <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold">{view.externalExecution.freebuff.status}</span></p>
              <p className="mt-1 text-muted-foreground leading-snug">{view.externalExecution.freebuff.detail}</p>
              <ul className="mt-1.5 list-disc pl-4 text-[11px] text-muted-foreground">
                {view.externalExecution.freebuff.requiredForConnected.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
            <div className="rounded-lg border p-3">
              <p className="font-semibold">{view.externalExecution.ruflo.name}: <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold">{view.externalExecution.ruflo.status}</span></p>
              <p className="mt-1 text-muted-foreground leading-snug">{view.externalExecution.ruflo.detail}</p>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug">{view.externalExecution.policy}</p>
        </div>
      )}

      {/* Per-agent control cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        {agents.map((agent) => {
          const isSelected = selected === agent.agentId;
          const versions = history[agent.agentId] ?? [];
          return (
            <div key={agent.agentId} className={cn('rounded-xl border bg-card p-5 shadow-sm space-y-3', isSelected && 'ring-1 ring-indigo-300')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Bot className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold truncate">{agent.role}</h3>
                    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide', DERIVED_TONE[agent.control.derivedState] ?? 'bg-slate-100 text-slate-600')}>
                      {agent.control.derivedState}
                    </span>
                    {agent.control.desiredState !== agent.control.derivedState && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">desired: {agent.control.desiredState}</span>
                    )}
                    {agent.governance.approvalLocked && (
                      <span className="inline-flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-800"><ShieldAlert className="h-3 w-3" /> SAFETY-LOCKED</span>
                    )}
                    {agent.config.drift && (
                      <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800"><AlertTriangle className="h-3 w-3" /> CONFIG DRIFT</span>
                    )}
                    {agent.control.pendingRestart && !agent.config.drift && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">restart pending</span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{agent.executableDetail}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                <div><span className="text-muted-foreground">Health:</span> <span className="font-semibold">{agent.health?.state ?? 'UNKNOWN'}</span></div>
                <div><span className="text-muted-foreground">Stage:</span> <span className="font-semibold">{agent.currentTask ? agent.currentTask.stage : agent.lastRun?.stage ?? '—'}</span></div>
                <div><span className="text-muted-foreground">Budget:</span> <span className="font-semibold">{agent.budget.quality === 'REAL' ? `$${(agent.budget.consumedUsd ?? 0).toFixed(2)} / $${agent.budget.limitUsd.toFixed(2)}` : `cap $${agent.budget.limitUsd.toFixed(2)}`}</span></div>
                <div><span className="text-muted-foreground">Config:</span> <span className="font-semibold">{agent.config.activeVersion ? `v${agent.config.activeVersion}` : 'contract'}</span></div>
                <div className="col-span-2"><span className="text-muted-foreground">Current task:</span> <span className="font-semibold">{agent.currentTask ? `${agent.currentTask.jobType} (${agent.currentTask.correlationId.slice(0, 18)}…)` : 'none'}</span></div>
                <div className="col-span-2"><span className="text-muted-foreground">Last run:</span> <span className="font-semibold">{agent.lastRun ? `${agent.lastRun.status} · ${new Date(agent.lastRun.startedAt).toLocaleString()}` : 'never ran'}</span></div>
                <div className="col-span-2 sm:col-span-4"><span className="text-muted-foreground">Model/provider:</span> <span className="font-semibold">{agent.modelProvider ?? 'UNKNOWN — no recorded AI usage'}</span></div>
                <div className="col-span-2 sm:col-span-4"><span className="text-muted-foreground">Tools ({agent.permissions.length}):</span> <span className="text-muted-foreground">{agent.permissions.join(', ')}</span></div>
                <div className="col-span-2 sm:col-span-4"><span className="text-muted-foreground">Last control action:</span> <span className="font-semibold">{agent.lastControlAction ? `${agent.lastControlAction.action} (${agent.lastControlAction.result}) · ${new Date(agent.lastControlAction.at).toLocaleString()} · by ${agent.lastControlAction.by}` : 'none recorded'}</span></div>
              </div>

              {agent.control.stopReason && (
                <p className="rounded bg-slate-50 px-2.5 py-1.5 text-[11px] text-muted-foreground">Reason: {agent.control.stopReason}</p>
              )}

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-1.5 border-t pt-2.5">
                <button onClick={() => act('PAUSE', agent.agentId)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"><PauseCircle className="h-3 w-3" /> Pause</button>
                <button onClick={() => act('RESUME', agent.agentId)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"><PlayCircle className="h-3 w-3" /> Resume</button>
                <button onClick={() => act('STOP', agent.agentId)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"><Square className="h-3 w-3" /> Stop</button>
                <button onClick={() => act('RESTART', agent.agentId)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"><RotateCcw className="h-3 w-3" /> Restart</button>
                <button onClick={() => openEditor(agent)} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"><Save className="h-3 w-3" /> Modify</button>
                <button onClick={() => loadHistory(agent.agentId)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"><History className="h-3 w-3" /> Configuration history</button>
              </div>

              {/* Configuration editor */}
              {isSelected && editing && (
                <div className="space-y-2.5 rounded-lg border bg-slate-50/60 p-3">
                  <h4 className="text-xs font-semibold">Runtime configuration editor (safe fields only)</h4>
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">Mission</label>
                    <textarea
                      value={editing.mission}
                      onChange={(e) => setEditing({ ...editing, mission: e.target.value })}
                      maxLength={600}
                      rows={2}
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-xs"
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground">Budget cap (USD) — max ${agent.baseConfig.budgetLimitUsd}</label>
                      <input type="number" min={0} max={agent.baseConfig.budgetLimitUsd} step="0.01" value={editing.budgetLimitUsd}
                        onChange={(e) => setEditing({ ...editing, budgetLimitUsd: Number(e.target.value) })}
                        className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-xs" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground">Timeout (ms) — max {agent.baseConfig.timeoutMs}</label>
                      <input type="number" min={1000} max={agent.baseConfig.timeoutMs} step={1000} value={editing.timeoutMs}
                        onChange={(e) => setEditing({ ...editing, timeoutMs: Number(e.target.value) })}
                        className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-xs" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground">Max retries — max {agent.baseConfig.maxRetries}</label>
                      <input type="number" min={0} max={agent.baseConfig.maxRetries} value={editing.maxRetries}
                        onChange={(e) => setEditing({ ...editing, maxRetries: Number(e.target.value) })}
                        className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-xs" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">Allowed tools (base contract: {agent.baseConfig.allowedTools.join(', ')})</label>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {agent.baseConfig.allowedTools.map((tool) => {
                        const active = editing.allowedTools.includes(tool);
                        return (
                          <button key={tool} type="button"
                            onClick={() => setEditing({ ...editing, allowedTools: active ? editing.allowedTools.filter((t) => t !== tool) : [...editing.allowedTools, tool] })}
                            className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium border', active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-background text-muted-foreground hover:bg-muted')}>
                            {tool}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">Allowed stages (base contract: {agent.baseConfig.allowedStages.join(', ')})</label>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {agent.baseConfig.allowedStages.map((stage) => {
                        const active = editing.allowedStages.includes(stage);
                        return (
                          <button key={stage} type="button"
                            onClick={() => setEditing({ ...editing, allowedStages: active ? editing.allowedStages.filter((s) => s !== stage) : [...editing.allowedStages, stage] })}
                            className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium border', active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-background text-muted-foreground hover:bg-muted')}>
                            {stage}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] font-medium text-muted-foreground">Requires approval</label>
                    <input type="checkbox" checked={editing.requiresApproval} disabled={agent.governance.approvalLocked}
                      onChange={(e) => setEditing({ ...editing, requiresApproval: e.target.checked })}
                      className="h-3.5 w-3.5" />
                    {agent.governance.approvalLocked && <span className="text-[10px] font-medium text-violet-700">locked — governance agent keeps approval forever</span>}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Evidence policy <span className="font-semibold">{editing.evidenceRequirement}</span> is part of the safety contract and cannot be changed here. Core safety (halal, fraud, spam, payment, SSRF, destructive-op gates) can never be disabled via configuration.
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button onClick={() => saveConfig(agent.agentId, false)} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"><Save className="h-3 w-3" /> Save</button>
                    <button onClick={() => saveConfig(agent.agentId, true)} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"><RotateCcw className="h-3 w-3" /> Save &amp; restart</button>
                    <button onClick={() => { setEditing(null); setConfigMessage(null); }} disabled={busy} className="rounded-md border px-2.5 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50">Cancel</button>
                  </div>
                  {configMessage && <p className="text-[11px] text-slate-700">{configMessage}</p>}
                </div>
              )}

              {/* Configuration history + rollback */}
              {isSelected && !editing && versions.length > 0 && (
                <div className="space-y-1.5 rounded-lg border p-3">
                  <h4 className="text-xs font-semibold">Configuration history (immutable; rollback creates a new version)</h4>
                  <div className="divide-y">
                    {versions.map((v) => (
                      <div key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[11px]">
                        <div className="min-w-0">
                          <p className="font-semibold">
                            v{v.version}
                            {v.active && <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold text-emerald-800">ACTIVE</span>}
                            <span className="ml-1.5 text-muted-foreground">{v.action.toLowerCase()} · {new Date(v.createdAt).toLocaleString()} · by {v.changedBy}</span>
                          </p>
                          <p className="text-muted-foreground truncate">
                            {v.changedFields.length > 0 ? `changed: ${v.changedFields.join(', ')}` : 'no field changes'}{v.reason ? ` · ${v.reason}` : ''}
                          </p>
                        </div>
                        {!v.active && (
                          <button onClick={() => rollback(agent.agentId, v.version)} disabled={busy}
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium hover:bg-muted disabled:opacity-50">
                            <Undo2 className="h-3 w-3" /> Rollback
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {configMessage && <p className="text-[11px] text-slate-700">{configMessage}</p>}
                </div>
              )}

              {isSelected && !editing && versions.length === 0 && configMessage && (
                <p className="text-[11px] text-muted-foreground">{configMessage}</p>
              )}
            </div>
          );
        })}
      </div>

      {agents.length === 0 && !error && (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          {busy ? 'Loading control state…' : 'No agents available.'}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2.5">
        <CircleDot className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-[11px] text-muted-foreground leading-snug">
          PAUSED: existing work may finish under existing safe semantics; no new work begins. STOPPED: new execution is
          blocked through the Job Runner dispatch gate; no process is killed and no JobRun/AgentRun record is touched.
          RESTART: safe stop/pause → validated configuration reload → governed execution path only. Every action is
          audited; failed restarts surface truthful ERROR states.
        </p>
      </div>
    </div>
  );
}
