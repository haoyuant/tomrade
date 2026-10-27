import { useEffect, useState } from "react";
import type { WindowPost } from "@tomradex/code-sessions";
import { ReplayPlayer } from "~/components/ReplayPlayer";
import { onCell, send } from "./bridge";
import { useSay } from "./say";

type ReplayPost = Extract<WindowPost, { type: "replay" }>;

/** A session's or a closed terminal's recording, asked of the window and played back in its cell. */
export function Replay({ cell, id, font, tokens }: { cell: string; id: string; font: string; tokens: Record<string, string> }) {
  const say = useSay();
  const [data, setData] = useState<ReplayPost | null>(null);

  useEffect(() => {
    setData(null);
    const off = onCell(cell, (post) => {
      if (post.type === "replay" && post.id === id) setData(post);
    });
    send({ type: "replay", cell, id });
    return off;
  }, [cell, id]);

  return <ReplayPlayer data={data} font={font} themeKey={tokens} say={say} />;
}
