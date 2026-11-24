import { useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { Modal, State, ago, errMsg, cash } from '../components/ui';

function useAct() {
  const toast = useToast(); const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, ok: string, keys: string[]) => { try { await fn(); toast(ok); keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); return true; } catch (e) { toast(errMsg(e), 'err'); return false; } };
}

function Reason({ title, cta, onSubmit, onClose, days }: { title: string; cta: string; onSubmit: (reason: string, days?: number) => Promise<unknown>; onClose: () => void; days?: boolean }) {
  const [r, setR] = useState(''); const [d, setD] = useState(7); const [busy, setBusy] = useState(false);
  return <Modal onClose={onClose} title={title}><div className="col">
    <div className="field"><label htmlFor="rs">Reason (recorded in the audit log)</label><textarea id="rs" className="input" value={r} onChange={(e) => setR(e.target.value)} /></div>
    {days && <div className="field"><label htmlFor="dy">Days</label><input id="dy" type="number" min={1} max={3650} className="input" value={d} onChange={(e) => setD(+e.target.value)} /></div>}
    <button className="btn" disabled={busy || r.trim().length < 3} onClick={async () => { setBusy(true); await onSubmit(r.trim(), days ? d : undefined); setBusy(false); onClose(); }}>{cta}</button></div></Modal>;
}

function Overview() {
  const q = useQuery({ queryKey: ['astats'], queryFn: () => api('/admin/stats') });
  if (q.isLoading) return <State kind="loading" />; if (q.isError) return <State kind="error" text="You may not have access to analytics." />;
  const s = q.data; const k: [string, number][] = [['Users', s.users], ['New (7d)', s.new_users_7d], ['Active listings', s.active_listings], ['Awaiting review', s.pending_listings], ['Posts (7d)', s.posts_7d], ['Messages (7d)', s.messages_7d], ['Open reports', s.open_reports], ['Restricted users', s.suspended_users]];
  return <div className="kpis">{k.map(([l, v]) => <div key={l} className="kpi"><span>{l}</span><b>{v.toLocaleString()}</b></div>)}</div>;
}

function Reports() {
  const q = useQuery({ queryKey: ['areports'], queryFn: () => api('/admin/reports') }); const act = useAct();
  const [sel, setSel] = useState<{ r: any; action: 'remove' | 'dismiss' | 'suspend_user' } | null>(null);
  const { me } = useAuth();
  if (q.isLoading) return <State kind="loading" />;
  if (!q.data.items.length) return <State kind="empty" title="No open reports" text="Nice — nothing needs attention." />;
  return <>
    <table className="table"><thead><tr><th>Target</th><th>Reason</th><th>By</th><th>When</th><th /></tr></thead><tbody>{q.data.items.map((r: any) => (
      <tr key={r.id}><td><b>{r.target_type}</b>{r.report_count > 1 && <span className="pill r" style={{ marginLeft: 6 }}>{r.report_count} reports</span>}<div className="muted sm">{r.details}</div>
        {['post', 'listing'].includes(r.target_type) && <Link className="sm" style={{ color: 'var(--blue)' }} to={r.target_type === 'post' ? `/post/${r.target_id}` : `/l/${r.target_id}`}>View</Link>}</td>
        <td><span className="pill a">{r.reason.replace('_', ' ')}</span></td><td>@{r.reporter}</td><td>{ago(r.created_at)}</td>
        <td><div className="row wrap">{r.target_type !== 'user' && <button className="btn sm danger" onClick={() => setSel({ r, action: 'remove' })}>Remove</button>}
          {me?.permissions.includes('manage.users') && <button className="btn sm soft" onClick={() => setSel({ r, action: 'suspend_user' })}>Suspend user</button>}
          <button className="btn sm ghost" onClick={() => setSel({ r, action: 'dismiss' })}>Dismiss</button></div></td></tr>))}</tbody></table>
    {sel && <Reason title={sel.action === 'remove' ? 'Remove content' : sel.action === 'dismiss' ? 'Dismiss report' : 'Suspend user'} cta="Confirm" days={sel.action === 'suspend_user'} onClose={() => setSel(null)}
      onSubmit={(reason, days) => act(() => api(`/admin/reports/${sel.r.id}/resolve`, { body: { action: sel.action, reason, days } }), 'Report resolved', ['areports', 'astats'])} />}
  </>;
}

function Listings() {
  const q = useQuery({ queryKey: ['apending'], queryFn: () => api('/admin/listings/pending') }); const act = useAct(); const [sel, setSel] = useState<{ l: any; d: 'approve' | 'reject' } | null>(null);
  if (q.isLoading) return <State kind="loading" />;
  if (!q.data.items.length) return <State kind="empty" title="Review queue is empty" />;
  return <>{q.data.items.map((l: any) => <div key={l.id} className="card pad col" style={{ marginBottom: 12 }}>
    <div className="row"><b>{l.title}</b><span className="sp" /><b>{cash(l.price_cents)}</b></div><div className="row wrap"><span className="pill a">{l.category}{l.is_restricted ? ' · restricted' : ''}</span><span className="muted sm">@{l.username} · {ago(l.created_at)}</span></div>
    <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{l.description}</div>
    <div className="row"><button className="btn teal sm" onClick={() => setSel({ l, d: 'approve' })}>Approve</button><button className="btn danger sm" onClick={() => setSel({ l, d: 'reject' })}>Reject</button></div></div>)}
    {sel && <Reason title={`${sel.d === 'approve' ? 'Approve' : 'Reject'} listing`} cta="Confirm" onClose={() => setSel(null)} onSubmit={(reason) => act(() => api(`/admin/listings/${sel.l.id}/review`, { body: { decision: sel.d, reason } }), 'Done', ['apending', 'astats'])} />}</>;
}

function Users() {
  const [q, setQ] = useState(''); const r = useQuery({ queryKey: ['ausers', q], queryFn: () => api('/admin/users', { query: { q } }) }); const act = useAct();
  const [sel, setSel] = useState<{ u: any; a: 'suspend' | 'ban' | 'unban' } | null>(null);
  return <><input className="input" aria-label="Search users" placeholder="Search by name, username or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
    {r.isLoading ? <State kind="loading" /> : <table className="table"><thead><tr><th>User</th><th>Status</th><th>Roles</th><th /></tr></thead><tbody>{r.data.items.map((u: any) => <tr key={u.id}>
      <td><b>{u.display_name}</b><div className="muted sm">@{u.username} · {u.email}</div></td><td><span className={`pill ${u.status === 'active' ? 't' : 'r'}`}>{u.status}</span></td><td>{u.roles.map((x: string) => <span key={x} className="pill b" style={{ marginRight: 4 }}>{x}</span>)}</td>
      <td><div className="row wrap">{u.status === 'active' ? <><button className="btn sm soft" onClick={() => setSel({ u, a: 'suspend' })}>Suspend</button><button className="btn sm danger" onClick={() => setSel({ u, a: 'ban' })}>Ban</button></> : <button className="btn sm teal" onClick={() => setSel({ u, a: 'unban' })}>Restore</button>}</div></td></tr>)}</tbody></table>}
    {sel && <Reason title={`${sel.a[0].toUpperCase() + sel.a.slice(1)} @${sel.u.username}`} cta="Confirm" days={sel.a === 'suspend'} onClose={() => setSel(null)} onSubmit={(reason, days) => act(() => api(`/admin/users/${sel.u.id}/${sel.a}`, { body: { reason, days } }), 'User updated', ['ausers', 'astats'])} />}</>;
}

function Categories() {
  const q = useQuery({ queryKey: ['acats'], queryFn: () => api('/admin/categories') }); const act = useAct(); const [n, setN] = useState({ name: '', slug: '', parent_id: '', is_restricted: false });
  if (q.isLoading) return <State kind="loading" />;
  const items: any[] = q.data.items; const roots = items.filter((c) => !c.parent_id);
  const move = (list: any[], i: number, d: number) => { const o = list.map((c) => c.id); const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; return act(() => api('/admin/categories-order', { method: 'PUT', body: { order: o } }), 'Reordered', ['acats', 'cats']); };
  const row = (c: any, list: any[], i: number, child = false) => <tr key={c.id}><td style={{ paddingLeft: child ? 28 : 8 }}><b>{c.name}</b> <span className="muted sm">/{c.slug}</span> {c.is_restricted && <span className="pill a">restricted</span>} {!c.is_active && <span className="pill r">disabled</span>}</td><td>{c.listing_count}</td>
    <td><div className="row"><button className="btn sm soft" aria-label="Move up" onClick={() => move(list, i, -1)}>↑</button><button className="btn sm soft" aria-label="Move down" onClick={() => move(list, i, 1)}>↓</button>
      <button className="btn sm soft" onClick={() => act(() => api(`/admin/categories/${c.id}`, { method: 'PATCH', body: { is_active: !c.is_active } }), c.is_active ? 'Disabled' : 'Enabled', ['acats', 'cats'])}>{c.is_active ? 'Disable' : 'Enable'}</button>
      <button className="btn sm soft" onClick={() => act(() => api(`/admin/categories/${c.id}`, { method: 'PATCH', body: { is_restricted: !c.is_restricted } }), 'Updated', ['acats', 'cats'])}>{c.is_restricted ? 'Unrestrict' : 'Restrict'}</button></div></td></tr>;
  return <><form className="card pad row wrap" style={{ marginBottom: 14 }} onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('/admin/categories', { body: { name: n.name, slug: n.slug, parent_id: n.parent_id || null, is_restricted: n.is_restricted } }), 'Category added', ['acats', 'cats'])) setN({ name: '', slug: '', parent_id: '', is_restricted: false }); }}>
    <input className="input" style={{ flex: 1, minWidth: 140 }} aria-label="Name" placeholder="Name" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value, slug: n.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} required />
    <input className="input" style={{ flex: 1, minWidth: 120 }} aria-label="Slug" placeholder="slug" value={n.slug} onChange={(e) => setN({ ...n, slug: e.target.value })} required />
    <select className="input" style={{ width: 'auto' }} aria-label="Parent" value={n.parent_id} onChange={(e) => setN({ ...n, parent_id: e.target.value })}><option value="">Top level</option>{roots.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
    <label className="row sm"><input type="checkbox" checked={n.is_restricted} onChange={(e) => setN({ ...n, is_restricted: e.target.checked })} /> Restricted</label><button className="btn">Add</button></form>
    <table className="table"><thead><tr><th>Category</th><th>Listings</th><th /></tr></thead><tbody>{roots.flatMap((c, i) => { const kids = items.filter((k) => k.parent_id === c.id); return [row(c, roots, i), ...kids.map((k, j) => row(k, kids, j, true))]; })}</tbody></table></>;
}

function Config() {
  const s = useQuery({ queryKey: ['asettings'], queryFn: () => api('/admin/settings') }); const w = useQuery({ queryKey: ['awords'], queryFn: () => api('/admin/banned-words') });
  const fees = useQuery({ queryKey: ['afees'], queryFn: () => api('/admin/fee-rules'), retry: false }); const act = useAct(); const [word, setWord] = useState(''); const [sev, setSev] = useState('block'); const [edit, setEdit] = useState<Record<string, string>>({}); const [feeEdit, setFeeEdit] = useState<Record<string, { pct: string; fixed: string }>>({});
  return <div className="col">
    <div className="card pad"><h2 className="sec">Platform settings</h2>{s.data?.items.map((x: any) => <div key={x.key} className="row wrap" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}><div style={{ flex: 1, minWidth: 180 }}><b className="sm">{x.key}</b><div className="muted sm">{x.description}</div></div>
      <input className="input" style={{ width: 240 }} aria-label={x.key} value={edit[x.key] ?? JSON.stringify(x.value)} onChange={(e) => setEdit({ ...edit, [x.key]: e.target.value })} />
      <button className="btn sm" disabled={edit[x.key] === undefined} onClick={() => { let v: unknown; try { v = JSON.parse(edit[x.key]); } catch { v = edit[x.key]; } act(() => api(`/admin/settings/${x.key}`, { method: 'PUT', body: { value: v } }), 'Saved', ['asettings']).then(() => setEdit(({ [x.key]: _, ...r }) => r)); }}>Save</button></div>)}</div>
    <div className="card pad"><h2 className="sec">Banned words</h2><form className="row wrap" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('/admin/banned-words', { body: { term: word, severity: sev } }), 'Added', ['awords'])) setWord(''); }}><input className="input" style={{ flex: 1 }} aria-label="Term" placeholder="Word or phrase" value={word} onChange={(e) => setWord(e.target.value)} required minLength={2} /><select className="input" style={{ width: 'auto' }} aria-label="Severity" value={sev} onChange={(e) => setSev(e.target.value)}><option value="block">Block</option><option value="flag">Hold for review</option></select><button className="btn">Add</button></form>
      <div className="row wrap" style={{ marginTop: 10 }}>{w.data?.items.map((x: any) => <span key={x.id} className={`pill ${x.severity === 'block' ? 'r' : 'a'}`}>{x.term} · {x.severity}<button aria-label={`Remove ${x.term}`} style={{ marginLeft: 4 }} onClick={() => act(() => api(`/admin/banned-words/${x.id}`, { method: 'DELETE' }), 'Removed', ['awords'])}>✕</button></span>)}</div></div>
    <div className="card pad"><h2 className="sec">Fees &amp; commissions</h2>
      {fees.isError ? <div className="muted">Only super administrators can edit fees.</div> : fees.data?.items.map((f: any) => { const e = feeEdit[f.id] ?? { pct: String(f.percent_bps / 100), fixed: String(f.fixed_cents / 100) }; return <div key={f.id} className="row wrap" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}><b style={{ flex: 1, minWidth: 160 }}>{f.scope.replace('_', ' ')}</b>
        <label className="row sm">%<input className="input" style={{ width: 90 }} inputMode="decimal" value={e.pct} onChange={(ev) => setFeeEdit({ ...feeEdit, [f.id]: { ...e, pct: ev.target.value } })} /></label>
        <label className="row sm">$<input className="input" style={{ width: 90 }} inputMode="decimal" value={e.fixed} onChange={(ev) => setFeeEdit({ ...feeEdit, [f.id]: { ...e, fixed: ev.target.value } })} /></label>
        <button className="btn sm" onClick={() => act(() => api(`/admin/fee-rules/${f.id}`, { method: 'PUT', body: { percent_bps: Math.round(parseFloat(e.pct) * 100), fixed_cents: Math.round(parseFloat(e.fixed) * 100), active: f.active } }), 'Fee updated', ['afees'])}>Save</button></div>; })}
      <div className="muted sm" style={{ marginTop: 8 }}>Fees apply to new payments and boosts only; existing payments keep the fee they were charged. Changes are written to the audit log.</div></div></div>;
}

function Audit() {
  const q = useQuery({ queryKey: ['aaudit'], queryFn: () => api('/admin/audit') });
  if (q.isLoading) return <State kind="loading" />;
  return <table className="table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Change</th></tr></thead><tbody>{q.data.items.map((a: any) => <tr key={a.id}><td>{new Date(a.created_at).toLocaleString('en-CA')}</td><td>@{a.actor ?? 'system'}</td><td><span className="pill b">{a.action}</span></td><td className="sm muted">{a.target_type} {String(a.target_id ?? '').slice(0, 8)}</td><td className="sm" style={{ maxWidth: 260, wordBreak: 'break-word' }}>{a.after ? JSON.stringify(a.after).slice(0, 140) : ''}</td></tr>)}</tbody></table>;
}

function Appeals() {
  const q = useQuery({ queryKey: ['aappeals'], queryFn: () => api('/admin/appeals') }); const act = useAct(); const [sel, setSel] = useState<{ a: any; d: 'uphold' | 'overturn' } | null>(null);
  if (q.isLoading) return <State kind="loading" />; if (!q.data.items.length) return <State kind="empty" title="No open appeals" />;
  return <>{q.data.items.map((a: any) => <div key={a.id} className="card pad col" style={{ marginBottom: 12 }}><div className="row"><b>@{a.username}</b><span className="pill r">{a.user_status}</span><span className="sp" /><span className="muted sm">{ago(a.created_at)}</span></div><div style={{ whiteSpace: 'pre-wrap' }}>{a.message}</div>
    <div className="row"><button className="btn teal sm" onClick={() => setSel({ a, d: 'overturn' })}>Restore account</button><button className="btn soft sm" onClick={() => setSel({ a, d: 'uphold' })}>Uphold restriction</button></div></div>)}
    {sel && <Reason title="Decide appeal" cta="Confirm" onClose={() => setSel(null)} onSubmit={(reason) => act(() => api(`/admin/appeals/${sel.a.id}/decide`, { body: { decision: sel.d, reason } }), 'Decision recorded', ['aappeals', 'astats'])} />}</>;
}

// ------------------------------------------------------------------------------------------------ payments (manage.payments)
function Revenue() {
  const [days, setDays] = useState(30); const q = useQuery({ queryKey: ['arevenue', days], queryFn: () => api('/admin/revenue', { query: { days } }) });
  if (q.isLoading) return <State kind="loading" />; if (q.isError) return <State kind="error" />;
  const r = q.data; const max = Math.max(1, ...r.by_day.map((d: any) => d.net_fees_cents));
  return <div className="col">
    <div className="row">{[7, 30, 90].map((d) => <button key={d} className={`pill ${days === d ? 'b' : ''}`} onClick={() => setDays(d)}>{d} days</button>)}</div>
    <div className="kpis">{([['Card volume', cash(r.gross_cents)], ['Platform fees', cash(r.platform_fees_cents)], ['Fees returned on refunds', cash(r.fees_returned_cents)], ['Net revenue', cash(r.net_platform_revenue_cents)], ['Refunded to buyers', cash(r.refunded_cents)], ['Payments', String(r.payments)], ['Open disputes', String(r.open_disputes)], ['Failed refunds', String(r.failed_refunds)]] as [string, string][]).map(([l, v]) => <div key={l} className="kpi"><span>{l}</span><b>{v}</b></div>)}</div>
    <h2 className="sec">Net fees by source</h2>
    <table className="table"><thead><tr><th>Source</th><th>Payments</th><th>Volume</th><th>Net fees</th></tr></thead><tbody>{r.by_scope.map((s: any) => <tr key={s.scope}><td>{String(s.scope).replace(/_/g, ' ')}</td><td>{s.payments}</td><td>{cash(s.gross_cents)}</td><td>{cash(s.net_fees_cents)}</td></tr>)}{!r.by_scope.length && <tr><td colSpan={4} className="muted">No paid activity in this period.</td></tr>}</tbody></table>
    {r.by_day.length > 0 && <div className="card pad"><div className="row" style={{ alignItems: 'flex-end', gap: 4, height: 90 }} role="img" aria-label="Net fees per day">{r.by_day.map((d: any) => <div key={d.day} title={`${String(d.day).slice(0, 10)}: ${cash(d.net_fees_cents)}`} style={{ flex: 1, minWidth: 4, background: 'var(--blue)', borderRadius: 4, height: `${Math.max(4, (d.net_fees_cents / max) * 100)}%` }} />)}</div></div>}
    <div className="muted sm">{r.note} Figures come from payments recorded by webhook; reconcile against your Stripe dashboard before relying on them for accounting.</div></div>;
}

function Payments() {
  const [status, setStatus] = useState(''); const q = useQuery({ queryKey: ['apayments', status], queryFn: () => api('/admin/payments', { query: { status } }) }); const act = useAct(); const [sel, setSel] = useState<any>(null);
  return <div className="col"><div className="row wrap">{['', 'succeeded', 'partially_refunded', 'refunded', 'failed', 'requires_payment'].map((s) => <button key={s} className={`pill ${status === s ? 'b' : ''}`} onClick={() => setStatus(s)}>{s ? s.replace('_', ' ') : 'all'}</button>)}</div>
    {q.isLoading ? <State kind="loading" /> : !q.data.items.length ? <State kind="empty" title="No payments" /> :
      <table className="table"><thead><tr><th>When</th><th>Type</th><th>Payer → payee</th><th>Amount</th><th>Fee</th><th>Status</th><th /></tr></thead><tbody>{q.data.items.map((p: any) => <tr key={p.id}><td>{ago(p.created_at)}</td><td>{p.kind}</td><td>@{p.payer}{p.payee ? ` → @${p.payee}` : ''}</td><td>{cash(p.amount_cents)}{p.refunded_cents > 0 && <div className="muted sm">−{cash(p.refunded_cents)}</div>}</td><td>{cash(p.fee_cents)}</td><td><span className="pill b">{p.status.replace('_', ' ')}</span>{p.failure_reason && <div className="muted sm">{p.failure_reason}</div>}</td>
        <td>{['succeeded', 'partially_refunded'].includes(p.status) && p.refunded_cents < p.amount_cents && <button className="btn sm danger" onClick={() => setSel(p)}>Refund</button>}</td></tr>)}</tbody></table>}
    {sel && <Reason title={`Refund ${cash(sel.amount_cents - sel.refunded_cents)}`} cta="Refund in full" onClose={() => setSel(null)} onSubmit={(reason) => act(() => api(`/payments/${sel.id}/refund`, { body: { reason } }), 'Refund issued', ['apayments', 'arevenue'])} />}</div>;
}

function Disputes() {
  const [st, setSt] = useState<'open' | 'resolved' | 'withdrawn'>('open'); const q = useQuery({ queryKey: ['adisputes', st], queryFn: () => api('/admin/disputes', { query: { status: st } }) });
  const [sel, setSel] = useState<any>(null); const act = useAct(); const detail = useQuery({ queryKey: ['adispute', sel?.id], queryFn: () => api(`/disputes/${sel.id}`), enabled: !!sel });
  const [res, setRes] = useState('refund_partial'); const [amt, setAmt] = useState(''); const [note, setNote] = useState(''); const [msg, setMsg] = useState('');
  return <div className="col"><div className="row">{(['open', 'resolved', 'withdrawn'] as const).map((s) => <button key={s} className={`pill ${st === s ? 'b' : ''}`} onClick={() => setSt(s)}>{s}</button>)}</div>
    {q.isLoading ? <State kind="loading" /> : !q.data.items.length ? <State kind="empty" title={`No ${st} disputes`} /> : q.data.items.map((d: any) => <div key={d.id} className="card pad row" style={{ cursor: 'pointer' }} onClick={() => { setSel(d); setNote(''); setAmt(''); }}><div style={{ flex: 1 }}><b>{d.subject.title}</b><div className="muted sm">{d.reason.replace('_', ' ')} · @{d.opened_by.username} vs @{d.other_party.username} · {ago(d.created_at)}</div></div><span className="pill a">{d.status}</span></div>)}
    {sel && <Modal onClose={() => setSel(null)} title="Review dispute"><div className="col">
      {detail.isLoading ? <State kind="loading" /> : detail.data && <>
        <div className="sm"><b>{detail.data.subject.title}</b> · {detail.data.reason.replace('_', ' ')}</div><div style={{ whiteSpace: 'pre-wrap' }} className="sm">{detail.data.description}</div>
        {detail.data.messages.map((m: any) => <div key={m.id} className="card pad sm" style={{ background: m.staff ? '#EEF3FF' : undefined }}><b>{m.staff ? 'Staff' : `@${m.author.username}`}</b> · {m.body}</div>)}
        {detail.data.status === 'open' && <>
          <div className="row"><input className="input" aria-label="Message to both parties" placeholder="Message both parties" value={msg} onChange={(e) => setMsg(e.target.value)} /><button className="btn sm soft" disabled={!msg.trim()} onClick={async () => { if (await act(() => api(`/disputes/${sel.id}/messages`, { body: { body: msg.trim() } }), 'Sent', ['adispute'])) setMsg(''); }}>Send</button></div>
          <div className="field"><label htmlFor="rs2">Decision</label><select id="rs2" className="input" value={res} onChange={(e) => setRes(e.target.value)}><option value="refund_full">Full refund</option><option value="refund_partial">Partial refund</option><option value="no_refund">No refund</option></select></div>
          {res === 'refund_partial' && <div className="field"><label htmlFor="am">Refund amount (CAD)</label><input id="am" className="input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /></div>}
          <div className="field"><label htmlFor="nt">Note (shown to both parties, kept in the audit log)</label><textarea id="nt" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <button className="btn" disabled={note.trim().length < 5 || (res === 'refund_partial' && !(parseFloat(amt) > 0))} onClick={async () => { if (await act(() => api(`/admin/disputes/${sel.id}/resolve`, { body: { resolution: res, note: note.trim(), ...(res === 'refund_partial' ? { refund_cents: Math.round(parseFloat(amt) * 100) } : {}) } }), 'Dispute resolved', ['adisputes', 'apayments', 'arevenue'])) setSel(null); }}>Resolve</button></>}</>}
    </div></Modal>}</div>;
}

function Boosts() {
  const q = useQuery({ queryKey: ['aboosts'], queryFn: () => api('/admin/boosts') }); const act = useAct(); const [sel, setSel] = useState<any>(null);
  if (q.isLoading) return <State kind="loading" />; if (!q.data.items.length) return <State kind="empty" title="No boosts yet" />;
  return <><table className="table"><thead><tr><th>Owner</th><th>What</th><th>Type</th><th>Status</th><th>Ends</th><th>Views</th><th /></tr></thead><tbody>{q.data.items.map((b: any) => <tr key={b.id}><td>@{b.username}</td><td>{b.target_type.replace('_', ' ')}</td><td>{b.placement}</td><td><span className="pill b">{b.status.replace('_', ' ')}</span></td><td>{b.ends_at ? new Date(b.ends_at).toLocaleDateString('en-CA') : '—'}</td><td>{b.impressions}</td><td>{['active', 'pending_payment'].includes(b.status) && <button className="btn sm danger" onClick={() => setSel(b)}>Cancel</button>}</td></tr>)}</tbody></table>
    {sel && <Reason title="Cancel boost (no refund)" cta="Cancel boost" onClose={() => setSel(null)} onSubmit={(reason) => act(() => api(`/admin/boosts/${sel.id}/cancel`, { body: { reason, refund: false } }), 'Boost cancelled', ['aboosts'])} />}</>;
}

// ------------------------------------------------------------------------------------------------ growth (view.growth)
function Growth() {
  const [days, setDays] = useState(30); const q = useQuery({ queryKey: ['agrowth', days], queryFn: () => api('/admin/growth', { query: { days } }) });
  const refs = useQuery({ queryKey: ['areferrals'], queryFn: () => api('/admin/referrals') }); const act = useAct(); const [sel, setSel] = useState<any>(null);
  if (q.isLoading) return <State kind="loading" />; if (q.isError) return <State kind="error" />;
  const g = q.data; const f = g.funnel; const pct = (n: number) => (f.signed_up ? `${Math.round((n / f.signed_up) * 100)}%` : '–'); const maxS = Math.max(1, ...g.signups.map((s: any) => s.n));
  return <div className="col">
    <div className="row">{[7, 30, 90].map((d) => <button key={d} className={`pill ${days === d ? 'b' : ''}`} onClick={() => setDays(d)}>{d} days</button>)}</div>
    <div className="kpis">{([['Daily active', g.active.dau], ['Weekly active', g.active.wau], ['Monthly active', g.active.mau], ['Pro members', g.subscriptions.active], ['Referral signups', g.referrals.signed_up], ['Referrals rewarded', g.referrals.qualified]] as [string, number][]).map(([l, v]) => <div key={l} className="kpi"><span>{l}</span><b>{v}</b></div>)}</div>
    <h2 className="sec">Signups ({g.signups.reduce((a: number, s: any) => a + s.n, 0)})</h2>
    <div className="card pad"><div className="row" style={{ alignItems: 'flex-end', gap: 3, height: 80 }} role="img" aria-label="Signups per day">{g.signups.map((s: any) => <div key={s.day} title={`${String(s.day).slice(0, 10)}: ${s.n} (${s.referred} referred)`} style={{ flex: 1, minWidth: 3, background: 'var(--blue)', borderRadius: 3, height: `${Math.max(4, (s.n / maxS) * 100)}%` }} />)}</div></div>
    <h2 className="sec">Funnel for people who joined in this period</h2>
    <table className="table"><tbody>{([['Signed up', f.signed_up], ['Posted a listing, request or journey', f.posted], ['Made an offer', f.made_offer], ['Completed a deal', f.completed_deal]] as [string, number][]).map(([l, n]) => <tr key={l}><td>{l}</td><td>{n}</td><td>{pct(n)}</td></tr>)}</tbody></table>
    <h2 className="sec">Weekly retention</h2>
    <table className="table"><thead><tr><th>Cohort (week of)</th><th>Joined</th><th>Week 1</th><th>Week 2</th><th>Week 3</th></tr></thead><tbody>{g.retention.map((r: any) => <tr key={r.cohort}><td>{String(r.cohort).slice(0, 10)}</td><td>{r.size}</td>{[r.week1, r.week2, r.week3].map((n: number, i: number) => <td key={i}>{r.size ? `${Math.round((n / r.size) * 100)}%` : '–'}</td>)}</tr>)}</tbody></table>
    <h2 className="sec">Referrals</h2>
    {refs.data?.items.length ? <table className="table"><thead><tr><th>Referrer</th><th>Friend</th><th>Status</th><th>Reward</th><th /></tr></thead><tbody>{refs.data.items.slice(0, 20).map((r: any) => <tr key={r.id}><td>@{r.referrer}</td><td>@{r.referee}</td><td><span className="pill b">{r.status.replace('_', ' ')}</span></td><td>{cash(r.reward_cents)}</td><td>{r.status !== 'rejected' && <button className="btn sm danger" onClick={() => setSel(r)}>Reject</button>}</td></tr>)}</tbody></table> : <div className="muted">No referrals yet.</div>}
    {sel && <Reason title="Reject referral (reward is taken back)" cta="Reject" onClose={() => setSel(null)} onSubmit={(reason) => act(() => api(`/admin/referrals/${sel.id}/reject`, { body: { reason } }), 'Referral rejected', ['areferrals', 'agrowth'])} />}
    <div className="col sm muted">{g.notes.map((n: string) => <div key={n}>{n}</div>)}</div></div>;
}

export function Admin() {
  const { me } = useAuth(); const p = me?.permissions ?? [];
  if (!p.length) return <Navigate to="/" replace />;
  const tabs: [string, string, boolean][] = [['', 'Overview', p.includes('view.analytics')], ['reports', 'Reports', p.includes('moderate.content')], ['listings', 'Listing review', p.includes('moderate.content')], ['users', 'Users', p.includes('manage.users')], ['appeals', 'Appeals', p.includes('manage.users')], ['categories', 'Categories', p.includes('manage.categories')], ['config', 'Config', p.includes('manage.settings')], ['audit', 'Audit log', p.includes('view.audit')], ['payments', 'Payments', p.includes('manage.payments')], ['disputes', 'Disputes', p.includes('manage.payments')], ['revenue', 'Revenue', p.includes('manage.payments')], ['boosts', 'Boosts', p.includes('manage.payments')], ['growth', 'Growth', p.includes('view.growth')]];
  const first = tabs.find((t) => t[2])?.[0] ?? '';
  return (
    <main className="main wide"><h1 className="page">Admin</h1>
      <div className="tabs" role="tablist">{tabs.filter((t) => t[2]).map(([to, l]) => <NavLink key={to} end to={`/admin/${to}`} className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>{l}</NavLink>)}</div>
      <div style={{ padding: '0 16px', overflowX: 'auto' }}>
        <Routes>
          <Route index element={first === '' ? <Overview /> : <Navigate to={`/admin/${first}`} replace />} />
          <Route path="reports" element={<Reports />} /><Route path="listings" element={<Listings />} /><Route path="users" element={<Users />} /><Route path="appeals" element={<Appeals />} />
          <Route path="growth" element={<Growth />} /><Route path="payments" element={<Payments />} /><Route path="disputes" element={<Disputes />} /><Route path="revenue" element={<Revenue />} /><Route path="boosts" element={<Boosts />} />
          <Route path="categories" element={<Categories />} /><Route path="config" element={<Config />} /><Route path="audit" element={<Audit />} />
        </Routes>
      </div>
    </main>
  );
}
