import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export type Locale = 'en' | 'fr';
const KEY = 'twiqo.locale';

/** English is the source of truth. French (Canada) covers the shell, sign-in, feed, market, deals, payments and the growth pages.
 *  Anything without a French string falls back to English, so a missing key never shows a raw key. French text needs review by a native speaker before launch. */
const en: Record<string, string> = {
  'nav.home': 'Home', 'nav.market': 'Market', 'nav.create': 'Create', 'nav.move': 'Move', 'nav.me': 'Me', 'nav.signin': 'Sign in', 'nav.search': 'Search listings…', 'nav.search_aria': 'Search the market',
  'common.back': 'Back', 'common.cancel': 'Cancel', 'common.save': 'Save', 'common.load_more': 'Load more', 'common.loading': 'Loading…', 'common.all': 'All', 'common.language': 'Language', 'common.copy': 'Copy', 'common.copied': 'Copied', 'common.free': 'Free', 'common.now': 'now',
  'create.title': 'What do you want to do?',
  'create.post': 'Post', 'create.post.d': 'Share a photo or thought', 'create.sell': 'Sell something', 'create.sell.d': 'List almost anything lawful', 'create.clip': 'Clip', 'create.clip.d': 'Short vertical video',
  'create.story': 'Story', 'create.story.d': 'Gone in 24 hours', 'create.poll': 'Poll', 'create.poll.d': 'Ask your community', 'create.circle': 'Start a circle', 'create.circle.d': 'Build a community',
  'create.request': 'Find someone to move it', 'create.request.d': 'Post a transport request', 'create.journey': 'Offer a journey', 'create.journey.d': "Earn on a trip you're making", 'create.service': 'Offer a delivery service', 'create.service.d': 'Truck, van or courier', 'create.business': 'Business page', 'create.business.d': 'Set up a storefront',
  'auth.tagline': 'Connect. Discover. Move.', 'auth.welcome': 'Welcome back', 'auth.join': 'Join twiqo', 'auth.name': 'Your name', 'auth.email': 'Email', 'auth.username': 'Username', 'auth.username_hint': 'letters, numbers, . or _', 'auth.city': 'City', 'auth.city_hint': 'Only your city is shown — never your address.',
  'auth.identifier': 'Email or username', 'auth.password': 'Password', 'auth.signin': 'Sign in', 'auth.create': 'Create account', 'auth.busy': 'One moment…', 'auth.new': 'New here? Create an account', 'auth.have': 'Have an account? Sign in', 'auth.invite': 'Invitation code (optional)', 'auth.invite_hint': 'If a friend invited you, their code is applied automatically.',
  'home.for_you': 'For You', 'home.following': 'Following', 'home.nearby': 'Nearby', 'home.circles': 'Circles', 'home.join_title': 'Discover, buy, sell and move almost anything.', 'home.join_text': 'Join twiqo to follow people, make offers and message sellers.', 'home.join_cta': 'Sign up or sign in',
  'home.trending': 'Trending now', 'home.trending_tags': 'Trending topics', 'home.trending_circles': 'Growing circles', 'home.people': 'People you may know', 'home.sponsored': 'Sponsored', 'home.follow': 'Follow', 'home.following_btn': 'Following',
  'market.title': 'Market', 'market.search': 'Search furniture, bikes, tires…', 'market.filters': 'Filters', 'market.none': 'No listings match', 'market.none_text': 'Try a different search or clear some filters.', 'market.clear': 'Clear filters', 'market.sell': 'Sell something',
  'market.for_you': 'Recommended for you', 'market.for_you_new': 'New and nearby', 'market.similar': 'Similar listings', 'market.featured': 'Featured',
  'deals.offers': 'Offers', 'deals.waiting': 'Waiting for me', 'deals.sent': 'I sent', 'deals.closed': 'Closed', 'deals.moves_orders': 'My moves & orders', 'deals.active': 'Active', 'deals.past': 'Past', 'deals.transport': 'Transport bookings', 'deals.purchases': 'Purchases & sales',
  'pay.title': 'Payment', 'pay.unpaid': 'Not paid on twiqo', 'pay.paid': 'Paid by card', 'pay.partial': 'Partly refunded', 'pay.refunded': 'Refunded', 'pay.pay_card': 'Pay by card', 'pay.settings': 'Payments & payouts', 'pay.report': 'Report a problem', 'pay.refund': 'Refund…', 'pay.setup': 'Set up card payouts',
  'me.edit': 'Edit profile', 'me.offers': 'Offers', 'me.deals': 'Moves & orders', 'me.saved': 'Saved', 'me.payments': 'Payments', 'me.invite': 'Invite friends', 'me.insights': 'Insights', 'me.pro': 'Business Pro', 'me.signout': 'Sign out',
  'invite.title': 'Invite friends', 'invite.your_link': 'Your invitation link', 'invite.credit': 'Your twiqo credit', 'invite.signed_up': 'Signed up', 'invite.qualified': 'Completed a deal', 'invite.earned': 'Credit earned', 'invite.history': 'Your invitations', 'invite.none': 'No invitations yet. Share your link to get started.', 'invite.pending': 'Waiting for their first deal', 'invite.done': 'Rewarded',
  'pro.title': 'Business Pro', 'pro.price': 'per month', 'pro.subscribe': 'Subscribe', 'pro.manage': 'Manage billing', 'pro.active': 'Active', 'pro.ends': 'Ends', 'pro.renews': 'Renews', 'pro.cancel_end': 'Cancel at period end',
  'insights.title': 'Insights', 'insights.views': 'Views', 'insights.saves': 'Saves', 'insights.likes': 'Likes', 'insights.offers': 'Offers', 'insights.visitors': 'Visitors', 'insights.last': 'Last {n} days', 'insights.empty': 'List something to see how it performs.', 'insights.upgrade': 'Business Pro adds daily trends and conversion.',
  'hero.badge': "Canada's people-powered moving network", 'hero.guest_title': 'Move anything across Canada.', 'hero.guest_text': 'Drivers already heading your way carry your stuff for less. Buy and sell along the route.',
  'hero.title': 'Need something moved?', 'hero.text': 'Drivers already going your way. Prices from $60.', 'hero.from': 'From city', 'hero.to': 'To city', 'hero.find': 'Find a driver', 'hero.driving': "I'm driving", 'hero.driving_long': "I'm driving, I have space", 'hero.post_request': 'Post what you need moved',
  'how.title': 'How it works', 'how.1': "Post what you're moving", 'how.1d': 'Add size, weight and where it is going.', 'how.2': 'Pick a driver you trust', 'how.2d': 'See ratings, verification and the exact route.', 'how.3': 'Hand over with a PIN', 'how.3d': 'Track the trip, pay securely, confirm delivery.', 'how.paid': 'Paid only when it arrives', 'how.paid_d': 'Payment is held until you confirm delivery.',
  'moves.active': 'Your moves in progress', 'moves.track': 'Track', 'home.drivers': 'Drivers going your way', 'home.no_drivers': 'No drivers listed yet', 'home.no_drivers_d': 'Post what you need moved and drivers can come to you.', 'home.shop': 'Shop nearby', 'home.community': 'From your community', 'home.good_morning': 'Good morning', 'home.good_afternoon': 'Good afternoon', 'home.good_evening': 'Good evening',
  'common.see_all': 'See all', 'market.delivery': 'Delivery', 'market.sub': 'Buy and sell near you', 'market.banner': 'Bought something big?', 'market.banner_d': 'Get it moved by a driver.', 'market.banner_cta': 'Move',
  'move.sub': "Send something, or earn on a trip you're already making.", 'move.tab.journeys': 'Drivers going my way', 'move.tab.requests': 'Things to move', 'move.tab.services': 'Movers for hire', 'move.search.journeys': 'Search drivers', 'move.search.requests': 'Search requests', 'move.search.services': 'Find movers', 'move.from': 'From', 'move.space_left': 'free', 'move.post_request': 'Post a request', 'move.offer_trip': 'Offer a trip', 'move.offer_service': 'Offer a service', 'move.results': 'Results',
  'deliver.title': 'Get it delivered', 'deliver.drivers': 'Drivers leaving {city}: {n}', 'deliver.none': 'No drivers listed from here yet', 'deliver.post': 'Post it and let drivers offer', 'deliver.see': 'See drivers', 'deliver.cta': 'Request a driver',
  'create.group.move': 'Move', 'create.group.sell': 'Sell', 'create.group.share': 'Share', 'create.send': 'Send something', 'create.send.d': "Post what you're moving, get driver offers",
};

const fr: Record<string, string> = {
  'nav.home': 'Accueil', 'nav.market': 'Marché', 'nav.create': 'Créer', 'nav.move': 'Transport', 'nav.me': 'Moi', 'nav.signin': 'Connexion', 'nav.search': 'Rechercher des annonces…', 'nav.search_aria': 'Rechercher sur le marché',
  'common.back': 'Retour', 'common.cancel': 'Annuler', 'common.save': 'Enregistrer', 'common.load_more': 'Voir plus', 'common.loading': 'Chargement…', 'common.all': 'Tout', 'common.language': 'Langue', 'common.copy': 'Copier', 'common.copied': 'Copié', 'common.free': 'Gratuit', 'common.now': "à l'instant",
  'create.title': 'Que voulez-vous faire?',
  'create.post': 'Publication', 'create.post.d': 'Partagez une photo ou une pensée', 'create.sell': 'Vendre quelque chose', 'create.sell.d': "Annoncez presque tout ce qui est légal", 'create.clip': 'Clip', 'create.clip.d': 'Courte vidéo verticale',
  'create.story': 'Story', 'create.story.d': 'Disparaît après 24 heures', 'create.poll': 'Sondage', 'create.poll.d': 'Interrogez votre communauté', 'create.circle': 'Créer un cercle', 'create.circle.d': 'Bâtissez une communauté',
  'create.request': "Trouver quelqu'un pour le transporter", 'create.request.d': 'Publiez une demande de transport', 'create.journey': 'Proposer un trajet', 'create.journey.d': 'Gagnez de l\'argent sur un trajet que vous faites déjà', 'create.service': 'Offrir un service de livraison', 'create.service.d': 'Camion, fourgonnette ou coursier', 'create.business': "Page d'entreprise", 'create.business.d': 'Créez votre vitrine',
  'auth.tagline': 'Connectez. Découvrez. Déplacez.', 'auth.welcome': 'Bon retour', 'auth.join': 'Rejoindre twiqo', 'auth.name': 'Votre nom', 'auth.email': 'Courriel', 'auth.username': "Nom d'utilisateur", 'auth.username_hint': 'lettres, chiffres, . ou _', 'auth.city': 'Ville', 'auth.city_hint': "Seule votre ville est affichée, jamais votre adresse.",
  'auth.identifier': "Courriel ou nom d'utilisateur", 'auth.password': 'Mot de passe', 'auth.signin': 'Se connecter', 'auth.create': 'Créer un compte', 'auth.busy': 'Un instant…', 'auth.new': 'Nouveau ici? Créez un compte', 'auth.have': 'Déjà un compte? Connectez-vous', 'auth.invite': "Code d'invitation (facultatif)", 'auth.invite_hint': "Si un ami vous a invité, son code est appliqué automatiquement.",
  'home.for_you': 'Pour vous', 'home.following': 'Abonnements', 'home.nearby': 'À proximité', 'home.circles': 'Cercles', 'home.join_title': 'Découvrez, achetez, vendez et transportez presque tout.', 'home.join_text': 'Rejoignez twiqo pour suivre des gens, faire des offres et écrire aux vendeurs.', 'home.join_cta': "S'inscrire ou se connecter",
  'home.trending': 'Tendances', 'home.trending_tags': 'Sujets populaires', 'home.trending_circles': 'Cercles en croissance', 'home.people': 'Personnes que vous pourriez connaître', 'home.sponsored': 'Commandité', 'home.follow': "S'abonner", 'home.following_btn': 'Abonné',
  'market.title': 'Marché', 'market.search': 'Rechercher meubles, vélos, pneus…', 'market.filters': 'Filtres', 'market.none': 'Aucune annonce trouvée', 'market.none_text': 'Essayez une autre recherche ou retirez des filtres.', 'market.clear': 'Effacer les filtres', 'market.sell': 'Vendre quelque chose',
  'market.for_you': 'Recommandé pour vous', 'market.for_you_new': 'Nouveautés près de chez vous', 'market.similar': 'Annonces semblables', 'market.featured': 'En vedette',
  'deals.offers': 'Offres', 'deals.waiting': 'À traiter', 'deals.sent': 'Envoyées', 'deals.closed': 'Terminées', 'deals.moves_orders': 'Mes transports et commandes', 'deals.active': 'En cours', 'deals.past': 'Passés', 'deals.transport': 'Réservations de transport', 'deals.purchases': 'Achats et ventes',
  'pay.title': 'Paiement', 'pay.unpaid': 'Non payé sur twiqo', 'pay.paid': 'Payé par carte', 'pay.partial': 'Remboursé en partie', 'pay.refunded': 'Remboursé', 'pay.pay_card': 'Payer par carte', 'pay.settings': 'Paiements et versements', 'pay.report': 'Signaler un problème', 'pay.refund': 'Rembourser…', 'pay.setup': 'Configurer les versements par carte',
  'me.edit': 'Modifier le profil', 'me.offers': 'Offres', 'me.deals': 'Transports et commandes', 'me.saved': 'Enregistrés', 'me.payments': 'Paiements', 'me.invite': 'Inviter des amis', 'me.insights': 'Statistiques', 'me.pro': 'Business Pro', 'me.signout': 'Se déconnecter',
  'invite.title': 'Inviter des amis', 'invite.your_link': "Votre lien d'invitation", 'invite.credit': 'Votre crédit twiqo', 'invite.signed_up': 'Inscrits', 'invite.qualified': 'Ont conclu une transaction', 'invite.earned': 'Crédit gagné', 'invite.history': 'Vos invitations', 'invite.none': 'Aucune invitation pour le moment. Partagez votre lien pour commencer.', 'invite.pending': 'En attente de leur première transaction', 'invite.done': 'Récompensé',
  'pro.title': 'Business Pro', 'pro.price': 'par mois', 'pro.subscribe': "S'abonner", 'pro.manage': 'Gérer la facturation', 'pro.active': 'Actif', 'pro.ends': "Se termine le", 'pro.renews': 'Renouvellement le', 'pro.cancel_end': 'Annuler à la fin de la période',
  'insights.title': 'Statistiques', 'insights.views': 'Vues', 'insights.saves': 'Enregistrements', 'insights.likes': "J'aime", 'insights.offers': 'Offres', 'insights.visitors': 'Visiteurs', 'insights.last': '{n} derniers jours', 'insights.empty': 'Publiez une annonce pour voir sa performance.', 'insights.upgrade': 'Business Pro ajoute les tendances quotidiennes et la conversion.',
  'hero.badge': 'Le réseau de transport entre particuliers au Canada', 'hero.guest_title': 'Transportez tout, partout au Canada.', 'hero.guest_text': 'Des conducteurs déjà en route transportent vos choses à moindre coût. Achetez et vendez en chemin.',
  'hero.title': 'Besoin de transporter quelque chose?', 'hero.text': 'Des conducteurs déjà en route. Dès 60 $.', 'hero.from': 'Ville de départ', 'hero.to': "Ville d'arrivée", 'hero.find': 'Trouver un conducteur', 'hero.driving': 'Je conduis', 'hero.driving_long': "Je conduis, j'ai de la place", 'hero.post_request': 'Publier ma demande',
  'how.title': 'Comment ça marche', 'how.1': 'Décrivez ce que vous transportez', 'how.1d': 'Taille, poids et destination.', 'how.2': 'Choisissez un conducteur de confiance', 'how.2d': "Évaluations, vérification et trajet exact.", 'how.3': 'Remise avec un NIP', 'how.3d': 'Suivez le trajet, payez en sécurité, confirmez la livraison.', 'how.paid': "Payé seulement à l'arrivée", 'how.paid_d': 'Le paiement est retenu jusqu\'à votre confirmation.',
  'moves.active': 'Vos transports en cours', 'moves.track': 'Suivre', 'home.drivers': 'Conducteurs sur votre route', 'home.shop': 'Près de chez vous', 'home.community': 'De votre communauté', 'home.good_morning': 'Bonjour', 'home.good_afternoon': 'Bon après-midi', 'home.good_evening': 'Bonsoir',
  'common.see_all': 'Tout voir', 'market.delivery': 'Livraison', 'market.sub': 'Achetez et vendez près de chez vous', 'market.banner': "Un gros achat?", 'market.banner_d': 'Faites-le transporter par un conducteur.', 'market.banner_cta': 'Transport',
  'move.sub': 'Envoyez quelque chose ou gagnez sur un trajet que vous faites déjà.', 'move.tab.journeys': 'Conducteurs sur ma route', 'move.tab.requests': 'À transporter', 'move.tab.services': 'Transporteurs', 'move.search.journeys': 'Chercher un conducteur', 'move.search.requests': 'Chercher des demandes', 'move.search.services': 'Trouver un transporteur', 'move.from': 'Dès', 'move.space_left': 'libres', 'move.post_request': 'Publier une demande', 'move.offer_trip': 'Proposer un trajet', 'move.offer_service': 'Proposer un service',
  'deliver.title': 'Faites-le livrer', 'deliver.drivers': 'Conducteurs au départ de {city} : {n}', 'deliver.none': 'Aucun conducteur au départ de cette ville pour le moment', 'deliver.see': 'Voir les conducteurs', 'deliver.cta': 'Demander un conducteur',
  'create.group.move': 'Transport', 'create.group.sell': 'Vendre', 'create.group.share': 'Partager', 'create.send': 'Envoyer quelque chose',
};
const dicts: Record<Locale, Record<string, string>> = { en, fr };

const detect = (): Locale => { try { const s = localStorage.getItem(KEY); if (s === 'en' || s === 'fr') return s; } catch { /* storage unavailable */ } return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en'; };
let current: Locale = detect();
export const getLocale = () => current;
export const numberLocale = () => (current === 'fr' ? 'fr-CA' : 'en-CA');
export function t(key: string, vars?: Record<string, string | number>) {
  let s = dicts[current][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

const Ctx = createContext<{ locale: Locale; setLocale: (l: Locale, signedIn?: boolean) => void }>({ locale: current, setLocale: () => {} });
export const useLocale = () => useContext(Ctx);
export const useT = () => { useContext(Ctx); return t; };

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, set] = useState<Locale>(current);
  const setLocale = useCallback((l: Locale, signedIn = false) => {
    current = l; set(l); try { localStorage.setItem(KEY, l); } catch { /* storage unavailable */ }
    document.documentElement.lang = l === 'fr' ? 'fr-CA' : 'en-CA';
    if (signedIn) api('/me/locale', { method: 'PATCH', body: { locale: l } }).catch(() => undefined);
  }, []);
  const v = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <Ctx.Provider value={v}><div key={locale} style={{ display: 'contents' }}>{children}</div></Ctx.Provider>;
}

export function LanguageSwitch({ signedIn }: { signedIn?: boolean }) {
  const { locale, setLocale } = useLocale();
  return <div className="row" role="group" aria-label={t('common.language')}>{(['en', 'fr'] as const).map((l) => <button key={l} type="button" className={`pill ${locale === l ? 'b' : ''}`} aria-pressed={locale === l} lang={l} onClick={() => setLocale(l, signedIn)}>{l === 'en' ? 'English' : 'Français'}</button>)}</div>;
}
