import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { KnowledgeSource } from '../lib/types';

// The copilot writes light Markdown: paragraphs, lists, tables, **bold**,
// `code`, citations like [S1] and order numbers like #12. This renders that
// subset as React elements, so model text can never inject HTML.

function inline(text: string, sources: Map<string, KnowledgeSource>, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[S\d+\](?:\s*\[S\d+\])*|(?<![\w/#])#\d+\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${n++}`;
    if (t.startsWith('**')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[S')) {
      for (const ref of t.match(/S\d+/g) ?? []) {
        const s = sources.get(ref);
        out.push(<sup key={`${k}-${ref}`} className="cite" title={s ? `${s.title}\n\n${s.content}` : ref}>{ref}</sup>);
      }
    } else out.push(<Link key={k} to={`/orders/${t.slice(1)}`}>{t}</Link>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function RichText({ text, sources }: { text: string; sources: KnowledgeSource[] }) {
  const refs = new Map(sources.map((s) => [s.ref, s]));
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${b++}`;
    if (!line.trim()) { i += 1; continue; }

    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push(
        <div key={key} className="rt-table-wrap">
          <table className="rt-table">
            <thead><tr>{head.map((h, j) => <th key={j}>{inline(h, refs, `${key}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, refs, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) items.push(re.exec(lines[i++]!)![1]!);
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={key}>{items.map((it, j) => <li key={j}>{inline(it, refs, `${key}i${j}`)}</li>)}</Tag>);
      continue;
    }

    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={key} className="rt-heading">{inline(heading[1]!, refs, key)}</p>);
      i += 1;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isTableRow(lines[i]!) && !bullet.test(lines[i]!) && !numbered.test(lines[i]!) && !/^#{1,4}\s/.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    blocks.push(<p key={key}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, refs, `${key}l${j}`)}</Fragment>)}</p>);
  }
  return <div className="rich-text">{blocks}</div>;
}
