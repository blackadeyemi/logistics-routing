import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorAlert, Field, Modal, SkeletonRows } from '../components/ui';
import { ApiError, fieldErrors, staffApi } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import type { KnowledgeDocument, KnowledgeHit } from '../lib/types';
import { useLoad } from '../lib/useLoad';

interface Stats { documents: number; sop_chunks: number; note_chunks: number }

/**
 * Company SOPs and driver notes that the copilot searches. Admins write the
 * SOPs; anyone can try a search to see what the copilot would find.
 */
export function Knowledge() {
  const { user } = useStaffAuth();
  const isAdmin = user?.role === 'admin';
  const { data: docs, error, loading, reload } = useLoad(() => staffApi<KnowledgeDocument[]>('/knowledge/documents'), []);
  const { data: stats, reload: reloadStats } = useLoad(() => staffApi<Stats>('/knowledge/stats', { quiet: true }), []);
  const [editing, setEditing] = useState<KnowledgeDocument | 'new' | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reindex = async () => {
    setReindexing(true);
    setNotice(null);
    try {
      const r = await staffApi<{ chunks: number; documents: number; orders_with_notes: number }>('/knowledge/reindex', { method: 'POST' });
      setNotice(`Rebuilt the index: ${r.chunks} chunks from ${r.documents} SOPs and ${r.orders_with_notes} orders with driver notes.`);
      void reloadStats();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not rebuild the index');
    } finally {
      setReindexing(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Knowledge</h1>
          <p>Company procedures and drivers’ notes on stops. The copilot searches these and cites what it used.</p>
        </div>
        <div className="page-actions">
          {isAdmin && <button className="btn btn-ghost" onClick={reindex} disabled={reindexing}><Icon name="refresh" /> {reindexing ? 'Rebuilding…' : 'Rebuild index'}</button>}
          {isAdmin && <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" /> New SOP</button>}
        </div>
      </div>
      {notice && <div className="alert alert-info">{notice}</div>}

      <div className="stat-flex">
        <div className="stat-card"><div className="stat-val tone-brand">{stats?.documents ?? '–'}</div><div className="stat-lbl">SOP documents</div></div>
        <div className="stat-card"><div className="stat-val">{stats?.sop_chunks ?? '–'}</div><div className="stat-lbl">SOP sections indexed</div></div>
        <div className="stat-card"><div className="stat-val">{stats?.note_chunks ?? '–'}</div><div className="stat-lbl">Driver notes indexed</div></div>
      </div>

      <div className="knowledge-grid">
        <section className="card">
          <div className="card-head"><div><h2 className="card-title">SOP documents</h2><p className="card-sub">Write in sections with ## headings: each section becomes one searchable, citable chunk.</p></div></div>
          <ErrorAlert error={error} />
          {loading && !docs ? <SkeletonRows rows={5} /> : docs && docs.length === 0 ? (
            <EmptyState title="No SOPs yet">{isAdmin ? 'Add your first procedure, for example how riders handle cash on delivery.' : 'An admin can add company procedures here.'}</EmptyState>
          ) : (
            <ul className="doc-list">
              {docs?.map((d) => (
                <li key={d.id}>
                  <button type="button" className="doc-row" onClick={() => setEditing(d)}>
                    <Icon name="book" />
                    <span className="grow">
                      <strong>{d.title}</strong>
                      <span className="text-xs text-muted">{d.chunks} section{d.chunks === 1 ? '' : 's'} · updated {fmtDateTime(d.updated_at)}</span>
                    </span>
                    <Icon name="right" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <SearchBox />
      </div>

      {editing && (
        <DocEditor
          doc={editing === 'new' ? undefined : editing}
          canEdit={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); void reloadStats(); }}
        />
      )}
    </>
  );
}

function SearchBox() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      setHits(await staffApi<KnowledgeHit[]>('/knowledge/search', { query: { q: q.trim(), limit: 5 } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card card-pad">
      <h2 className="card-title">Try a search</h2>
      <p className="card-sub">See what the copilot finds for a question. Matches by meaning and by exact words.</p>
      <form onSubmit={run} className="flex gap-2 knowledge-search">
        <input className="form-control grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Can we deliver a cake on a bike?" />
        <button className="btn btn-primary" disabled={busy || q.trim().length < 2}><Icon name="search" /> {busy ? 'Searching…' : 'Search'}</button>
      </form>
      <ErrorAlert error={error} />
      {hits && hits.length === 0 && <p className="text-sm text-muted">Nothing found.</p>}
      {hits && hits.length > 0 && (
        <ol className="hit-list">
          {hits.map((h) => (
            <li key={h.id}>
              <div className="flex items-center gap-2">
                <Badge tone={h.source_type === 'sop' ? 'brand' : 'info'}>{h.source_type === 'sop' ? 'SOP' : 'Driver note'}</Badge>
                <strong className="grow">{h.title}</strong>
                <span className="text-xs text-muted" title="Similarity by meaning, 0 to 1">{h.similarity.toFixed(2)}</span>
              </div>
              <p className="text-sm mb-0">{h.content}</p>
              {h.order_id && <Link className="text-xs" to={`/orders/${h.order_id}`}>Open order #{h.order_id}</Link>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DocEditor({ doc, canEdit, onClose, onSaved }: { doc?: KnowledgeDocument; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(doc?.title ?? '');
  const [body, setBody] = useState(doc?.body ?? '## First section\n');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (doc) await staffApi(`/knowledge/documents/${doc.id}`, { method: 'PUT', body: { title, body } });
      else await staffApi('/knowledge/documents', { method: 'POST', body: { title, body } });
      onSaved();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!doc) return;
    try {
      await staffApi(`/knowledge/documents/${doc.id}`, { method: 'DELETE' });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    }
  };

  return (
    <Modal
      title={doc ? (canEdit ? 'Edit SOP' : doc.title) : 'New SOP'}
      onClose={onClose}
      wide
      footer={canEdit ? <>
        {doc && <button type="button" className="btn btn-ghost text-danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
        <span className="grow" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" form="doc-form" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </> : <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}
    >
      {canEdit ? (
        <form id="doc-form" onSubmit={save}>
          <ErrorAlert error={error} />
          <Field label="Title" error={errors.title}><input className="form-control" required value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Procedure" error={errors.body} hint="Start each section with ## and a short heading. Saving re-indexes it for the copilot.">
            <textarea className="form-control doc-body" rows={16} required value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          {confirmDelete && (
            <div className="alert alert-warning flex items-center gap-2">
              <span className="grow">Delete this SOP? The copilot will no longer find it.</span>
              <button type="button" className="btn btn-danger btn-sm" onClick={remove}>Delete</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Keep</button>
            </div>
          )}
        </form>
      ) : (
        <pre className="doc-read">{doc?.body}</pre>
      )}
    </Modal>
  );
}
