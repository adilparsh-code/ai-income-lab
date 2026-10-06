// ============================================================================
// /store/[offerId] — PUBLIC OFFER DETAIL + PURCHASE REQUEST.
// ============================================================================
// Renders ONLY offers that pass the fail-closed public eligibility gate
// (getPublicOffer returns null otherwise → 404). The purchase path never
// takes payment on-page: the buyer sends a bounded request that is recorded
// through the existing inbound client pipeline, and payment is confirmed
// manually by the operator afterwards.
// ============================================================================

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink, ShieldCheck, Timer, UserCheck } from 'lucide-react';
import { getPublicOffer, type StoreOffer } from '@/lib/storefront/store';
import { offerTypeLabel } from '@/lib/storefront/labels';
import { formatCurrency } from '@/lib/utils';
import { HalalBadge } from '@/components/shared/halal-badge';
import { InquiryForm } from '@/components/storefront/inquiry-form';
import { StoreTracker } from '@/components/storefront/store-tracker';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ offerId: string }>;
}

function externalHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props) {
  const { offerId } = await params;
  const offer = await getPublicOffer(offerId).catch(() => null);
  if (!offer) return { title: 'Offer not found' };
  return {
    title: offer.title,
    description: offer.scopeSummary || `Halal-screened ${offerTypeLabel(offer.type).toLowerCase()} offer.`,
  };
}

export default async function OfferDetailPage({ params }: Props) {
  const { offerId } = await params;
  // Missing / non-listable → null → 404. A storage outage is NOT mapped to a
  // fake 404 here: it surfaces as an honest error instead of a lie.
  const offer: StoreOffer | null = await getPublicOffer(offerId);
  if (!offer) notFound();

  const buyUrl = offer.product?.productUrl?.trim() || null;
  const buyHost = buyUrl ? externalHost(buyUrl) : null;

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10">
      <StoreTracker productId={offer.productId} />

      <Link
        href="/store#catalog"
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to catalog
      </Link>

      <div className="mt-6 grid gap-8 lg:grid-cols-3">
        {/* ------------------------------------------------------------ */}
        {/* Offer details                                                 */}
        {/* ------------------------------------------------------------ */}
        <div className="lg:col-span-2 space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-0.5 text-[11px] font-medium text-slate-300">
              {offerTypeLabel(offer.type)}
            </span>
            <HalalBadge status="HALAL" />
          </div>

          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">{offer.title}</h1>

          {offer.scopeSummary && (
            <p className="text-base text-slate-300 leading-relaxed">{offer.scopeSummary}</p>
          )}

          {offer.description && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
              <h2 className="text-sm font-semibold text-white">About this offer</h2>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed whitespace-pre-line">
                {offer.description}
              </p>
            </div>
          )}

          <ul className="grid gap-3 sm:grid-cols-2">
            <li className="flex gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <div>
                <p className="text-sm font-semibold text-white">Screened before listing</p>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Passed stored halal status and display-time keyword/category screening.
                </p>
              </div>
            </li>
            <li className="flex gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <UserCheck className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
              <div>
                <p className="text-sm font-semibold text-white">Fulfilled by the operator</p>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  A real person confirms your order and delivers the work.
                </p>
              </div>
            </li>
            <li className="flex gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <Timer className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div>
                <p className="text-sm font-semibold text-white">Response time</p>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  Purchase requests are reviewed promptly during working hours.
                </p>
              </div>
            </li>
            <li className="flex gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
              <div>
                <p className="text-sm font-semibold text-white">No on-page payment</p>
                <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                  You receive confirmed instructions first; nothing is charged here.
                </p>
              </div>
            </li>
          </ul>
        </div>

        {/* ------------------------------------------------------------ */}
        {/* Purchase card                                                 */}
        {/* ------------------------------------------------------------ */}
        <aside className="lg:col-span-1">
          <div className="lg:sticky lg:top-24 space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
              <p className="text-xs text-slate-500 uppercase tracking-wider">Price</p>
              <p className="mt-1 text-3xl font-bold text-white tabular-nums">
                {formatCurrency(offer.price, offer.currency)}
              </p>
              <p className="mt-1 text-xs text-slate-500">Fixed price · paid only after confirmed instructions.</p>

              {buyUrl && (
                <a
                  href={buyUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 transition-colors"
                >
                  Buy instantly{buyHost ? ` via ${buyHost}` : ''}
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
              <h2 className="text-sm font-semibold text-white">
                {buyUrl ? 'Or request personal checkout' : 'Request to purchase'}
              </h2>
              <p className="mt-1 mb-4 text-xs text-slate-400 leading-relaxed">
                Send your details and we will confirm availability, payment and delivery with you directly.
              </p>
              <InquiryForm offerId={offer.id} productId={offer.productId} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
