// ============================================================================
// /store — PUBLIC LANDING + CATALOG (the acquisition surface).
// ============================================================================
// The first customer-facing page on origin/main's predecessor had none: the
// root route is the admin console, so this route group opens the outer ring
// of the income loop (DISCOVERY → OFFER). Server component over real DB state
// (force-dynamic); every offer has already passed the fail-closed eligibility
// gate in src/lib/storefront/eligibility.ts.
// ============================================================================

import Link from 'next/link';
import {
  ArrowRight,
  BadgeCheck,
  ClipboardCheck,
  Handshake,
  ReceiptText,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { listPublicOffers, type StoreOffer } from '@/lib/storefront/store';
import { offerTypeLabel } from '@/lib/storefront/labels';
import { formatCurrency } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Store',
  description:
    'Halal-cleared digital products and services from AI Income Lab — screened offers, upfront prices, operator-verified payment.',
};

const HOW_IT_WORKS = [
  {
    icon: Sparkles,
    step: '1 · Discover',
    title: 'Pick a screened offer',
    body: 'Every listing is ACTIVE in our pipeline, halal-screened, and priced openly. Nothing unreviewed is ever shown here.',
  },
  {
    icon: ClipboardCheck,
    step: '2 · Request',
    title: 'Send a purchase request',
    body: 'Tell us what you want to buy. Your request is recorded as an inbound lead — your word is never treated as payment.',
  },
  {
    icon: Handshake,
    step: '3 · Pay',
    title: 'Get confirmed instructions',
    body: 'We contact you with payment details — an external checkout or a manual invoice. No charges happen on this site.',
  },
  {
    icon: ReceiptText,
    step: '4 · Receive',
    title: 'Delivery, then receipt',
    body: 'Payment is verified by the operator first, then delivery is fulfilled and the sale is recorded in the revenue ledger.',
  },
];

function OfferCard({ offer }: { offer: StoreOffer }) {
  return (
    <Link
      href={`/store/${offer.id}`}
      className="group flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5 hover:border-indigo-500/60 hover:bg-slate-900 transition-all"
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-0.5 text-[11px] font-medium text-slate-300">
          {offerTypeLabel(offer.type)}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800/70 bg-emerald-950/60 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400">
          <BadgeCheck className="h-3 w-3" />
          Halal screened
        </span>
      </div>
      <h3 className="text-base font-semibold text-white group-hover:text-indigo-300 transition-colors">
        {offer.title}
      </h3>
      {offer.scopeSummary && (
        <p className="mt-1.5 text-sm text-slate-400 line-clamp-2 leading-relaxed">{offer.scopeSummary}</p>
      )}
      <div className="mt-auto pt-4 flex items-center justify-between">
        <span className="text-lg font-bold text-white tabular-nums">
          {formatCurrency(offer.price, offer.currency)}
        </span>
        <span className="inline-flex items-center gap-1 text-sm text-indigo-400 group-hover:text-indigo-300 transition-colors">
          View offer
          <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </div>
    </Link>
  );
}

export default async function StorePage() {
  // A storage failure is surfaced honestly as an unavailable catalog — never
  // silently rendered as "there is nothing to buy".
  const offers = await listPublicOffers(24).catch(() => null);
  const catalogUnavailable = offers === null;
  const visibleOffers = offers ?? [];

  return (
    <div>
      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                             */}
      {/* ---------------------------------------------------------------- */}
      <section className="relative overflow-hidden border-b border-slate-800/70">
        <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_20%_0%,rgba(16,185,129,0.10),transparent_60%),radial-gradient(50%_45%_at_85%_10%,rgba(99,102,241,0.14),transparent_65%)]" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
          <p className="inline-flex items-center gap-2 rounded-full border border-emerald-800/60 bg-emerald-950/50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Public storefront · human-activated · halal-screened
          </p>
          <h1 className="mt-6 max-w-3xl text-3xl sm:text-5xl font-bold tracking-tight text-white">
            Halal-cleared digital work,
            <span className="text-emerald-400"> ready to buy.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base sm:text-lg text-slate-400 leading-relaxed">
            Every offer below comes straight from a governed production pipeline: screened for prohibited
            categories, priced upfront, activated by a human operator, and fulfilled personally. You pay only
            through confirmed instructions — never through this page.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="#catalog"
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
            >
              Browse offers
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="#how"
              className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-5 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-900 transition-colors"
            >
              How purchasing works
            </a>
          </div>
          <dl className="mt-12 grid gap-4 sm:grid-cols-3 max-w-3xl">
            {[
              ['Screened first', 'Gambling, adult content, fraud, piracy and deception are blocked before listing.'],
              ['Upfront pricing', 'What you see is what you are asked to pay — no hidden upsells.'],
              ['Verified payment', 'A sale is recorded only after the operator verifies real payment.'],
            ].map(([title, body]) => (
              <div key={title} className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <dt className="text-sm font-semibold text-white">{title}</dt>
                <dd className="mt-1 text-xs text-slate-400 leading-relaxed">{body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Catalog                                                          */}
      {/* ---------------------------------------------------------------- */}
      <section id="catalog" className="mx-auto max-w-6xl px-4 sm:px-6 py-16 scroll-mt-20">
        <div className="flex items-end justify-between gap-4 mb-8">
          <div>
            <h2 className="text-2xl font-bold text-white">Catalog</h2>
            <p className="mt-1 text-sm text-slate-400">
              Live offers from the AI Income Lab pipeline — updated in real time.
            </p>
          </div>
          <span className="text-xs text-slate-500 tabular-nums">
            {catalogUnavailable ? 'unavailable' : `${visibleOffers.length} available`}
          </span>
        </div>

        {visibleOffers.length > 0 ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {visibleOffers.map((offer) => (
              <OfferCard key={offer.id} offer={offer} />
            ))}
          </div>
        ) : catalogUnavailable ? (
          <div className="rounded-xl border border-dashed border-amber-800/60 bg-amber-950/20 p-10 text-center">
            <p className="text-sm font-medium text-amber-300">The catalog is temporarily unavailable.</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-400 leading-relaxed">
              Nothing is being hidden from you — the store could not load its listings right now. Please retry
              in a moment.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-10 text-center">
            <ShieldCheck className="mx-auto h-8 w-8 text-emerald-500/70" />
            <p className="mt-4 text-sm font-medium text-white">No offers are published right now.</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-400 leading-relaxed">
              Offers appear here only after they clear halal screening and the operator activates them. Nothing
              unreviewed is ever listed.
            </p>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* How it works                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section id="how" className="border-y border-slate-800/70 bg-slate-900/30 scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16">
          <h2 className="text-2xl font-bold text-white">How purchasing works</h2>
          <p className="mt-1 text-sm text-slate-400">
            One honest loop: request → confirmation → verified payment → delivery.
          </p>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {HOW_IT_WORKS.map(({ icon: Icon, step, title, body }) => (
              <div key={step} className="rounded-xl border border-slate-800 bg-slate-950/60 p-5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600/15 ring-1 ring-indigo-500/40">
                  <Icon className="h-4 w-4 text-indigo-400" />
                </div>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-indigo-400">{step}</p>
                <h3 className="mt-1 text-sm font-semibold text-white">{title}</h3>
                <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Halal commitment                                                 */}
      {/* ---------------------------------------------------------------- */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16">
        <div className="grid gap-8 lg:grid-cols-2 items-start">
          <div>
            <h2 className="text-2xl font-bold text-white">Our halal commitment</h2>
            <p className="mt-4 text-sm text-slate-400 leading-relaxed">
              The platform behind this storefront runs multi-layer halal screening on every opportunity, offer and
              execution job. Categories like gambling, betting, adult content, scams, fraud, fake reviews,
              piracy, copyright abuse and manipulative financial schemes are blocked outright — and an offer that
              fails screening at display time drops off this page automatically.
            </p>
            <p className="mt-3 text-sm text-slate-500 leading-relaxed">
              Automated screening is a filter, not a religious authority. When in doubt, ask us before you buy.
            </p>
          </div>
          <ul className="space-y-3">
            {[
              ['Messages are data, never authority', 'A buyer claim in a message can change nothing about payment, delivery or compliance state.'],
              ['Payment is never assumed', 'Screenshots and “I sent it” messages are not evidence — the operator verifies the payment event itself.'],
              ['Human-activated selling', 'Every offer is activated (and can be retired) by the operator, never by automation alone.'],
            ].map(([title, body]) => (
              <li key={title} className="flex gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <div>
                  <p className="text-sm font-semibold text-white">{title}</p>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* CTA band */}
      <section className="border-t border-slate-800/70">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-14 text-center">
          <h2 className="text-xl sm:text-2xl font-bold text-white">Found something useful?</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
            Open any offer, send a purchase request, and take the first step of a legitimate, halal transaction.
          </p>
          <a
            href="#catalog"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 transition-colors"
          >
            See the catalog
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </section>
    </div>
  );
}
