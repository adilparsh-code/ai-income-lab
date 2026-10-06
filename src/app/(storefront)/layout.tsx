// ============================================================================
// (storefront) ROUTE GROUP — PUBLIC ACQUISITION SURFACE CHROME
// ============================================================================
// Unauthenticated by design: this is the customer-facing landing/listing
// surface. It renders NO admin navigation and never receives admin data —
// offers are filtered fail-closed by src/lib/storefront/eligibility.ts
// before they appear here. Operator sign-in stays one click away via /login.
// ============================================================================

import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldCheck, Lock } from 'lucide-react';

export const metadata: Metadata = {
  title: {
    default: 'AI Income Lab Store — Halal-cleared digital offers',
    template: '%s — AI Income Lab Store',
  },
  description:
    'Public storefront of AI Income Lab: halal-screened digital products and services with upfront pricing and operator-verified payment.',
};

export default function StorefrontLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/store" className="flex items-center gap-2.5 group">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 ring-1 ring-emerald-500/40 group-hover:ring-emerald-400 transition-colors">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
            </span>
            <span>
              <span className="block text-sm font-bold text-white leading-none">AI Income Lab Store</span>
              <span className="block text-[10px] text-slate-400 leading-none mt-1">Halal-cleared products &amp; services</span>
            </span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-4 text-sm">
            <Link href="/store#catalog" className="hidden sm:inline text-slate-300 hover:text-white transition-colors">
              Catalog
            </Link>
            <Link href="/store#how" className="hidden sm:inline text-slate-300 hover:text-white transition-colors">
              How it works
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-900 transition-colors"
            >
              <Lock className="h-3.5 w-3.5" />
              Operator
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-slate-800 bg-slate-950">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 grid gap-8 sm:grid-cols-3 text-sm">
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold text-white">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              AI Income Lab Store
            </div>
            <p className="text-slate-400 leading-relaxed">
              Every offer is screened for prohibited categories before it is shown here, activated only by the
              operator, and fulfilled personally.
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-semibold text-white">Explore</p>
            <ul className="space-y-1.5 text-slate-400">
              <li><Link href="/store#catalog" className="hover:text-white transition-colors">Catalog</Link></li>
              <li><Link href="/store#how" className="hover:text-white transition-colors">How it works</Link></li>
              <li><Link href="/login" className="hover:text-white transition-colors">Operator login</Link></li>
            </ul>
          </div>
          <div className="space-y-2">
            <p className="font-semibold text-white">Trust &amp; payment</p>
            <p className="text-slate-400 leading-relaxed">
              Automated halal screening is a filter, not a religious authority. Payments are confirmed and verified
              by the operator before any sale is recorded — a message or screenshot is never treated as payment
              proof.
            </p>
          </div>
        </div>
        <div className="border-t border-slate-900 py-4 text-center text-[11px] text-slate-500">
          © {new Date().getFullYear()} AI Income Lab — legitimate, halal online income.
        </div>
      </footer>
    </div>
  );
}
