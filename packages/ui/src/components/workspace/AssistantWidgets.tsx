import { useQuery, useMutation } from "@tanstack/react-query";
import { invoke } from "~/lib/api";
import { useErrorToast } from "~/lib/toast";

export function AssistantWidgets() {
  const errorToast = useErrorToast();
  const rows = useQuery({ queryKey: ["contributions", "assistant-widgets"], queryFn: () => invoke("contributions.assistantWidgets"), refetchInterval: 1000 });
  const action = useMutation({
    mutationFn: (command: string) => invoke("contributions.run", command, {}),
    onSuccess: () => void rows.refetch(),
    onError: errorToast
  });
  return <>{(rows.data ?? []).map(row => (
    <section key={row.id} className="assistant-widget" aria-label={row.title}>
      <div className="assistant-widget-body">
        <span className="assistant-widget-title">{row.title}</span>
        <strong className="assistant-widget-text">{row.text}</strong>
        {row.detail && <span className="assistant-widget-detail">{row.detail}</span>}
      </div>
      <div className="assistant-widget-actions">
        {(row.actions ?? []).map(a => <button key={a.command} className="btn btn-sm" disabled={action.isPending} onClick={() => action.mutate(a.command)}>{a.title}</button>)}
      </div>
      {row.progress !== undefined && <div className="assistant-widget-progress" aria-hidden="true"><div style={{ width: `${Math.max(0, Math.min(1, row.progress)) * 100}%` }} /></div>}
    </section>
  ))}</>;
}
