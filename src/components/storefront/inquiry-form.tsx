'use client';

// ============================================================================
// STOREFRONT INQUIRY FORM — the buyer's entry into the income loop.
// ============================================================================
// Posts to the public POST /api/store/inquiries endpoint. Client-side rules
// mirror the server's validation (the server is authoritative — this is only
// for fast feedback). A hidden honeypot field traps naive bots, and a stable
// requestId makes double-submits collapse to one recorded message.
// ============================================================================

import { useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, Send, ShieldCheck } from 'lucide-react';
import { trackStoreEvent } from '@/lib/storefront/track';

interface InquiryFormProps {
  offerId: string;
  productId?: string | null;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'received'; email: string }
  | { kind: 'error'; message: string };

const NAME_MAX = 200;
const EMAIL_MAX = 320;
const MESSAGE_MAX = 2_000;

function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function InquiryForm({ offerId, productId }: InquiryFormProps) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [company, setCompany] = useState(''); // honeypot — humans never see it
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const requestIdRef = useRef<string>(newRequestId());

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind === 'submitting') return;
    setState({ kind: 'submitting' });
    try {
      const res = await fetch('/api/store/inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId,
          displayName: displayName.trim(),
          email: email.trim(),
          message: message.trim(),
          requestId: requestIdRef.current,
          company,
        }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && json?.ok) {
        if (productId) trackStoreEvent('CTA_CLICK', productId);
        setState({ kind: 'received', email: email.trim() });
        return;
      }
      setState({
        kind: 'error',
        message: json?.error || 'We could not send your request. Please try again.',
      });
    } catch {
      setState({ kind: 'error', message: 'Network error — please check your connection and try again.' });
    }
  }

  if (state.kind === 'received') {
    return (
      <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/40 p-6 space-y-3">
        <div className="flex items-center gap-2 text-emerald-300 font-semibold">
          <CheckCircle2 className="h-5 w-5" />
          Request received
        </div>
        <p className="text-sm text-slate-300 leading-relaxed">
          Thank you — we recorded your purchase request and will contact you at{' '}
          <span className="text-white font-medium">{state.email}</span> with payment and delivery details.
        </p>
        <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
          <li>Payment instructions are confirmed personally — no automated charges.</li>
          <li>Your purchase is fulfilled only after the payment is verified by the operator.</li>
          <li>A receipt is issued when the sale is recorded.</li>
        </ul>
        <Link href="/store" className="inline-block text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
          ← Back to the catalog
        </Link>
      </div>
    );
  }

  const busy = state.kind === 'submitting';

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-busy={busy}>
      <div>
        <label htmlFor="inquiry-name" className="block text-xs font-medium text-slate-400 mb-1.5">
          Your name
        </label>
        <input
          id="inquiry-name"
          name="name"
          type="text"
          required
          maxLength={NAME_MAX}
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
          placeholder="Full name"
        />
      </div>

      <div>
        <label htmlFor="inquiry-email" className="block text-xs font-medium text-slate-400 mb-1.5">
          Email
        </label>
        <input
          id="inquiry-email"
          name="email"
          type="email"
          required
          maxLength={EMAIL_MAX}
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label htmlFor="inquiry-message" className="block text-xs font-medium text-slate-400 mb-1.5">
          What would you like to buy?
        </label>
        <textarea
          id="inquiry-message"
          name="message"
          required
          maxLength={MESSAGE_MAX}
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none resize-y"
          placeholder="Tell us which offer you want and any questions about delivery…"
        />
      </div>

      {/* Honeypot: hidden from humans, irresistible to naive bots. */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="inquiry-company">Company</label>
        <input
          id="inquiry-company"
          name="company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      {state.kind === 'error' && (
        <div
          role="alert"
          className="rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300"
        >
          {state.message}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || displayName.trim().length === 0 || email.trim().length === 0 || message.trim().length === 0}
        className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Sending request…
          </>
        ) : (
          <>
            <Send className="h-4 w-4" />
            Request to purchase
          </>
        )}
      </button>

      <p className="text-[11px] text-slate-500 flex items-start gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-500/80" />
        <span>
          Your details are used only to fulfil this purchase request. No payment is taken on this page — you
          receive confirmed instructions first.
        </span>
      </p>
    </form>
  );
}
