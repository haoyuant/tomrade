export function Loading({ label }: { label: string }) {
  return <div className="p-8 text-sm text-slate-500 dark:text-slate-400">{label}</div>;
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="m-4 rounded border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
      {message}
    </div>
  );
}
