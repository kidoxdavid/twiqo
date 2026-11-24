import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { RequestCard } from './transport';
import { useToast } from './Toast';
import { Modal, errMsg, money } from './ui';

/** "Similar moves usually cost $80–$120": shown only when there are enough real completed deals to say so. */
export function PriceHint({ query, path }: { query: Record<string, string | undefined>; path: '/transport/price-guidance' | '/listings/price-guidance' }) {
  const ready = Object.values(query).every((v) => v !== undefined && v !== '');
  const q = useQuery({ queryKey: ['guidance', path, query], queryFn: () => api(path, { query }), enabled: ready, staleTime: 120_000 });
  if (!ready || !q.data) return null;
  if (!q.data.enough_data) return <div className="muted sm">{q.data.message}</div>;
  return <div className="card pad sm" style={{ background: '#E6FAF3' }} role="note">Similar {path === '/transport/price-guidance' ? 'moves' : 'listings'} usually go for <b>{money(q.data.low_cents)}–{money(q.data.high_cents)}</b> (typical {money(q.data.typical_cents)}). <span className="muted">Based on {q.data.samples} recent ones. {q.data.basis}.</span></div>;
}

/** Get an alert when something new matches. Appears next to filters that are actually set. */
export function SaveSearchButton({ kind, params, suggestedName }: { kind: 'listing' | 'journey' | 'request'; params: Record<string, unknown>; suggestedName: string }) {
  const { me } = useAuth(); const toast = useToast(); const qc = useQueryClient(); const [open, setOpen] = useState(false); const [name, setName] = useState(suggestedName); const [busy, setBusy] = useState(false);
  if (!me) return null;
  async function save() { setBusy(true); try { await api('/saved-searches', { body: { kind, name: name.trim(), params } }); toast('Saved. We\'ll alert you when something new matches.'); qc.invalidateQueries({ queryKey: ['saved-searches'] }); setOpen(false); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }
  return <>
    <button type="button" className="btn sm soft" onClick={() => { setName(suggestedName); setOpen(true); }}>🔔 Alert me</button>
    {open && <Modal onClose={() => setOpen(false)} title="Save this search"><div className="col"><div className="field"><label htmlFor="ssn">Name</label><input id="ssn" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></div>
      <div className="muted sm">You'll get a notification (and an email or push if you've turned those on) when a new match is posted. Manage alerts in <Link to="/settings/notifications" style={{ color: 'var(--blue)' }}>Settings</Link>.</div>
      <button className="btn" disabled={busy || !name.trim()} onClick={save}>Save search</button></div></Modal>}
  </>;
}

export function ReturnSuggestions({ journeyId }: { journeyId: string }) {
  const q = useQuery({ queryKey: ['return', journeyId], queryFn: () => api(`/transport/journeys/${journeyId}/return-suggestions`), staleTime: 120_000 });
  if (!q.data) return null;
  return <section className="col"><h2 className="sec">Heading back? Shipments going your way home</h2>
    {q.data.requests.length === 0 ? <div className="muted sm">No open shipments match the return trip yet. <Link to={`/create/journey?from=${encodeURIComponent(q.data.suggested_journey.origin_city)}&to=${encodeURIComponent(q.data.suggested_journey.dest_city)}`} style={{ color: 'var(--blue)' }}>Post your return journey</Link> so people can find you.</div>
      : q.data.requests.map((r: any) => <RequestCard key={r.id} r={r} />)}</section>;
}

// ------------------------------------------------------------------------------------------------ bulk upload (businesses)
const COLS = ['title', 'description', 'price', 'category_slug', 'condition', 'quantity', 'city', 'tags'];
/** Small RFC-4180-ish CSV reader (quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let cur: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { cur.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; cur.push(cell); cell = ''; if (cur.some((x) => x.trim())) rows.push(cur); cur = []; } else cell += c; }
  cur.push(cell); if (cur.some((x) => x.trim())) rows.push(cur);
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([, v]) => v !== '')));
}
export function BulkUpload({ businessId }: { businessId: string }) {
  const toast = useToast(); const qc = useQueryClient(); const [open, setOpen] = useState(false); const [rows, setRows] = useState<Record<string, string>[]>([]); const [res, setRes] = useState<any>(null); const [busy, setBusy] = useState(false);
  async function pick(f: File | null) { if (!f) return; const parsed = parseCsv(await f.text()); setRows(parsed); setRes(null); if (parsed.length) try { setRes(await api(`/businesses/${businessId}/listings/bulk`, { body: { rows: parsed, dry_run: true } })); } catch (e) { toast(errMsg(e), 'err'); } }
  async function commit() { setBusy(true); try { const r = await api(`/businesses/${businessId}/listings/bulk`, { body: { rows } }); setRes(r); toast(`${r.created} listing${r.created === 1 ? '' : 's'} created`); qc.invalidateQueries(); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); } }
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(`${COLS.join(',')}\nOak dining table,Solid oak seats six,450,furniture,good,1,Calgary,"oak;table"\n`)}`;
  return <>
    <button className="btn soft" onClick={() => setOpen(true)}>Bulk upload (CSV)</button>
    {open && <Modal onClose={() => setOpen(false)} title="Bulk upload listings"><div className="col">
      <div className="sm">Upload a CSV with these columns: <code>{COLS.join(', ')}</code>. Up to 200 rows at a time. Prices are in dollars; separate tags with ;. <a href={template} download="twiqo-listings-template.csv" style={{ color: 'var(--blue)' }}>Download a template</a></div>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      {res && <><div className="card pad sm"><b>{res.dry_run ? 'Preview' : 'Done'}:</b> {res.dry_run ? `${res.valid} ready, ${res.invalid} with problems` : `${res.created} created, ${res.invalid} skipped`}</div>
        <div style={{ maxHeight: 220, overflow: 'auto' }}>{res.results.map((r: any) => <div key={r.row} className="row sm" style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}><span style={{ width: 40 }}>#{r.row}</span><span style={{ flex: 1 }}>{r.title ?? '(no title)'}{r.errors.length > 0 && <div className="err">{r.errors.join('; ')}</div>}</span><span className={`pill ${r.ok ? (r.status === 'pending_review' ? 'a' : 't') : 'r'}`}>{r.ok ? (r.status === 'pending_review' ? 'needs review' : 'ok') : 'error'}</span></div>)}</div>
        {res.dry_run && res.valid > 0 && <button className="btn" disabled={busy} onClick={commit}>Create {res.valid} listing{res.valid === 1 ? '' : 's'}</button>}</>}
    </div></Modal>}
  </>;
}
