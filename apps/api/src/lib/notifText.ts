/** Plain-language text and a link for each notification type, in English and Canadian French. Used for push and email. */
type N = { type: string; target_type: string | null; target_id: string | null; data: Record<string, any>; actor_name: string | null };
type Out = { title: string; body: string; url: string };
const money = (c: unknown, l: 'en' | 'fr') => new Intl.NumberFormat(l === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: 'CAD' }).format(Number(c ?? 0) / 100);

function urlFor(n: N): string {
  const id = n.target_id;
  switch (n.target_type) {
    case 'order': return `/orders/${id}`; case 'booking': return `/bookings/${id}`; case 'listing': return `/l/${id}`; case 'journey': return `/j/${id}`; case 'transport_request': return `/r/${id}`;
    case 'transport_service': return `/s/${id}`; case 'post': return `/post/${id}`; case 'dispute': return `/disputes/${id}`; case 'payment': case 'account': return '/settings/payments';
    case 'referral': return '/settings/invite'; case 'subscription': return '/settings/pro'; case 'offer': return '/offers'; case 'boost': return '/settings/payments';
    default: return '/notifications';
  }
}
export function describeNotification(n: N, l: 'en' | 'fr'): Out {
  const who = n.actor_name ?? (l === 'fr' ? 'Quelqu\'un' : 'Someone'); const d = n.data ?? {}; const fr = l === 'fr'; const url = urlFor(n);
  const T = (en: [string, string], f: [string, string]): Out => ({ title: (fr ? f : en)[0], body: (fr ? f : en)[1], url });
  switch (n.type) {
    case 'follow': return T([`${who} followed you`, 'Tap to see their profile.'], [`${who} vous suit`, 'Touchez pour voir son profil.']);
    case 'comment': return T([`${who} commented`, 'New comment on your post or listing.'], [`${who} a commenté`, 'Nouveau commentaire sur votre publication ou annonce.']);
    case 'reply': return T([`${who} replied to you`, 'Tap to read the reply.'], [`${who} vous a répondu`, 'Touchez pour lire la réponse.']);
    case 'offer_received': return T([`New offer from ${who}`, `${money(d.amount_cents, l)} — review and respond.`], [`Nouvelle offre de ${who}`, `${money(d.amount_cents, l)} — consultez et répondez.`]);
    case 'offer_countered': return T([`${who} sent a counteroffer`, `${money(d.amount_cents, l)}`], [`${who} a fait une contre-offre`, `${money(d.amount_cents, l)}`]);
    case 'offer_accepted': return T([`${who} accepted your offer`, `${money(d.amount_cents, l)} — you can arrange the next steps now.`], [`${who} a accepté votre offre`, `${money(d.amount_cents, l)} — vous pouvez organiser la suite.`]);
    case 'offer_rejected': return T([`Your offer was closed`, String(d.reason ?? 'It was declined or expired.')], [`Votre offre est close`, String(d.reason ?? 'Elle a été refusée ou a expiré.')]);
    case 'booking_update': { const e = String(d.event ?? 'update'); const L: Record<string, [string, string]> = { pickup_confirmed: ['Pickup confirmed', 'Pickup confirmé'], in_transit: ['On the way', 'En route'], delivered: ['Delivered', 'Livré'], completed: ['Completed', 'Terminé'], cancelled: ['Cancelled', 'Annulé'], update: ['New update', 'Nouvelle mise à jour'] };
      const x = L[e] ?? L.update; return T([`Booking: ${x[0]}`, 'Open your booking for details.'], [`Réservation : ${x[1]}`, 'Ouvrez votre réservation pour les détails.']); }
    case 'match': return T([`A match for your ${d.title ?? 'shipment'}`, `${d.score ?? ''}% match — take a look.`], [`Une correspondance pour ${d.title ?? 'votre envoi'}`, `${d.score ?? ''} % de compatibilité.`]);
    case 'journey_posted': return T([`${who} posted a journey`, String(d.title ?? '')], [`${who} a publié un trajet`, String(d.title ?? '')]);
    case 'group_invite': return T([`${who} invited you to a circle`, 'Tap to join.'], [`${who} vous invite dans un cercle`, 'Touchez pour rejoindre.']);
    case 'group_activity': return T(['Circle activity', 'Something new happened in one of your circles.'], ['Activité de cercle', 'Il y a du nouveau dans l\'un de vos cercles.']);
    case 'event_reminder': return T([`Reminder: ${d.title ?? 'event'}`, 'Starts soon.'], [`Rappel : ${d.title ?? 'événement'}`, 'Commence bientôt.']);
    case 'story_reply': return T([`${who} replied to your story`, ''], [`${who} a répondu à votre story`, '']);
    case 'payment_update': { const e = String(d.event ?? ''); const amt = d.amount_cents ? money(d.amount_cents, l) : '';
      const m: Record<string, [[string, string], [string, string]]> = { received: [['Payment received', `${amt} was paid to you.`], ['Paiement reçu', `${amt} vous a été versé.`]], paid: [['Payment confirmed', `Your payment of ${amt} went through.`], ['Paiement confirmé', `Votre paiement de ${amt} est passé.`]], refunded: [['Refund issued', `${amt} was refunded.`], ['Remboursement émis', `${amt} a été remboursé.`]], payouts_ready: [['Card payouts are ready', 'You can now accept card payments.'], ['Versements par carte prêts', 'Vous pouvez maintenant accepter les paiements par carte.']], card_dispute: [['Card dispute opened', 'A cardholder disputed a payment.'], ['Litige de carte ouvert', 'Un titulaire de carte conteste un paiement.']] };
      const x = m[e] ?? [['Payment update', ''], ['Mise à jour de paiement', '']]; return T(x[0], x[1]); }
    case 'dispute_update': return T(['Problem report update', 'Open it to read the latest.'], ['Mise à jour d\'un signalement', 'Ouvrez-le pour lire les derniers échanges.']);
    case 'boost_update': return T(['Boost update', ''], ['Mise à jour de promotion', '']);
    case 'referral_reward': return T(['You earned twiqo credit', `${money(d.reward_cents, l)} for inviting a friend.`], ['Vous avez gagné du crédit twiqo', `${money(d.reward_cents, l)} pour avoir invité un ami.`]);
    case 'subscription_update': return T(['Business Pro update', `Status: ${d.status ?? ''}`], ['Mise à jour Business Pro', `Statut : ${d.status ?? ''}`]);
    case 'saved_search_match': return T([`New for "${d.search_name ?? 'your search'}"`, String(d.title ?? '')], [`Nouveau pour « ${d.search_name ?? 'votre recherche'} »`, String(d.title ?? '')]);
    case 'price_drop': return T([`Price drop on a saved item`, `${d.title ?? ''}: now ${money(d.new_cents, l)} (was ${money(d.old_cents, l)})`], [`Baisse de prix sur un article enregistré`, `${d.title ?? ''} : maintenant ${money(d.new_cents, l)} (avant ${money(d.old_cents, l)})`]);
    case 'safety_alert': return T([`Safety alert from ${who}`, String(d.message ?? 'Open to see details.')], [`Alerte de sécurité de ${who}`, String(d.message ?? 'Ouvrez pour voir les détails.')]);
    default: return T(['New activity on twiqo', ''], ['Nouvelle activité sur twiqo', '']);
  }
}
/** Which notifications are emailed / pushed unless the person changes it. Social noise is off for email, on for nothing by default. */
export const DEFAULT_EMAIL = new Set(['offer_received', 'offer_countered', 'offer_accepted', 'offer_rejected', 'booking_update', 'payment_update', 'dispute_update', 'saved_search_match', 'price_drop', 'referral_reward', 'subscription_update', 'group_invite', 'safety_alert', 'match']);
export const DEFAULT_PUSH = new Set([...DEFAULT_EMAIL, 'reply', 'comment', 'follow', 'story_reply', 'event_reminder']);
