import { CheckCircle2, Zap } from "lucide-react";
import { useState } from "react";
import { useData } from "../lib/store.tsx";
import type { HumanTask } from "../lib/types.ts";
import { TaskCard } from "../components/TaskCard.tsx";
import { Empty, Skeleton, Tabs } from "../components/ui.tsx";

export function NeedsYou() {
  const [view, setView] = useState<"PENDING" | "ALL">("PENDING");
  const { data, loading } = useData<HumanTask[]>(`/api/tasks?status=${view}`, ["tasks"]);
  const tasks = data ?? [];
  const blocking = tasks.filter((t) => t.status === "PENDING" && t.blocking);
  const rest = tasks.filter((t) => !(t.status === "PENDING" && t.blocking));
  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1 className="page-title">Needs you</h1>
          <p className="page-sub">Everything waiting on a decision or an action only you can take.</p>
        </div>
        <Tabs value={view} onChange={setView} items={[{ id: "PENDING", label: "Pending" }, { id: "ALL", label: "History" }]} />
      </div>
      {!data && loading ? <Skeleton rows={4} height={60} /> : null}
      {data && !tasks.length ? (
        <Empty icon={view === "PENDING" ? CheckCircle2 : Zap} title={view === "PENDING" ? "Nothing needs you right now" : "No tasks yet"}>
          {view === "PENDING" ? "When the agent hits a CAPTCHA, a new question or a decision, it appears here and in the notification bell." : "Resolved, skipped and expired tasks will be listed here."}
        </Empty>
      ) : null}
      {blocking.length ? (
        <section className="stack" aria-label="Agent is waiting">
          <div className="eyebrow">Agent is waiting on these</div>
          {blocking.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </section>
      ) : null}
      {rest.length ? (
        <section className="stack" aria-label="Other tasks">
          {blocking.length ? <div className="eyebrow">Other</div> : null}
          {rest.map((t) => (
            <TaskCard key={t.id} task={t} compact={t.status !== "PENDING"} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
