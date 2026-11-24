import nodemailer from 'nodemailer';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { enqueue, registerJob } from './queue.js';

export interface EmailProvider { readonly name: string; send(m: { to: string; subject: string; text: string; html: string; unsubscribeUrl?: string | null }): Promise<void> }
export class FakeEmailProvider implements EmailProvider { readonly name = 'fake'; sent: { to: string; subject: string; text: string; unsubscribeUrl?: string | null }[] = []; fail = false;
  async send(m: { to: string; subject: string; text: string; unsubscribeUrl?: string | null }) { if (this.fail) throw new Error('simulated SMTP outage'); this.sent.push({ to: m.to, subject: m.subject, text: m.text, unsubscribeUrl: m.unsubscribeUrl }); } }
export class SmtpEmailProvider implements EmailProvider { readonly name = 'smtp'; private t = nodemailer.createTransport(config.SMTP_URL!);
  async send(m: { to: string; subject: string; text: string; html: string; unsubscribeUrl?: string | null }) { await this.t.sendMail({ from: config.EMAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html, ...(m.unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${m.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}) }); } }
let provider: EmailProvider | undefined;
export const emailProvider = (): EmailProvider => (provider ??= config.EMAIL_PROVIDER === 'smtp' ? new SmtpEmailProvider() : new FakeEmailProvider());
export const setEmailProvider = (p: EmailProvider | undefined) => { provider = p; };

type Vars = Record<string, string | number>;
type Tpl = { subject: string; lines: string[]; cta?: string };
const T: Record<string, Record<'en' | 'fr', (v: Vars) => Tpl>> = {
  verify_email: { en: (v) => ({ subject: 'Confirm your email for twiqo', lines: ['Welcome to twiqo! Please confirm your email address so we can reach you about your deals.', 'This link works for 24 hours.'], cta: String(v.url) }),
    fr: (v) => ({ subject: 'Confirmez votre courriel pour twiqo', lines: ['Bienvenue sur twiqo! Confirmez votre adresse courriel pour que nous puissions vous joindre au sujet de vos transactions.', 'Ce lien est valide 24 heures.'], cta: String(v.url) }) },
  reset_password: { en: (v) => ({ subject: 'Reset your twiqo password', lines: ['We received a request to reset your password. If it was you, use the link below. It works for 1 hour.', "If you didn't ask for this, you can ignore this email; your password has not changed."], cta: String(v.url) }),
    fr: (v) => ({ subject: 'Réinitialisez votre mot de passe twiqo', lines: ['Nous avons reçu une demande de réinitialisation de votre mot de passe. Si c\'était vous, utilisez le lien ci-dessous (valide 1 heure).', "Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel : votre mot de passe n'a pas changé."], cta: String(v.url) }) },
  login_alert: { en: (v) => ({ subject: 'New sign-in to your twiqo account', lines: [`We noticed a sign-in from a new device: ${v.device} at ${v.time}.`, "If this was you, no action is needed. If not, reset your password right away and review your sessions in Settings → Security."] }),
    fr: (v) => ({ subject: 'Nouvelle connexion à votre compte twiqo', lines: [`Nous avons détecté une connexion depuis un nouvel appareil : ${v.device} à ${v.time}.`, "Si c'était vous, aucune action n'est nécessaire. Sinon, réinitialisez votre mot de passe tout de suite et vérifiez vos sessions dans Paramètres → Sécurité."] }) },
  password_changed: { en: () => ({ subject: 'Your twiqo password was changed', lines: ["Your password was just changed and you were signed out of other devices. If this wasn't you, reset your password immediately and contact support."] }),
    fr: () => ({ subject: 'Votre mot de passe twiqo a été modifié', lines: ["Votre mot de passe vient d'être modifié et vos autres appareils ont été déconnectés. Si ce n'était pas vous, réinitialisez-le immédiatement et contactez le soutien."] }) },
  two_factor_changed: { en: (v) => ({ subject: `Two-step verification ${v.state}`, lines: [`Two-step verification was turned ${v.state} on your twiqo account. If this wasn't you, reset your password and contact support.`] }),
    fr: (v) => ({ subject: `Vérification en deux étapes ${v.state === 'on' ? 'activée' : 'désactivée'}`, lines: [`La vérification en deux étapes a été ${v.state === 'on' ? 'activée' : 'désactivée'} sur votre compte twiqo. Si ce n'était pas vous, réinitialisez votre mot de passe et contactez le soutien.`] }) },
  account_deleted: { en: () => ({ subject: 'Your twiqo account was deleted', lines: ['Your account and personal details were deleted. Records we must keep for payments and disputes are retained without your name. Thanks for being part of twiqo.'] }),
    fr: () => ({ subject: 'Votre compte twiqo a été supprimé', lines: ['Votre compte et vos renseignements personnels ont été supprimés. Les documents que nous devons conserver pour les paiements et litiges sont gardés sans votre nom. Merci d\'avoir fait partie de twiqo.'] }) },
  digest: { en: (v) => ({ subject: `You have ${v.count} unread on twiqo`, lines: [String(v.lines)], cta: String(v.url) }), fr: (v) => ({ subject: `Vous avez ${v.count} notifications non lues sur twiqo`, lines: [String(v.lines)], cta: String(v.url) }) },
  notification: { en: (v) => ({ subject: String(v.subject), lines: [String(v.body)], cta: v.url ? String(v.url) : undefined }), fr: (v) => ({ subject: String(v.subject), lines: [String(v.body)], cta: v.url ? String(v.url) : undefined }) },
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function renderEmail(template: string, locale: 'en' | 'fr', vars: Vars) {
  const t = (T[template]?.[locale] ?? T[template]?.en)?.(vars); if (!t) throw new Error(`unknown email template ${template}`);
  const text = [...t.lines, ...(t.cta ? [t.cta] : []), '', '— twiqo'].join('\n\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#13203D"><h2 style="color:#246BFD">twiqo</h2>${t.lines.map((l) => `<p>${esc(l)}</p>`).join('')}${t.cta ? `<p><a href="${esc(t.cta)}" style="background:#246BFD;color:#fff;padding:12px 20px;border-radius:12px;text-decoration:none;display:inline-block">${locale === 'fr' ? 'Ouvrir' : 'Open'}</a></p><p style="font-size:12px;color:#5B6784">${esc(t.cta)}</p>` : ''}</div>`;
  return { subject: t.subject, text, html };
}

/** Store the email in the outbox and queue delivery. Safe inside a transaction: nothing is sent until the transaction commits and the worker runs. */
export async function queueEmail(db: Db, o: { userId?: string | null; to: string; template: string; locale?: 'en' | 'fr'; vars?: Vars; unsubscribeUrl?: string }) {
  const m = renderEmail(o.template, o.locale ?? 'en', o.vars ?? {});
  const foot = o.unsubscribeUrl ? `\n\n${o.locale === 'fr' ? 'Se désabonner des courriels de notification' : 'Unsubscribe from notification emails'}: ${o.unsubscribeUrl}` : '';
  const id = (await db.query(`INSERT INTO outbox_emails(user_id,to_email,template,subject,body_text,body_html,unsubscribe_url) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [o.userId ?? null, o.to, o.template, m.subject, m.text + foot, o.unsubscribeUrl ? m.html.replace(/<\/div>$/, `<p style="font-size:12px;color:#5B6784"><a href="${esc(o.unsubscribeUrl)}">${o.locale === 'fr' ? 'Se désabonner' : 'Unsubscribe'}</a></p></div>`) : m.html, o.unsubscribeUrl ?? null])).rows[0].id as number;
  await enqueue(db, 'send_email', { id });
  return id;
}
export async function emailUser(db: Db, userId: string, template: string, vars: Vars = {}) {
  const u = (await db.query('SELECT email, locale FROM users WHERE id=$1 AND status <> $2', [userId, 'deleted'])).rows[0]; if (!u) return null;
  return queueEmail(db, { userId, to: u.email, template, locale: u.locale, vars });
}

registerJob('send_email', async ({ id }) => {
  const m = (await pool.query(`UPDATE outbox_emails SET attempts = attempts + 1 WHERE id=$1 AND status='queued' RETURNING *`, [id])).rows[0]; if (!m) return;
  try { await emailProvider().send({ to: m.to_email, subject: m.subject, text: m.body_text, html: m.body_html, unsubscribeUrl: m.unsubscribe_url }); await pool.query(`UPDATE outbox_emails SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1`, [id]); }
  catch (e) { await pool.query(`UPDATE outbox_emails SET last_error=$2, status = CASE WHEN attempts >= 5 THEN 'failed' ELSE status END WHERE id=$1`, [id, String((e as Error).message).slice(0, 300)]); throw e; }
});
