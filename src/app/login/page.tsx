'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TrendingUp, Lock, AlertTriangle } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotConfigured(false);
    try {
      const res = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          returnTo: searchParams.get('returnTo') ?? '/',
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string; returnTo?: string };
      if (json.ok) {
        const target = json.returnTo && json.returnTo.startsWith('/') ? json.returnTo : '/';
        router.replace(target);
        router.refresh();
        return;
      }
      if (res.status === 503) setNotConfigured(true);
      setError(json.error ?? 'Sign-in failed.');
    } catch {
      setError('Sign-in failed: the server could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600">
            <TrendingUp className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">AI Income Lab</h1>
            <p className="text-xs text-slate-400">Administrator sign-in</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4 shadow-xl"
        >
          <div className="flex items-center gap-2 text-slate-300 text-sm">
            <Lock className="h-4 w-4 text-indigo-400" />
            <span>Single-admin console. No public registration exists.</span>
          </div>

          <div>
            <label htmlFor="email" className="block text-xs font-medium text-slate-400 mb-1">
              Admin email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              placeholder="admin@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-slate-400 mb-1">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              placeholder="••••••••••••"
            />
          </div>

          {error && (
            <div className="rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {notConfigured && (
            <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              Admin access is NOT_CONFIGURED. Set <code className="text-amber-200">ADMIN_EMAIL</code> and{' '}
              <code className="text-amber-200">ADMIN_PASSWORD_HASH</code> in the server environment, then reload.
              Generate the hash with <code className="text-amber-200">node scripts/hash-admin-password.mjs --generate</code>.
            </div>
          )}

          <button
            type="submit"
            disabled={busy || email.length === 0 || password.length === 0}
            className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="text-[10px] text-slate-500 text-center leading-relaxed">
            Single-admin login: no signup, no password reset. The administrator
            identity is configured server-side (ADMIN_EMAIL + ADMIN_PASSWORD_HASH).
            Sessions expire automatically; all attempts are audited.
          </p>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
