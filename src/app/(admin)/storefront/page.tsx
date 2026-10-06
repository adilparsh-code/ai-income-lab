// ============================================================================
// /storefront — OPERATOR VIEW of the public acquisition surface.
// ============================================================================
// Gated by the (admin) layout like every console page. Shows: what the public
// storefront currently lists (with exact reasons for anything not listed),
// inbound purchase requests captured by POST /api/store/inquiries, and the
// manual first-sale runbook that ends in the existing Revenue ledger.
// Read-only: no new mutation paths, no dashboard changes.
// ============================================================================

import Link from 'next/link';
import { ExternalLink, Inbox, ShieldCheck, Store, ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import {
  listOfferListingReadiness,
  listStoreInquiries,
  type OfferReadiness,
  type StoreInquiryRow,
} from '@/lib/storefront/store';
import { offerTypeLabel } from '@/lib/storefront/labels';
import { formatCurrency, formatDate } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Storefront — AI Income Lab' };

function parseBusinessInfo(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

export default async function StorefrontPage() {
  // Operator surface: storage failures surface as an honest error page —
  // never as a silently empty console.
  const readiness: OfferReadiness[] = await listOfferListingReadiness(50);
  const inquiries: StoreInquiryRow[] = await listStoreInquiries(25);

  const listed = readiness.filter((r) => r.verdict.listable).length;

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <PageHeader
        title="Storefront"
        description="The public acquisition surface: what buyers see at /store, what they send back, and how the first legitimate sale is captured."
      >
        <Link
          href="/revenue"
          className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-sm font-medium hover:bg-slate-800 transition-colors"
        >
          Record revenue
          <ArrowRight className="h-4 w-4" />
        </Link>
        <Link
          href="/store"
          target="_blank"
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
        >
          View public store
          <ExternalLink className="h-4 w-4" />
        </Link>
      </PageHeader>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="flex items-center gap-2 text-xs text-slate-400">
            <Store className="h-3.5 w-3.5 text-emerald-400" /> Public offers listed
          </p>
          <p className="mt-2 text-2xl font-bold text-white tabular-nums">{listed}</p>
          <p className="mt-1 text-[11px] text-slate-500">of {readiness.length} offers in pipeline</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="flex items-center gap-2 text-xs text-slate-400">
            <Inbox className="h-3.5 w-3.5 text-indigo-400" /> Inbound purchase requests
          </p>
          <p className="mt-2 text-2xl font-bold text-white tabular-nums">{inquiries.length}</p>
          <p className="mt-1 text-[11px] text-slate-500">captured via /api/store/inquiries</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="flex items-center gap-2 text-xs text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Display gate
          </p>
          <p className="mt-2 text-sm font-semibold text-white">ACTIVE · HALAL · priced · re-screened</p>
          <p className="mt-1 text-[11px] text-slate-500">fail-closed at render time</p>
        </div>
      </div>

      {/* Offer readiness */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-white">Offer listing readiness</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Why each offer is (or is not) visible on the public storefront.
          </p>
        </div>
        {readiness.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500 text-center">
            No offers exist yet. Create one via POST /api/commercial/offers, screen it, and set it ACTIVE with a
            price &gt; 0 to publish it here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                  <th className="px-5 py-3 font-medium">Offer</th>
                  <th className="px-3 py-3 font-medium">Type</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Halal</th>
                  <th className="px-3 py-3 font-medium">Price</th>
                  <th className="px-3 py-3 font-medium">Public listing</th>
                </tr>
              </thead>
              <tbody>
                {readiness.map(({ offer, verdict }) => (
                  <tr key={offer.id} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-5 py-3 text-white max-w-[18rem] truncate">{offer.title}</td>
                    <td className="px-3 py-3 text-slate-400 whitespace-nowrap">{offerTypeLabel(offer.type)}</td>
                    <td className="px-3 py-3 text-slate-400 whitespace-nowrap">{offer.status}</td>
                    <td className="px-3 py-3 text-slate-400 whitespace-nowrap">{offer.halalStatus}</td>
                    <td className="px-3 py-3 text-slate-300 whitespace-nowrap tabular-nums">
                      {formatCurrency(offer.price, offer.currency)}
                    </td>
                    <td className="px-3 py-3">
                      {verdict.listable ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800/70 bg-emerald-950/60 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                          <ShieldCheck className="h-3 w-3" /> Listed
                        </span>
                      ) : (
                        <ul className="space-y-0.5 text-[11px] text-amber-400/90 max-w-sm">
                          {verdict.reasons.map((reason) => (
                            <li key={reason}>· {reason}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Inbound inquiries */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-white">Inbound purchase requests</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Buyers who requested a purchase. These are UNTRUSTED DATA/leads — never payment evidence.
          </p>
        </div>
        {inquiries.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500 text-center">
            No inbound requests yet. Share <code className="text-slate-400">/store</code> with a real buyer to
            open the channel.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                  <th className="px-5 py-3 font-medium">Received</th>
                  <th className="px-3 py-3 font-medium">Buyer</th>
                  <th className="px-3 py-3 font-medium">Interest</th>
                  <th className="px-3 py-3 font-medium">Note</th>
                  <th className="px-3 py-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {inquiries.map((row) => {
                  const info = parseBusinessInfo(row.businessInfo);
                  const interest = typeof info.interest === 'string' ? info.interest : row.sourceRef ?? '—';
                  const note = typeof info.note === 'string' ? info.note : '';
                  return (
                    <tr key={row.id} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-5 py-3 text-slate-400 whitespace-nowrap">{formatDate(row.createdAt)}</td>
                      <td className="px-3 py-3">
                        <span className="block text-white">{row.displayName}</span>
                        <span className="block text-xs text-slate-500">{row.email ?? 'no email'}</span>
                      </td>
                      <td className="px-3 py-3 text-slate-300 max-w-[14rem] truncate">{interest}</td>
                      <td className="px-3 py-3 text-slate-500 max-w-[20rem] truncate" title={note}>
                        {note || '—'}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span className="rounded border border-slate-700 bg-slate-800/70 px-2 py-0.5 text-[11px] text-slate-300">
                          {row.lifecycleState} / {row.riskState}
                        </span>
                        {row.injectionFlags > 0 && (
                          <span className="ml-1 rounded border border-amber-800 bg-amber-950/60 px-2 py-0.5 text-[11px] text-amber-400">
                            {row.injectionFlags} flagged
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* First-sale runbook */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-white">First-sale runbook</h2>
        <ol className="mt-3 space-y-2 text-sm text-slate-400 list-decimal list-inside">
          <li>Publish at least one offer (ACTIVE, HALAL, price &gt; 0) so /store is non-empty.</li>
          <li>Share <code className="text-slate-400">/store</code> with a real buyer through your channel.</li>
          <li>Qualify the inbound request above (it is a lead, not a payment).</li>
          <li>Fulfil and deliver the product/service.</li>
          <li>Confirm the real payment event yourself — a message or screenshot is never proof.</li>
          <li>
            Record the sale on <Link href="/revenue" className="text-indigo-400 hover:text-indigo-300">Revenue</Link>{' '}
            (revenueBasis ACTUAL only for evidence-backed receipts).
          </li>
          <li>Read the funnel (PRODUCT_VIEW → CTA_CLICK → PURCHASE) for learning.</li>
        </ol>
        <p className="mt-3 text-xs text-slate-500">
          Full runbook: <code className="text-slate-400">docs/first-revenue-storefront.md</code>
        </p>
      </section>
    </div>
  );
}
