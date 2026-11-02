import { useEffect, useRef } from "react";
import type { AccessoryAnimation } from "@tomradex/contributions";
import { PetPlayer } from "~/lib/petPlayer";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)");

/** One pet animation at a fixed CSS size, drawn at the display's pixel density. */
export function PetCanvas({ animation, width, height, label, className }: { animation: AccessoryAnimation | undefined; width: number; height: number; label: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const player = useRef<PetPlayer | null>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const motion = reducedMotion();
    const instance = new PetPlayer(canvas, () => motion.matches);
    player.current = instance;
    const replay = () => instance.replay();
    motion.addEventListener("change", replay);
    // A collapsed or scrolled-away panel and a hidden window draw nothing.
    let intersecting = true;
    const show = () => instance.show(intersecting && !document.hidden);
    const seen = new IntersectionObserver((entries) => {
      intersecting = entries.at(-1)!.isIntersecting;
      show();
    });
    seen.observe(canvas);
    document.addEventListener("visibilitychange", show);
    return () => {
      motion.removeEventListener("change", replay);
      seen.disconnect();
      document.removeEventListener("visibilitychange", show);
      instance.stop();
      player.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = ref.current!;
    canvas.width = Math.round(width * window.devicePixelRatio);
    canvas.height = Math.round(height * window.devicePixelRatio);
    player.current?.replay();
  }, [width, height]);

  useEffect(() => {
    if (animation) player.current?.play(animation);
    else player.current?.stop();
  }, [animation]);

  return <canvas ref={ref} className={className} style={{ width, height }} role="img" aria-label={label} />;
}
