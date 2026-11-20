import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Badge } from '../components/ui';
import { ApiError, staffApi, staffStream } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { fmtDay } from '../lib/format';
import type { AgentAction, Conversation, CopilotItem, KnowledgeSource } from '../lib/types';
import { RichText } from './RichText';

const CONV_KEY = 'lr_copilot_conversation';
const SUGGESTIONS = [
  'Plan today’s routes for the unassigned orders',
  'Which orders are still unassigned?',
  'A customer can’t pay the full amount. What should the rider do?',
  'What’s the gate code for the Okon family in Lekki?',
];

function readConv(): number | null {
  try {
    const v = Number(localStorage.getItem(CONV_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function saveConv(id: number | null) {
  try {
    if (id) localStorage.setItem(CONV_KEY, String(id)); else localStorage.removeItem(CONV_KEY);
  } catch { /* not remembered */ }
}

/** Slide-over chat with the dispatch copilot. */
export function CopilotPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useStaffAuth();
  const [conversationId, setConversationId] = useState<number | null>(readConv);
  const [items, setItems] = useState<CopilotItem[]>([]);
  const [actions, setActions] = useState<Record<number, AgentAction>>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load the saved conversation the first time the panel opens.
  const loaded = useRef(false);
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    if (!conversationId) return;
    staffApi<Conversation>(`/ai/conversations/${conversationId}`, { quiet: true })
      .then((c) => {
        setItems(c.display);
        setActions(Object.fromEntries(c.actions.map((a) => [a.id, a])));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) { setConversationId(null); saveConv(null); } else setLoadError('Could not load the last conversation.');
      });
  }, [open, conversationId]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, actions]);

  const sources = useMemo(() => items.flatMap((it) => (it.type === 'sources' ? it.items : [])), [items]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    setNotConfigured(false);
    setItems((s) => [...s, { type: 'user', text: message }]);
    const ctl = new AbortController();
    abort.current = ctl;
    // Text deltas extend the last assistant item, or start one.
    const appendText = (delta: string) => setItems((s) => {
      const last = s[s.length - 1];
      if (last?.type === 'assistant') return [...s.slice(0, -1), { ...last, text: last.text + delta }];
      return [...s, { type: 'assistant', text: delta }];
    });
    try {
      await staffStream('/ai/chat', { conversation_id: conversationId ?? undefined, message }, (e) => {
        switch (e.type) {
          case 'start':
            setConversationId(e.conversation_id as number);
            saveConv(e.conversation_id as number);
            break;
          case 'text':
            appendText(e.delta as string);
            break;
          case 'tool': {
            const t = e as unknown as Extract<CopilotItem, { type: 'tool' }>;
            setItems((s) => {
              const idx = s.findIndex((it) => it.type === 'tool' && it.id === t.id);
              if (idx >= 0) return s.map((it, j) => (j === idx ? { ...t, type: 'tool' } : it));
              return [...s, { ...t, type: 'tool' }];
            });
            break;
          }
          case 'proposal': {
            const a = e.action as AgentAction;
            setActions((m) => ({ ...m, [a.id]: a }));
            setItems((s) => [...s, { type: 'proposal', action_id: a.id }]);
            break;
          }
          case 'sources':
            setItems((s) => [...s, { type: 'sources', items: e.items as KnowledgeSource[] }]);
            break;
          case 'error':
            setItems((s) => [...s, { type: 'error', message: e.message as string }]);
            break;
          default:
        }
      }, ctl.signal);
    } catch (err) {
      const code = err instanceof ApiError ? (err.details as { code?: string } | undefined)?.code : undefined;
      if (code === 'not_configured') setNotConfigured(true);
      setItems((s) => [...s, { type: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' }]);
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }, [busy, conversationId]);

  const newChat = () => {
    abort.current?.abort();
    setConversationId(null);
    saveConv(null);
    setItems([]);
    setActions({});
  };

  const decide = async (a: AgentAction, decision: 'confirm' | 'reject') => {
    setActions((m) => ({ ...m, [a.id]: { ...a, status: decision === 'confirm' ? 'confirmed' : 'rejected', result: { message: 'Working…' } } }));
    try {
      const updated = await staffApi<AgentAction>(`/ai/actions/${a.id}/${decision}`, { method: 'POST' });
      setActions((m) => ({ ...m, [a.id]: updated }));
      window.dispatchEvent(new CustomEvent('data:changed'));
    } catch (err) {
      setActions((m) => ({ ...m, [a.id]: { ...a, result: { error: err instanceof ApiError ? err.message : 'Could not reach the server' } } }));
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <>
      <div className={`copilot-backdrop${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`copilot${open ? ' open' : ''}`} aria-label="Dispatch copilot" aria-hidden={!open}>
        <header className="copilot-head">
          <span className="copilot-mark"><Icon name="sparkle" /></span>
          <div className="grow">
            <strong>Copilot</strong>
            <span>Looks things up and proposes changes. You confirm each one.</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={newChat} title="Start a new conversation"><Icon name="plus" /> New</button>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close copilot"><Icon name="close" /></button>
        </header>

        <div className="copilot-body" ref={scroller}>
          {loadError && <div className="alert alert-warning">{loadError}</div>}
          {items.length === 0 && (
            <div className="copilot-empty">
              <p>Ask about today’s orders, routes and drivers, or company procedures. Changes come back as proposals for you to confirm.</p>
              <div className="copilot-suggestions">
                {SUGGESTIONS.map((s) => <button key={s} type="button" className="btn btn-ghost btn-sm" onClick={() => void send(s)}>{s}</button>)}
              </div>
            </div>
          )}
          {items.map((it, i) => {
            if (it.type === 'user') return <div key={i} className="msg msg-user">{it.text}</div>;
            if (it.type === 'assistant') return <div key={i} className="msg msg-assistant"><RichText text={it.text} sources={sources} /></div>;
            if (it.type === 'tool') {
              return (
                <div key={i} className={`msg-tool ${it.status}`}>
                  <Icon name={it.status === 'error' ? 'alert' : it.status === 'done' ? 'check' : 'refresh'} size={13} />
                  <span>{it.label}{it.status === 'running' ? '…' : ''}</span>
                  {it.detail && <span className="text-muted"> · {it.detail}</span>}
                </div>
              );
            }
            if (it.type === 'proposal') {
              const a = actions[it.action_id];
              return a ? <ProposalCard key={i} action={a} onDecide={decide} /> : null;
            }
            if (it.type === 'sources') {
              return (
                <details key={i} className="msg-sources">
                  <summary>Sources ({it.items.length})</summary>
                  <ul>
                    {it.items.map((s) => (
                      <li key={s.ref}>
                        <span className="cite">{s.ref}</span>
                        <span><strong>{s.title}</strong>{s.order_id && <> · <Link to={`/orders/${s.order_id}`}>order #{s.order_id}</Link></>}</span>
                        <span className="text-xs text-muted">{s.content}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            }
            return <div key={i} className="alert alert-error">{it.message}</div>;
          })}
          {busy && items[items.length - 1]?.type === 'user' && <div className="msg-tool running"><Icon name="refresh" size={13} /> Thinking…</div>}
          {notConfigured && (
            <p className="text-sm">{user?.role === 'admin' ? <>Add an Anthropic key and pick a model on <Link to="/settings" onClick={onClose}>Settings</Link>.</> : 'Ask an admin to set up the AI key on the Settings page.'}</p>
          )}
        </div>

        <form className="copilot-input" onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="form-control"
            rows={2}
            maxLength={4000}
            placeholder="Ask the copilot… (Enter to send, Shift+Enter for a new line)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            disabled={busy}
          />
          {busy
            ? <button type="button" className="btn btn-ghost" onClick={() => abort.current?.abort()}>Stop</button>
            : <button type="submit" className="btn btn-primary" disabled={!input.trim()}><Icon name="send" /> Send</button>}
        </form>
      </aside>
    </>
  );
}

const STATUS: Record<AgentAction['status'], { tone: string; label: string }> = {
  proposed: { tone: 'warning', label: 'Waiting for you' },
  confirmed: { tone: 'success', label: 'Applied' },
  rejected: { tone: 'muted', label: 'Rejected' },
  failed: { tone: 'danger', label: 'Failed' },
};

function ProposalCard({ action: a, onDecide }: { action: AgentAction; onDecide: (a: AgentAction, d: 'confirm' | 'reject') => void }) {
  const s = STATUS[a.status];
  const stops = a.preview?.stops;
  const routes = a.preview?.routes;
  return (
    <div className={`proposal ${a.status}`}>
      <div className="proposal-head">
        <span className="proposal-kind">Proposed change #{a.id}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="proposal-summary">{a.summary}</p>
      {stops && (
        <ol className="proposal-stops">
          {stops.map((st) => (
            <li key={st.stop_id}>
              <span className={`stop-type ${st.type}`}>{st.type}</span>
              <span className="grow">{st.address}</span>
              <span className="text-xs text-muted">#{st.order_id} {st.customer}</span>
            </li>
          ))}
        </ol>
      )}
      {routes && (
        <ul className="proposal-routes">
          {routes.map((r) => (
            <li key={r.driver}>
              <strong>{r.driver}</strong> <span className="text-xs text-muted">{r.vehicle}</span>
              <span className="text-xs"> · {r.stops} stops · {r.km} km · orders {r.orders.map((o) => `#${o}`).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      {a.preview?.run_id && <p className="text-xs mb-0"><Link to={`/routes/optimize?date=${a.preview.route_date}`}>Compare in detail on the Optimize page</Link></p>}
      {a.preview?.route_date && <p className="text-xs text-muted mb-0">For {fmtDay(a.preview.route_date)}</p>}
      {a.result?.message && a.status !== 'proposed' && <p className="text-sm mb-0">{a.result.message}{a.result.route_id ? <> · <Link to={`/routes/${a.result.route_id}`}>open route</Link></> : a.result.order_id ? <> · <Link to={`/orders/${a.result.order_id}`}>open order</Link></> : null}</p>}
      {a.result?.error && <p className="text-sm text-danger mb-0">{a.result.error}</p>}
      {a.status === 'proposed' && (
        <div className="proposal-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onDecide(a, 'confirm')}><Icon name="check" /> Confirm</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDecide(a, 'reject')}>Reject</button>
        </div>
      )}
    </div>
  );
}
