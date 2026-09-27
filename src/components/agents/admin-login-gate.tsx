import Link from 'next/link';
import { Lock, LogIn } from 'lucide-react';

/**
 * Server-rendered gate shown when the /agents page is opened without an
 * admin session. It never pretends to show agent state — it directs the
 * administrator to sign in.
 */
export function AdminLoginGate() {
  return (
    <div className="p-6 lg:p-8 max-w-xl mx-auto mt-16">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-600/20">
          <Lock className="h-6 w-6 text-indigo-400" />
        </div>
        <h1 className="text-lg font-bold text-white">Agent Control Center</h1>
        <p className="text-sm text-slate-400 leading-relaxed">
          This console is restricted to the single administrator. Sign in to view
          real agent runtime status, the human review queue, and agency controls.
        </p>
        <Link
          href="/login?returnTo=%2Fagents"
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
        >
          <LogIn className="h-4 w-4" />
          Sign in
        </Link>
        <p className="text-[10px] text-slate-500">
          Sessions are audited and expire automatically. No public registration exists.
        </p>
      </div>
    </div>
  );
}
