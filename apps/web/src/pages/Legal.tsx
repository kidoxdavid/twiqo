import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';

type Doc = { title: string; updated: string; body: (string | string[])[] };
const P = (s: string) => s;
const DOCS: Record<string, Doc> = {
  terms: { title: 'Terms of Service', updated: '2026-01 (draft)', body: [
    '1. What twiqo is', P('twiqo is a marketplace where people buy, sell and arrange delivery of goods. twiqo connects members; sellers, buyers, shippers and drivers make their own agreements with each other. twiqo is not a party to those agreements, does not own or inspect items, and does not employ drivers.'),
    '2. Your account', P('You must be at least 18 and give accurate information. Keep your password and two-step codes safe. You are responsible for activity on your account. We may suspend accounts that break these terms or put people at risk.'),
    '3. Listings and conduct', P('List only items you may lawfully sell, described honestly. Prohibited items are listed in the Prohibited Items policy. Do not harass people, post misleading content, manipulate reviews, or take transactions off twiqo to avoid fees or protections.'),
    '4. Payments and fees', P('Card payments are processed by Stripe. twiqo charges a fee on card sales and bookings, shown before you pay or accept, and fees for optional promotions or subscriptions. twiqo does not hold payments in escrow. Taxes on what you sell are your responsibility.'),
    '5. Delivery', P('Drivers are independent. Pickup and delivery are confirmed with PINs. twiqo does not insure items in transit; check the driver\'s own coverage. Report problems promptly through the app.'),
    '6. Problem reports and refunds', P('If something goes wrong, you can open a problem report. twiqo staff review it and may order a full, partial or no refund from the seller\'s or driver\'s earnings. This is a review service, not insurance, and decisions are made using the information available.'),
    '7. Liability', P('To the extent allowed by law, twiqo is not liable for losses arising from agreements between members. Nothing limits rights you have under consumer protection law.'),
    '8. Changes and contact', P('We may update these terms and will tell you about important changes. Contact support@twiqo.example.'),
  ] },
  privacy: { title: 'Privacy Policy', updated: '2026-01 (draft)', body: [
    'What we collect', P('Account details (name, email, username, city), what you post and send (including voice messages, which are kept for 180 days and deleted with your account), deals and payments, device and sign-in information, and first-party usage events (pages viewed, searches). We do not store your exact address on public pages: addresses are shared only between the two people in a booking.'),
    'Why we use it', P('To run the marketplace, keep it safe (fraud checks, reports, verification), process payments through Stripe, send notifications you ask for, and understand how twiqo is used.'),
    'Who sees it', P('Other members see your public profile and listings. Stripe processes payments and identity checks. Service providers host and deliver email and notifications for us. We do not sell your personal information.'),
    'Your choices', P('You can download your data, change notification settings, and delete your account in Settings → Account security. Some records (payments, disputes) must be kept for legal reasons and are kept without your name. Browsers that send Do Not Track or Global Privacy Control are not included in our analytics.'),
    'Retention', P('Analytics events are deleted after 180 days. Driver documents are kept while you are an active driver. Contact privacy@twiqo.example with questions or to make a request under PIPEDA or Quebec Law 25.'),
  ] },
  guidelines: { title: 'Community Guidelines', updated: '2026-01 (draft)', body: [
    'Be honest', P('Describe items accurately, use your own photos, and keep prices real.'), 'Be respectful', P('No harassment, hate, threats or sexual content. Keep conversations about the deal.'),
    'Stay safe', P('Meet in public places when you can. Never share your delivery PIN before the handover. Be wary of anyone who asks you to pay first by e-transfer, gift card or crypto, or to move the chat off twiqo.'),
    'Reviews', P('Reviews must reflect a real transaction. Fake, traded or retaliatory reviews are removed.'),
  ] },
  refunds: { title: 'Refunds & Disputes Policy', updated: '2026-01 (draft)', body: [
    'Before pickup', P('You can cancel a confirmed booking or an order before pickup. Card payments are refunded automatically.'),
    'After pickup or delivery', P('Open a problem report from the booking or order page within 14 days of completion. Both sides can reply. twiqo staff decide on a full, partial or no refund and explain why.'),
    'What is not covered', P('Payments made outside twiqo; disagreements about price after agreement; items that match their description. twiqo does not insure items in transit.'),
    'Card disputes', P('If a cardholder disputes a payment with their bank, twiqo submits the records it holds (PIN-confirmed handovers, timestamps, GPS if shared) to the card network.'),
  ] },
  prohibited: { title: 'Prohibited Items', updated: '2026-01 (draft)', body: [
    'Not allowed on twiqo', P('Illegal goods; weapons, firearms and ammunition; drugs and drug paraphernalia; stolen goods; counterfeit or replica goods; recalled products; hazardous or flammable materials; human remains, body parts or organs; wildlife products; adult services; personal data; anything that can\'t legally be sold or shipped in Canada.'),
    'Restricted (reviewed first)', P('Alcohol, tobacco and vapes, cannabis accessories, medical devices, live animals, and high-value electronics may be held for review before they appear.'),
    'Drivers', P('Drivers may refuse any item. Do not ask a driver to carry something you cannot describe, or anything illegal, hazardous or unaccompanied cash and valuables.'),
  ] },
};
export function LegalPage() {
  const { doc } = useParams(); const nav = useNavigate(); const d = DOCS[doc ?? 'terms'];
  if (!d) return <main className="main"><div className="state">Document not found</div></main>;
  return <main className="main"><div className="row" style={{ padding: '0 16px 8px' }}><button onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button><h1 style={{ fontSize: 20, fontWeight: 800 }}>{d.title}</h1></div>
    <div className="col" style={{ padding: '0 16px', lineHeight: 1.6 }}>
      <div className="card pad sm" role="note" style={{ background: '#FFF6E0' }}><b>Draft for legal review.</b> This text was written as a starting point and has not been reviewed by a lawyer. It must be reviewed and adapted for Canadian law (including Quebec's French-language requirements) before twiqo launches publicly.</div>
      {d.body.map((x, i) => (i % 2 === 0 ? <h2 key={i} className="sec" style={{ margin: '8px 0 0' }}>{x as string}</h2> : <p key={i} style={{ margin: 0 }}>{x as string}</p>))}
      <div className="muted sm">Last updated {d.updated}</div>
      <div className="row wrap">{Object.entries(DOCS).filter(([k]) => k !== (doc ?? 'terms')).map(([k, v]) => <Link key={k} className="pill" to={`/legal/${k}`}>{v.title}</Link>)}</div></div></main>;
}
