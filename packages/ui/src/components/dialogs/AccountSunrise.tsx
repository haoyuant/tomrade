import { useEffect, useRef, useState } from "react";
import "./account-sunrise.css";

/* The Sunrise (晨曦) theme's dawn: a gold sun coming up behind the logo out of a lilac sky,
   with soft rays that start at a ring around it and run out to the window edge, narrowing
   as they go and fading from gold into the sky. Broad wedges that widen from the centre
   would read as the Rising Sun flag. */
const RAY_COUNT = 36;
const RAY_BASE = 128;
/** Each ray emerges from transparency over this stretch past its base instead of starting with a cut edge. */
const RAY_FADE_IN = 110;
/** Past the corners of a 4K-wide window; account-sunrise.css sizes the ray layer to match. */
const RAY_REACH = 1600;

/** Logo-centred units: the logo spans -100..100. */
function rays(spec: (i: number) => [baseHalfWidth: number, tipHalfWidth: number] | undefined) {
  const n = (v: number) => v.toFixed(1);
  let d = "";
  for (let i = 0; i < RAY_COUNT; i++) {
    const ray = spec(i);
    if (!ray) continue;
    const [base, tip] = ray;
    const angle = (i / RAY_COUNT) * 2 * Math.PI - Math.PI / 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    const at = (r: number, half: number) => `${n(r * c - half * s)} ${n(r * s + half * c)}`;
    d += `M${at(RAY_BASE, base)}L${at(RAY_REACH, tip)}L${at(RAY_REACH, -tip)}L${at(RAY_BASE, -base)}Z`;
  }
  return d;
}
const WIDE_RAYS = rays(i => i % 2 ? undefined : [10, 5]);
const NARROW_RAYS = rays(i => i % 2 ? [6.5, 3.2] : undefined);
const RAY_BOX = `${-RAY_REACH} ${-RAY_REACH} ${2 * RAY_REACH} ${2 * RAY_REACH}`;
const RAY_START = RAY_BASE / RAY_REACH;
const RAY_FULL = (RAY_BASE + RAY_FADE_IN) / RAY_REACH;
// The glint is masked by the rays rather than clipped inside the SVG, so turning and
// glinting both stay compositor transforms instead of repainting the window each frame.
const RAY_MASK = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${RAY_BOX}"><radialGradient id="g" r="${RAY_REACH}" cx="0" cy="0" gradientUnits="userSpaceOnUse"><stop offset="${RAY_START}" stop-opacity="0"/><stop offset="${RAY_FULL}"/></radialGradient><path fill="url(#g)" d="${WIDE_RAYS}${NARROW_RAYS}"/></svg>`)}")`;

/** Full-window scenery. The sky clips the sun as it rises over the horizon. */
export function AccountSunrise() {
  const cat = useRef<HTMLImageElement>(null);
  const [ready, setReady] = useState(false);
  // The entrance is timed from its start, and the red sun follows the cat: started before a slow
  // load or decode of the cat, the sun would come up alone. A cat that never loads still lets it play.
  useEffect(() => {
    let live = true;
    cat.current?.decode().catch(() => {}).finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);
  return <div className={ready ? "account-sunrise is-ready" : "account-sunrise"} aria-hidden="true">
    <div className="account-sunrise__dust" />
    <div className="account-sunrise__sky">
      <div className="account-sunrise__sun">
        <div className="account-sunrise__glow" />
        <div className="account-sunrise__rays">
          <svg viewBox={RAY_BOX}>
            <defs>
              <radialGradient id="account-sun-wide" r={RAY_REACH} cx="0" cy="0" gradientUnits="userSpaceOnUse">
                <stop offset={RAY_START} stopColor="#f2a43a" stopOpacity="0" />
                <stop offset={RAY_FULL} stopColor="#f2a43a" stopOpacity=".4" />
                <stop offset=".38" stopColor="#f6bc72" stopOpacity=".2" />
                <stop offset="1" stopColor="#b9a8ec" stopOpacity=".14" />
              </radialGradient>
              <radialGradient id="account-sun-narrow" r={RAY_REACH} cx="0" cy="0" gradientUnits="userSpaceOnUse">
                <stop offset={RAY_START} stopColor="#ffc879" stopOpacity="0" />
                <stop offset={RAY_FULL} stopColor="#ffc879" stopOpacity=".38" />
                <stop offset=".38" stopColor="#ffd9a0" stopOpacity=".17" />
                <stop offset="1" stopColor="#c9bcf0" stopOpacity=".1" />
              </radialGradient>
            </defs>
            <path d={WIDE_RAYS} fill="url(#account-sun-wide)" />
            <path d={NARROW_RAYS} fill="url(#account-sun-narrow)" />
          </svg>
          <div className="account-sunrise__glint" style={{ maskImage: RAY_MASK }}><i /></div>
        </div>
        <svg className="account-sunrise__disk" viewBox="-125 -125 250 250">
          <defs>
            <radialGradient id="account-sun-disk" r="125" cx="0" cy="-20" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffe9b0" />
              <stop offset=".5" stopColor="#f2a43a" />
              <stop offset="1" stopColor="#e0482c" />
            </radialGradient>
          </defs>
          <circle r="124" fill="none" stroke="#f2a43a" strokeOpacity=".35" strokeWidth="1.2" />
          <circle r="116" fill="none" stroke="#e0482c" strokeOpacity=".4" strokeWidth="2" />
          <circle r="110" fill="url(#account-sun-disk)" opacity=".9" />
        </svg>
        <img ref={cat} src={`${import.meta.env.BASE_URL}logo.png`} alt="" draggable={false} />
      </div>
    </div>
    <svg className="account-sunrise__sea" viewBox="0 0 1000 150" preserveAspectRatio="none">
      <path className="account-sunrise__wave account-sunrise__wave--back" d="M-200 30 Q-100 8 0 30 T200 30 T400 30 T600 30 T800 30 T1000 30 T1200 30 V150 H-200Z" />
      <path className="account-sunrise__wave account-sunrise__wave--front" d="M-200 66 Q-100 44 0 66 T200 66 T400 66 T600 66 T800 66 T1000 66 T1200 66 V150 H-200Z" />
    </svg>
  </div>;
}
