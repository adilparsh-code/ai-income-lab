'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Lightbulb,
  Package,
  FlaskConical,
  DollarSign,
  Bot,
  Workflow,
  Factory,
  Settings,
  Menu,
  X,
  ShoppingBag,
  TrendingUp,
  Gauge,
  CircleDollarSign,
  Activity,
  Satellite,
} from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';

/**
 * Revokes the admin session via the existing logout endpoint
 * (DELETE /api/admin/session), clears the cookie server-side, and returns
 * to the login page. Always lands on /login even when the request fails.
 */
function SignOutButton() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/admin/session', { method: 'DELETE' });
    } catch {
      // Fall through: navigation to /login still ends the console session UX.
    }
    router.replace('/login');
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={signingOut}
      className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50 transition-colors"
    >
      <LogOut className="h-3.5 w-3.5" />
      {signingOut ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

const navItems = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Pipeline', href: '/pipeline', icon: Workflow },
  { label: 'Income Engine', href: '/income-engine', icon: CircleDollarSign },
  { label: 'Operations', href: '/operations', icon: Activity },
  { label: 'Observatory', href: '/observatory', icon: Satellite },
  { label: 'Agent Control', href: '/agents', icon: Bot },
  { label: 'Product Factory', href: '/product-factory', icon: Factory },
  { label: 'Opportunities', href: '/opportunities', icon: Lightbulb },
  { label: 'Products', href: '/products', icon: Package },
  { label: 'Storefront', href: '/storefront', icon: ShoppingBag },
  { label: 'Experiments', href: '/experiments', icon: FlaskConical },
  { label: 'Revenue', href: '/revenue', icon: DollarSign },
  { label: 'AI Usage & Cost', href: '/ai-usage', icon: Gauge },
  { label: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile menu button */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-4 left-4 z-50 lg:hidden rounded-md bg-slate-900 p-2 text-white shadow-lg"
        aria-label="Toggle navigation"
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-slate-900 transition-transform duration-200 ease-in-out lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Logo / Brand */}
        <div className="flex h-16 items-center gap-2 px-6 border-b border-slate-800">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
            <TrendingUp className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white">AI Income Lab</h1>
            <p className="text-[10px] text-slate-400 -mt-0.5">Halal Business Discovery</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-1">
            {navItems.map((item) => {
              const isActive = item.href === '/'
                ? pathname === '/'
                : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-indigo-600/20 text-indigo-400'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    )}
                  >
                    <item.icon className={cn('h-4 w-4', isActive ? 'text-indigo-400' : 'text-slate-400')} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-800 px-4 py-3">
          <p className="text-[10px] text-slate-500 text-center mb-2">
            AI Income Lab — Halal Business Discovery
          </p>
          <SignOutButton />
        </div>
      </aside>
    </>
  );
}
