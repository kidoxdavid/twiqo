import { useMemo, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';

function Form({ amount, onPaid }: { amount: string; onPaid: () => void }) {
  const stripe = useStripe(); const elements = useElements(); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!stripe || !elements) return; setBusy(true); setErr('');
    const r = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: window.location.href } });
    setBusy(false);
    if (r.error) setErr(r.error.message ?? 'The payment did not go through.'); else onPaid();
  }
  return <form className="col" onSubmit={submit}><PaymentElement /><button className="btn" disabled={busy || !stripe}>{busy ? 'Processing…' : `Pay ${amount}`}</button>{err && <div className="err" role="alert">{err}</div>}</form>;
}

/** Stripe's own card form (PaymentElement). Card details go straight to Stripe and never touch twiqo's servers. */
export default function StripeCheckout({ publishableKey, clientSecret, amount, onPaid }: { publishableKey: string; clientSecret: string; amount: string; onPaid: () => void }) {
  const stripe = useMemo(() => loadStripe(publishableKey), [publishableKey]);
  return <Elements stripe={stripe} options={{ clientSecret, appearance: { theme: 'stripe', variables: { colorPrimary: '#246BFD', borderRadius: '12px' } } }}><Form amount={amount} onPaid={onPaid} /></Elements>;
}
