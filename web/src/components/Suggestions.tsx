import { BookMarked, ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import type { Citation, Suggestion } from "../lib/types.ts";
import { Badge } from "./ui.tsx";

const METHOD: Record<Suggestion["method"], { label: string; tone: "blue" | "violet" | "amber" }> = {
  ANSWER_BANK: { label: "from your answers", tone: "blue" },
  PAST_APPLICATION: { label: "answered before", tone: "violet" },
  AI_GROUNDED: { label: "AI draft · cited", tone: "amber" },
};

/** Retrieved suggestions with their sources. Choosing one only fills the input — you still confirm. */
export function Suggestions({ suggestions, sources, onUse }: { suggestions: Suggestion[]; sources?: Citation[]; onUse: (answer: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!suggestions.length) {
    return sources?.length ? <div className="xs muted">No suggestion from your records — nothing relevant enough was found, so the agent won't guess.</div> : null;
  }
  return (
    <div className="stack sm" aria-label="Suggested answers from your records">
      <div className="row xs muted">
        <Sparkles size={12} aria-hidden /> Suggested from your records — pick one to fill it in, then check it
      </div>
      {suggestions.map((s, i) => (
        <div key={i} style={{ border: "1px solid var(--line-2)", borderRadius: "var(--r-md)", padding: "8px 10px", background: "rgba(61,139,255,0.04)" }}>
          <div className="row between wrap">
            <div className="row wrap" style={{ gap: 6, minWidth: 0 }}>
              <span className="strong small" style={{ wordBreak: "break-word" }}>
                {s.answer}
              </span>
              <Badge tone={METHOD[s.method].tone}>{METHOD[s.method].label}</Badge>
              <span className="xs muted">{Math.round(s.confidence * 100)}%</span>
            </div>
            <div className="row">
              <button type="button" className="btn ghost sm" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                <BookMarked size={12} /> Sources <ChevronDown size={12} />
              </button>
              <button type="button" className="btn sm" onClick={() => onUse(s.answer)}>
                Use this
              </button>
            </div>
          </div>
          <div className="xs muted" style={{ marginTop: 2 }}>
            {s.note}
          </div>
          {open === i ? (
            <ul className="xs" style={{ margin: "6px 0 0", paddingLeft: 16, color: "var(--text-2)" }}>
              {s.citations.map((c) => (
                <li key={c.chunkId}>
                  <span className="strong">{c.title}</span> <span className="muted">· {c.source}</span>
                  <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
                    {c.snippet}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}
