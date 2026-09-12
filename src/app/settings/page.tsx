import { PageHeader } from '@/components/shared/page-header';
import { Settings, Key, Database, Palette, Bell } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Settings"
        description="Configure your AI Income Lab environment."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-muted p-2">
              <Key className="h-4 w-4 text-muted-foreground" />
            </div>
            <h3 className="text-sm font-semibold">API Keys</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Configure AI provider API keys and external service credentials.
            Keys are stored as environment variables and never exposed in frontend code.
          </p>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">PLANNED</span>
        </div>

        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-muted p-2">
              <Database className="h-4 w-4 text-muted-foreground" />
            </div>
            <h3 className="text-sm font-semibold">Database</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Current database: SQLite (local development).
            Ready to switch to PostgreSQL or Supabase for production.
          </p>
          <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">LIVE</span>
        </div>

        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-muted p-2">
              <Palette className="h-4 w-4 text-muted-foreground" />
            </div>
            <h3 className="text-sm font-semibold">Appearance</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Theme preferences, display settings, and UI customization.
          </p>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">PLANNED</span>
        </div>

        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-muted p-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
            </div>
            <h3 className="text-sm font-semibold">Notifications</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Configure alerts for experiment results, revenue milestones, and agent actions.
          </p>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">PLANNED</span>
        </div>
      </div>

      {/* Environment Info */}
      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold mb-3">Environment</h3>
        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono text-xs">1.0.0 (Phase 1)</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Database</span>
            <span className="font-mono text-xs">SQLite (Local)</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">AI Provider</span>
            <span className="font-mono text-xs">Not configured</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Framework</span>
            <span className="font-mono text-xs">Next.js 15 (App Router)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
