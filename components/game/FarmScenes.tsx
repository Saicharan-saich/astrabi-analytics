import React from 'react';
import type { SceneKey } from './farmStory';

// ═══════════════════════════════════════════════════════════════════
// FOXGLOVE FARM — the animated scenes for story mode.
//
// Everything here is hand-built vector art. The app runs offline and
// keeps data on the device, so nothing is fetched from an image host —
// which also means the motion has to be CSS on SVG, not video.
// ═══════════════════════════════════════════════════════════════════

export const FARM = {
  cream: '#FFF8EC',
  sun: '#FFCE54',
  honey: '#E9A11B',
  amber: '#D98324',
  barn: '#C0563E',
  barnDark: '#8E3B2B',
  wood: '#A9784F',
  woodDark: '#7C5433',
  soil: '#B07A52',
  soilDark: '#8A5A38',
  leaf: '#5C8F4A',
  leafMid: '#7FB069',
  leafFar: '#A8C99A',
  night: '#2C3E56',
  slate: '#5A6B7D',
  frost: '#DCE7EF',
  denim: '#3E5F7E',
  skin: '#E8B98C',
} as const;

// ── Motion ─────────────────────────────────────────────────────────
// Scoped to .fs- classes and shipped inside each <svg>, so the scenes
// stay self-contained and never touch the Tailwind build.

const MOTION = `
/* transform-box goes on the animated element only. Setting it globally would
   also re-anchor every SVG transform="" attribute, which silently collapses
   things like the sun's rays into a blob at their own centres. */
@keyframes fs-drift   { from { transform: translateX(-40px) } to { transform: translateX(860px) } }
@keyframes fs-bob     { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2.5px) } }
@keyframes fs-breathe { 0%,100% { transform: translateY(0) scale(1) } 50% { transform: translateY(-1.2px) scale(1.012) } }
@keyframes fs-sway    { 0%,100% { transform: rotate(-2.5deg) } 50% { transform: rotate(2.5deg) } }
@keyframes fs-swaySoft{ 0%,100% { transform: rotate(-1.2deg) } 50% { transform: rotate(1.2deg) } }
@keyframes fs-blink   { 0%,94%,100% { transform: scaleY(1) } 97% { transform: scaleY(0.08) } }
@keyframes fs-rise    { from { transform: translateY(46px) } to { transform: translateY(0) } }
@keyframes fs-rays    { to { transform: rotate(360deg) } }
@keyframes fs-pulse   { 0%,100% { opacity: 0.14 } 50% { opacity: 0.30 } }
@keyframes fs-glint   { 0%,88%,100% { opacity: 0 } 94% { opacity: 0.85 } }
@keyframes fs-rain    { from { transform: translateY(-60px) } to { transform: translateY(320px) } }
@keyframes fs-fall    { from { transform: translateY(-30px) rotate(0deg) } to { transform: translateY(300px) rotate(220deg) } }
@keyframes fs-flutter { 0%,100% { transform: translateY(0) rotate(-4deg) } 50% { transform: translateY(-7px) rotate(5deg) } }
@keyframes fs-peck    { 0%,60%,100% { transform: rotate(0deg) } 75% { transform: rotate(24deg) } }
@keyframes fs-spin    { to { transform: rotate(360deg) } }
@keyframes fs-twinkle { 0%,100% { opacity: .3 } 50% { opacity: 1 } }
@keyframes fs-steam   { 0% { transform: translateY(0) scale(.7); opacity: 0 } 25% { opacity: .5 } 100% { transform: translateY(-26px) scale(1.5); opacity: 0 } }
@keyframes fs-walk    { from { transform: translateX(0) } to { transform: translateX(560px) } }
@keyframes fs-stride  { 0%,100% { transform: rotate(15deg) } 50% { transform: rotate(-15deg) } }
@keyframes fs-lift    { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }

/* translate-only — origin is irrelevant, so these need no transform-box */
.fs-drift   { animation: fs-drift 46s linear infinite }
.fs-drift-2 { animation: fs-drift 68s linear infinite }
.fs-bob     { animation: fs-bob 3.4s ease-in-out infinite }
.fs-rise    { animation: fs-rise 4.5s cubic-bezier(.2,.7,.3,1) both }
.fs-rain    { animation: fs-rain 1.1s linear infinite }
.fs-walk    { animation: fs-walk 34s linear infinite }
.fs-lift    { animation: fs-lift 2.6s ease-in-out infinite }

/* opacity-only */
.fs-pulse   { animation: fs-pulse 5s ease-in-out infinite }
.fs-glint   { animation: fs-glint 5.5s ease-in-out infinite }
.fs-twinkle { animation: fs-twinkle 4s ease-in-out infinite }

/* rotate or scale — these need an origin inside their own box */
.fs-breathe { animation: fs-breathe 3.8s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 100% }
.fs-sway    { animation: fs-sway 4.6s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 100% }
.fs-sway-s  { animation: fs-swaySoft 6.2s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 100% }
.fs-blink   { animation: fs-blink 6s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50% }
.fs-rays    { animation: fs-rays 90s linear infinite; transform-box: fill-box; transform-origin: 50% 50% }
.fs-fall    { animation: fs-fall 9s linear infinite; transform-box: fill-box; transform-origin: 50% 50% }
.fs-flutter { animation: fs-flutter 3.2s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 100% }
.fs-peck    { animation: fs-peck 3.6s ease-in-out infinite; transform-box: fill-box; transform-origin: 20% 70% }
.fs-spin    { animation: fs-spin 2.2s linear infinite; transform-box: fill-box; transform-origin: 50% 50% }
.fs-steam   { animation: fs-steam 4s ease-out infinite; transform-box: fill-box; transform-origin: 50% 100% }
.fs-stride  { animation: fs-stride 1s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 0% }

@media (prefers-reduced-motion: reduce) {
  .fs * { animation: none !important }
}
`;

const Motion = () => <style>{MOTION}</style>;

/** Stagger helper — keeps repeated elements from moving in lockstep. */
const delay = (s: number): React.CSSProperties => ({ animationDelay: `${s}s` });

// ── Cast and props ─────────────────────────────────────────────────

type Pose = 'idle' | 'thinking' | 'carrying' | 'pointing' | 'walking';

/**
 * Sam Whitfield. Same person in every scene, so the story has a face.
 * Origin is at the feet; he stands about 78 units tall.
 */
const Sam = ({ x, y, s = 1, pose = 'idle', flip = false, className = '' }: {
  x: number; y: number; s?: number; pose?: Pose; flip?: boolean; className?: string;
}) => (
  <g transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`} className={className}>
    {/* shadow */}
    <ellipse cx="0" cy="1" rx="17" ry="4" fill="#000000" opacity="0.16" />

    <g className="fs-breathe">
      {/* legs */}
      {pose === 'walking' ? (
        <>
          <g className="fs-stride"><rect x="-9" y="-32" width="8" height="30" rx="4" fill={FARM.denim} /></g>
          <g className="fs-stride" style={{ animationDelay: '-0.5s' }}>
            <rect x="1" y="-32" width="8" height="30" rx="4" fill="#33506B" />
          </g>
        </>
      ) : (
        <>
          <rect x="-9" y="-32" width="8" height="30" rx="4" fill={FARM.denim} />
          <rect x="1" y="-32" width="8" height="30" rx="4" fill="#33506B" />
        </>
      )}
      <rect x="-11" y="-5" width="11" height="6" rx="2.5" fill={FARM.woodDark} />
      <rect x="0" y="-5" width="11" height="6" rx="2.5" fill={FARM.woodDark} />

      {/* dungarees over a checked shirt */}
      <rect x="-13" y="-56" width="26" height="28" rx="7" fill={FARM.barn} />
      <g opacity="0.35">
        <rect x="-13" y="-50" width="26" height="2.5" fill={FARM.cream} />
        <rect x="-13" y="-40" width="26" height="2.5" fill={FARM.cream} />
        <rect x="-6" y="-56" width="2.5" height="28" fill={FARM.cream} />
        <rect x="4" y="-56" width="2.5" height="28" fill={FARM.cream} />
      </g>
      <path d="M-12 -40 h24 v12 a7 7 0 0 1 -7 7 h-10 a7 7 0 0 1 -7 -7 Z" fill={FARM.denim} />
      <path d="M-9 -55 l4 -2 l2 17 h-4 Z M9 -55 l-4 -2 l-2 17 h4 Z" fill={FARM.denim} />

      {/* arms */}
      {pose === 'carrying' && (
        <>
          <path d="M-12 -52 q -10 8 -8 18" stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" fill="none" />
          <path d="M12 -52 q 10 8 8 18" stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" fill="none" />
          <circle cx="-20" cy="-33" r="4" fill={FARM.skin} />
          <circle cx="20" cy="-33" r="4" fill={FARM.skin} />
        </>
      )}
      {pose === 'thinking' && (
        <>
          <path d="M-12 -52 q -9 10 -5 19" stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" fill="none" />
          <path d="M12 -52 q 12 -4 4 -14" stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" fill="none" />
          <circle cx="15" cy="-67" r="4.2" fill={FARM.skin} />
          <circle cx="-17" cy="-32" r="4" fill={FARM.skin} />
        </>
      )}
      {pose === 'pointing' && (
        <>
          <path d="M-12 -52 q -9 10 -5 19" stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" fill="none" />
          <path d="M12 -52 q 14 -2 20 -10" stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" fill="none" />
          <circle cx="35" cy="-63" r="4.2" fill={FARM.skin} />
          <circle cx="-17" cy="-32" r="4" fill={FARM.skin} />
        </>
      )}
      {(pose === 'idle' || pose === 'walking') && (
        <>
          <g className={pose === 'walking' ? 'fs-stride' : ''} style={pose === 'walking' ? { animationDelay: '-0.5s' } : undefined}>
            <path d="M-12 -52 q -8 11 -6 20" stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" fill="none" />
          </g>
          <g className={pose === 'walking' ? 'fs-stride' : ''}>
            <path d="M12 -52 q 8 11 6 20" stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" fill="none" />
          </g>
          <circle cx="-18" cy="-31" r="4" fill={FARM.skin} />
          <circle cx="18" cy="-31" r="4" fill={FARM.skin} />
        </>
      )}

      <SamHead />
    </g>
  </g>
);

/** Shared so the story's speech bubbles can show the same face as the scene. */
const SamHead = () => (
  <g>
    <rect x="-3.5" y="-62" width="7" height="6" fill={FARM.skin} />
    <circle cx="0" cy="-70" r="11.5" fill={FARM.skin} />
    <path d="M-11 -74 a 11 11 0 0 1 22 0 Z" fill={FARM.leaf} />
    <path d="M-11 -74 q 13 -3 22 0 l 9 2 q -14 4 -31 0 Z" fill="#41693D" />
    <g className="fs-blink">
      <circle cx="-4" cy="-70" r="1.5" fill="#3A2C1E" />
      <circle cx="4.5" cy="-70" r="1.5" fill="#3A2C1E" />
    </g>
    <path d="M-3 -65 q 3.5 2.6 7 0" stroke="#3A2C1E" strokeWidth="1.4" fill="none" strokeLinecap="round" />
  </g>
);

/** Sam's face on its own, for the moments where he speaks. */
export const SamAvatar: React.FC<{ size?: number; className?: string }> = ({ size = 52, className }) => (
  <svg
    viewBox="-17 -87 36 34" width={size} height={size}
    className={`fs ${className ?? ''}`}
    role="img" aria-label="Sam Whitfield"
  >
    <Motion />
    <circle cx="1" cy="-69" r="17" fill="#FFF8EC" />
    <SamHead />
  </svg>
);

const SpeechPuff = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`} opacity="0.5">
    {[0, 1, 2].map(i => (
      <circle key={i} className="fs-steam" style={delay(i * 1.3)} cx={i * 4} cy="0" r={3 + i} fill={FARM.cream} />
    ))}
  </g>
);

const Sun = ({ x, y, r, glow = FARM.sun, rise = false }: { x: number; y: number; r: number; glow?: string; rise?: boolean }) => (
  <g className={rise ? 'fs-rise' : undefined}>
    <g transform={`translate(${x} ${y})`}>
      <circle className="fs-pulse" cx="0" cy="0" r={r * 2.6} fill={glow} />
      <circle cx="0" cy="0" r={r * 1.7} fill={glow} opacity="0.16" />
      <g className="fs-rays">
        {Array.from({ length: 8 }).map((_, i) => (
          <path key={i} d={`M0 ${-r * 3.05} L${r * 0.11} ${-r * 2.35} L${-r * 0.11} ${-r * 2.35} Z`}
            fill={glow} opacity="0.20" transform={`rotate(${i * 45})`} />
        ))}
      </g>
      <circle cx="0" cy="0" r={r} fill={glow} />
    </g>
  </g>
);

const Cloud = ({ x, y, s = 1, fill = '#FFFFFF', o = 0.7, slow = false, d = 0 }: {
  x: number; y: number; s?: number; fill?: string; o?: number; slow?: boolean; d?: number;
}) => (
  <g className={slow ? 'fs-drift-2' : 'fs-drift'} style={delay(d)}>
    <g transform={`translate(${x} ${y}) scale(${s})`} opacity={o}>
      <ellipse cx="0" cy="0" rx="34" ry="14" fill={fill} />
      <ellipse cx="-22" cy="4" rx="20" ry="10" fill={fill} />
      <ellipse cx="20" cy="5" rx="24" ry="11" fill={fill} />
      <ellipse cx="-4" cy="-9" rx="18" ry="12" fill={fill} />
    </g>
  </g>
);

const Bird = ({ x, y, s = 1, stroke = '#3D4F63', d = 0 }: { x: number; y: number; s?: number; stroke?: string; d?: number }) => (
  <g className="fs-drift" style={delay(d)}>
    <g className="fs-bob" style={delay(d * 0.4)}>
      <path
        d={`M${x} ${y} q ${6 * s} ${-5 * s} ${11 * s} 0 q ${5 * s} ${-5 * s} ${11 * s} 0`}
        fill="none" stroke={stroke} strokeWidth={1.8 * s} strokeLinecap="round" opacity="0.55"
      />
    </g>
  </g>
);

const Tree = ({ x, y, s = 1, canopy = FARM.leaf, bare = false, d = 0 }: {
  x: number; y: number; s?: number; canopy?: string; bare?: boolean; d?: number;
}) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <path d="M-3 0 L-2 -34 L2 -34 L3 0 Z" fill={FARM.woodDark} />
    <g className="fs-sway-s" style={delay(d)}>
      {bare ? (
        <g stroke={FARM.woodDark} strokeWidth="2.4" strokeLinecap="round" fill="none">
          <path d="M0 -30 L-14 -46" /><path d="M0 -30 L13 -47" /><path d="M0 -36 L-8 -52" />
          <path d="M0 -36 L7 -53" /><path d="M0 -42 L0 -58" />
        </g>
      ) : (
        <>
          <circle cx="0" cy="-44" r="20" fill={canopy} />
          <circle cx="-14" cy="-34" r="14" fill={canopy} />
          <circle cx="14" cy="-35" r="13" fill={canopy} />
          <circle cx="-5" cy="-53" r="12" fill={canopy} opacity="0.85" />
        </>
      )}
    </g>
  </g>
);

const CropRow = ({ y, from, to, step, h, fill, o = 1 }: {
  y: number; from: number; to: number; step: number; h: number; fill: string; o?: number;
}) => {
  const items: React.ReactNode[] = [];
  for (let x = from; x <= to; x += step) {
    const jitter = ((x * 37) % 7) - 3;
    items.push(
      <g key={x} className="fs-sway" style={delay((x % 11) * 0.28)}>
        <path d={`M${x} ${y} q ${-3} ${-h / 2} 0 ${-h - jitter} q 3 ${h / 2} 0 ${h + jitter} Z`} fill={fill} />
      </g>
    );
  }
  return <g opacity={o}>{items}</g>;
};

const Crate = ({ x, y, w = 46, h = 30, fill = FARM.wood, contents }: {
  x: number; y: number; w?: number; h?: number; fill?: string; contents?: string;
}) => (
  <g transform={`translate(${x} ${y})`}>
    {contents && (
      <g>
        <circle cx={w * 0.28} cy={-4} r="7" fill={contents} />
        <circle cx={w * 0.55} cy={-6} r="8" fill={contents} />
        <circle cx={w * 0.78} cy={-3} r="6.5" fill={contents} />
      </g>
    )}
    <rect x="0" y="0" width={w} height={h} rx="3" fill={fill} />
    <rect x="0" y={h * 0.32} width={w} height="3.5" fill={FARM.woodDark} opacity="0.45" />
    <rect x="0" y={h * 0.68} width={w} height="3.5" fill={FARM.woodDark} opacity="0.45" />
    <rect x="0" y="0" width={w} height={h} rx="3" fill="none" stroke={FARM.woodDark} strokeWidth="1.5" opacity="0.6" />
  </g>
);

const Hen = ({ x, y, s = 1, flip = false, d = 0 }: { x: number; y: number; s?: number; flip?: boolean; d?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`}>
    <g className="fs-peck" style={delay(d)}>
      <ellipse cx="0" cy="0" rx="11" ry="8.5" fill={FARM.cream} />
      <circle cx="9" cy="-7" r="5.5" fill={FARM.cream} />
      <path d="M11 -12 q 3 -4 5 0 q 2 -3 3 1" fill={FARM.barn} />
      <path d="M14 -6 l 5 2 l -5 2 Z" fill={FARM.honey} />
      <circle cx="11" cy="-8" r="1.1" fill={FARM.night} />
      <path d="M-11 -1 q -6 2 -9 -3 q 5 0 9 0 Z" fill={FARM.wood} opacity="0.8" />
    </g>
    <path d="M-3 8 l 0 5 M3 8 l 0 5" stroke={FARM.honey} strokeWidth="1.6" strokeLinecap="round" />
  </g>
);

const Fence = ({ y, from, to }: { y: number; from: number; to: number }) => (
  <g stroke={FARM.woodDark} strokeWidth="3" strokeLinecap="round" opacity="0.75">
    <line x1={from} y1={y - 12} x2={to} y2={y - 12} />
    <line x1={from} y1={y - 22} x2={to} y2={y - 22} />
    {Array.from({ length: Math.floor((to - from) / 52) + 1 }).map((_, i) => (
      <line key={i} x1={from + i * 52} y1={y - 30} x2={from + i * 52} y2={y + 2} />
    ))}
  </g>
);

const Barn = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x="86" y="-96" width="34" height="96" rx="4" fill={FARM.cream} />
    <path d="M84 -96 q 19 -24 38 0 Z" fill={FARM.barnDark} />
    <rect x="0" y="-70" width="86" height="70" fill={FARM.barn} />
    <path d="M-10 -70 L43 -104 L96 -70 Z" fill={FARM.barnDark} />
    <rect x="30" y="-42" width="26" height="42" rx="2" fill={FARM.barnDark} opacity="0.85" />
    <path d="M30 -42 L56 0 M56 -42 L30 0" stroke={FARM.cream} strokeWidth="2.6" opacity="0.7" />
    <rect x="8" y="-60" width="14" height="14" rx="2" fill={FARM.honey} opacity="0.9" className="fs-pulse" />
    <rect x="64" y="-60" width="14" height="14" rx="2" fill={FARM.honey} opacity="0.9" className="fs-pulse" style={delay(1.4)} />
  </g>
);

const Ground = ({ y, fill }: { y: number; fill: string }) => (
  <rect x="0" y={y} width="800" height={400 - y} fill={fill} />
);


// ── Extra cast and props, for the beats that need them ─────────────

/** Sam's sister. Same build, different silhouette, so they read apart. */
const Sister = ({ x, y, s = 1, flip = false }: { x: number; y: number; s?: number; flip?: boolean }) => (
  <g transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`}>
    <ellipse cx="0" cy="1" rx="16" ry="4" fill="#000000" opacity="0.16" />
    <g className="fs-breathe">
      <path d="M-13 -30 L13 -30 L10 -2 L-10 -2 Z" fill="#5E7C8C" />
      <rect x="-10" y="-5" width="8" height="5" rx="2.5" fill="#4A3728" />
      <rect x="2" y="-5" width="8" height="5" rx="2.5" fill="#4A3728" />
      <path d="M-14 -56 h28 v18 a6 6 0 0 1 -6 6 h-16 a6 6 0 0 1 -6 -6 Z" fill="#B5695E" />
      <path d="M-12 -52 q -9 10 -6 19" stroke="#B5695E" strokeWidth="7" strokeLinecap="round" fill="none" />
      <path d="M12 -52 q 13 -1 17 -11" stroke="#B5695E" strokeWidth="7" strokeLinecap="round" fill="none" />
      <circle cx="-17" cy="-32" r="4" fill={FARM.skin} />
      <circle cx="31" cy="-64" r="4.2" fill={FARM.skin} />
      <rect x="-3.5" y="-62" width="7" height="6" fill={FARM.skin} />
      <circle cx="0" cy="-70" r="11.5" fill={FARM.skin} />
      <path d="M-12 -70 a 12 12 0 0 1 24 0 q 3 14 -4 18 q 2 -12 -8 -14 q -10 2 -8 14 q -7 -4 -4 -18 Z" fill="#6B4A2F" />
      <g className="fs-blink">
        <circle cx="-4" cy="-70" r="1.5" fill="#3A2C1E" />
        <circle cx="4.5" cy="-70" r="1.5" fill="#3A2C1E" />
      </g>
      <path d="M-3 -65 q 3.5 2.6 7 0" stroke="#3A2C1E" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </g>
  </g>
);

const FarmSign = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x="-52" y="-4" width="7" height="56" fill={FARM.woodDark} />
    <rect x="45" y="-4" width="7" height="56" fill={FARM.woodDark} />
    <g className="fs-sway-s" style={{ transformOrigin: '50% 0%' }}>
      <rect x="-58" y="-40" width="116" height="42" rx="5" fill={FARM.cream} stroke={FARM.woodDark} strokeWidth="4" />
      <text x="0" y="-24" textAnchor="middle" fill={FARM.barn} fontSize="14" fontWeight="800"
        letterSpacing="0.6" fontFamily="system-ui, sans-serif">FOXGLOVE</text>
      <text x="0" y="-9" textAnchor="middle" fill={FARM.leaf} fontSize="12" fontWeight="700"
        letterSpacing="2.4" fontFamily="system-ui, sans-serif">FARM</text>
    </g>
  </g>
);

const Van = ({ x, y, s = 1, loaded = 0, lightsOn = false }: {
  x: number; y: number; s?: number; loaded?: number; lightsOn?: boolean;
}) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <ellipse cx="110" cy="12" rx="128" ry="10" fill="#000000" opacity="0.22" />
    <path d="M14 -92 L125 -92 L125 -46 L14 -46 Z" fill={FARM.cream} />
    <path d="M125 -81 L148 -81 L171 -60 L171 -46 L125 -46 Z" fill="#EFE3CE" />
    <path d="M129 -78 L146 -78 L164 -61 L129 -61 Z" fill="#7FA8C4" />
    <path d="M129 -78 L141 -78 L129 -66 Z" fill="#A8C8DC" opacity="0.7" />
    <path d="M14 -92 L-12 -101 L-12 -51 L14 -46 Z" fill="#E4D7C0" />
    <rect x="26" y="-79" width="75" height="17" rx="3" fill={FARM.leaf} opacity="0.22" />
    <text x="63" y="-66" textAnchor="middle" fill={FARM.leaf} fontSize="9" fontWeight="800"
      letterSpacing="0.4" fontFamily="system-ui, sans-serif">FOXGLOVE</text>
    <circle cx="43" cy="-45" r="12" fill="#241F30" />
    <g className="fs-spin"><circle cx="43" cy="-45" r="5" fill="#5A5468" /></g>
    <circle cx="150" cy="-45" r="12" fill="#241F30" />
    <g className="fs-spin"><circle cx="150" cy="-45" r="5" fill="#5A5468" /></g>
    {lightsOn && <ellipse className="fs-pulse" cx="170" cy="-56" rx="4" ry="5" fill="#FFEBB8" opacity="0.9" />}
    <g transform="translate(22 -88)">
      {[[0, 22, FARM.honey], [25, 22, FARM.cream], [50, 22, '#D9534F'], [12, 4, '#A9784F'], [37, 4, '#C0392B']]
        .slice(0, loaded)
        .map(([cx, cy, col], i) => (
          <Crate key={i} x={cx as number} y={cy as number} w={22} h={14} contents={col as string} />
        ))}
    </g>
  </g>
);

/** A small labelled vignette — used to show the three sales channels at once. */
const Vignette = ({ x, y, label, tint, children }: {
  x: number; y: number; label: string; tint: string; children: React.ReactNode;
}) => (
  <g transform={`translate(${x} ${y})`}>
    <ellipse cx="0" cy="6" rx="56" ry="8" fill="#000000" opacity="0.12" />
    {children}
    <rect x="-50" y="14" width="100" height="22" rx="11" fill={tint} />
    <text x="0" y="29" textAnchor="middle" fill={FARM.cream} fontSize="12" fontWeight="700"
      fontFamily="system-ui, sans-serif">{label}</text>
  </g>
);

const MiniStall = () => (
  <g transform="translate(-34 -54)">
    <line x1="4" y1="16" x2="4" y2="54" stroke={FARM.woodDark} strokeWidth="4" />
    <line x1="64" y1="16" x2="64" y2="54" stroke={FARM.woodDark} strokeWidth="4" />
    <rect x="-2" y="44" width="72" height="7" rx="2" fill={FARM.wood} />
    {Array.from({ length: 5 }).map((_, i) => (
      <path key={i} d={`M${-2 + i * 14.4} 16 L${-2 + (i + 1) * 14.4} 16 L${-2 + (i + 1) * 14.4 - 3} 34 L${-2 + i * 14.4 - 3} 34 Z`}
        fill={i % 2 ? FARM.cream : FARM.barn} />
    ))}
    <circle cx="22" cy="39" r="5" fill="#D9534F" /><circle cx="36" cy="39" r="5" fill={FARM.honey} />
    <circle cx="50" cy="39" r="5" fill="#A9784F" />
  </g>
);

const MiniGate = () => (
  <g transform="translate(-34 -50)">
    <rect x="0" y="34" width="68" height="7" rx="2" fill={FARM.wood} />
    <line x1="6" y1="41" x2="6" y2="50" stroke={FARM.woodDark} strokeWidth="4" />
    <line x1="62" y1="41" x2="62" y2="50" stroke={FARM.woodDark} strokeWidth="4" />
    <g stroke={FARM.woodDark} strokeWidth="3" opacity="0.8">
      <line x1="-4" y1="14" x2="-4" y2="50" /><line x1="72" y1="14" x2="72" y2="50" />
      <line x1="-4" y1="20" x2="72" y2="20" /><line x1="-4" y1="28" x2="72" y2="28" />
    </g>
    <rect x="18" y="24" width="14" height="10" rx="2" fill="#C9B79A" />
    <circle cx="46" cy="29" r="5.5" fill={FARM.honey} />
  </g>
);

const MiniCafe = () => (
  <g transform="translate(-34 -58)">
    <rect x="0" y="16" width="68" height="42" fill="#E8DAC4" />
    <rect x="0" y="16" width="68" height="6" fill={FARM.barnDark} />
    {Array.from({ length: 4 }).map((_, i) => (
      <path key={i} d={`M${4 + i * 15} 22 L${4 + (i + 1) * 15} 22 L${4 + (i + 1) * 15 - 2} 34 L${4 + i * 15 - 2} 34 Z`}
        fill={i % 2 ? FARM.cream : FARM.leaf} />
    ))}
    <rect x="8" y="38" width="26" height="20" rx="2" fill="#FFE6AE" />
    <rect x="42" y="36" width="18" height="22" rx="2" fill={FARM.woodDark} />
    <SpeechPuff x={20} y={36} s={0.6} />
  </g>
);

const Beehive = ({ x, y, s = 1, d = 0 }: { x: number; y: number; s?: number; d?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x="-18" y="-10" width="36" height="10" rx="2" fill="#D8C39A" />
    <rect x="-16" y="-22" width="32" height="12" rx="2" fill="#E5D2AC" />
    <rect x="-14" y="-33" width="28" height="11" rx="2" fill="#D8C39A" />
    <path d="M-18 -33 L18 -33 L12 -42 L-12 -42 Z" fill={FARM.woodDark} />
    <circle className="fs-bob" style={delay(d)} cx="24" cy="-30" r="2.4" fill={FARM.honey} />
    <circle className="fs-bob" style={delay(d + 0.9)} cx="-26" cy="-24" r="2" fill={FARM.honey} />
  </g>
);

const Paper = ({ x, y, w = 96, h = 68, rows = 5, title }: {
  x: number; y: number; w?: number; h?: number; rows?: number; title?: string;
}) => (
  <g transform={`translate(${x} ${y})`}>
    <rect x="0" y="0" width={w} height={h} rx="3" fill={FARM.cream} stroke="#E0D3B8" strokeWidth="1.5" />
    {title && (
      <text x={w / 2} y="14" textAnchor="middle" fill={FARM.barn} fontSize="9" fontWeight="800"
        fontFamily="system-ui, sans-serif">{title}</text>
    )}
    <g stroke="#C7B79B" strokeWidth="2" strokeLinecap="round">
      {Array.from({ length: rows }).map((_, i) => (
        <line key={i} x1="9" y1={(title ? 24 : 14) + i * 9} x2={w - 9 - (i % 3) * 12} y2={(title ? 24 : 14) + i * 9} />
      ))}
    </g>
  </g>
);

const ChartBoard = ({ x, y, s = 1, bars, strike = false, title }: {
  x: number; y: number; s?: number; bars: number[]; strike?: boolean; title?: string;
}) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <path d="M-6 0 L-16 44 M118 0 L128 44" stroke={FARM.woodDark} strokeWidth="5" strokeLinecap="round" />
    <rect x="-10" y="-92" width="132" height="94" rx="4" fill={FARM.cream} stroke={FARM.woodDark} strokeWidth="4" />
    {title && (
      <text x="56" y="-77" textAnchor="middle" fill={FARM.barnDark} fontSize="10" fontWeight="800"
        fontFamily="system-ui, sans-serif">{title}</text>
    )}
    {bars.map((h, i) => (
      <rect key={i} x={6 + i * 22} y={-10 - h} width="15" height={h} rx="2"
        fill={i === 0 ? FARM.honey : `${FARM.leaf}CC`} />
    ))}
    <line x1="2" y1="-10" x2="114" y2="-10" stroke={FARM.woodDark} strokeWidth="2" opacity="0.6" />
    {strike && (
      <g stroke={FARM.barn} strokeWidth="5" strokeLinecap="round" opacity="0.85">
        <line x1="0" y1="-70" x2="46" y2="-16" /><line x1="46" y1="-70" x2="0" y2="-16" />
      </g>
    )}
  </g>
);

const Calendar = ({ x, y, s = 1, litFrom = 5, litTo = 8 }: {
  x: number; y: number; s?: number; litFrom?: number; litTo?: number;
}) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x="0" y="0" width="176" height="118" rx="6" fill={FARM.cream} stroke={FARM.woodDark} strokeWidth="4" />
    <rect x="0" y="0" width="176" height="22" rx="6" fill={FARM.barnDark} />
    <text x="88" y="16" textAnchor="middle" fill={FARM.cream} fontSize="11" fontWeight="800"
      letterSpacing="1.4" fontFamily="system-ui, sans-serif">ONE YEAR</text>
    {Array.from({ length: 12 }).map((_, i) => {
      const lit = i >= litFrom && i <= litTo;
      return (
        <rect key={i} x={12 + (i % 4) * 39} y={32 + Math.floor(i / 4) * 28} width="33" height="22" rx="3"
          fill={lit ? FARM.honey : '#E6DAC4'} opacity={lit ? 0.95 : 0.8}
          className={lit ? 'fs-pulse' : undefined} style={lit ? delay(i * 0.25) : undefined} />
      );
    })}
  </g>
);

const Rain = () => (
  <g stroke="#B4C4D2" strokeWidth="1.6" strokeLinecap="round" opacity="0.55">
    {Array.from({ length: 40 }).map((_, i) => {
      const x = (i * 97) % 810;
      return (
        <g key={i} className="fs-rain" style={delay(-((i * 0.17) % 1.1))}>
          <line x1={x} y1={0} x2={x - 9} y2={26} />
        </g>
      );
    })}
  </g>
);

const Shopper = ({ x, y, s = 1, flip = false, coat = '#6E7F94' }: {
  x: number; y: number; s?: number; flip?: boolean; coat?: string;
}) => (
  <g transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`} opacity="0.9">
    <ellipse cx="0" cy="1" rx="14" ry="3.5" fill="#000000" opacity="0.14" />
    <g className="fs-breathe">
      <rect x="-11" y="-48" width="22" height="30" rx="7" fill={coat} />
      <rect x="-8" y="-20" width="7" height="19" rx="3" fill="#3F4A58" />
      <rect x="1" y="-20" width="7" height="19" rx="3" fill="#36404C" />
      <circle cx="0" cy="-58" r="9.5" fill={FARM.skin} />
      <path d="M-9.5 -60 a 9.5 9.5 0 0 1 19 0 Z" fill="#4A3728" />
      <path d="M11 -44 q 8 6 6 14" stroke={coat} strokeWidth="6" strokeLinecap="round" fill="none" />
    </g>
  </g>
);

// ═══════════════════════════════════════════════════════════════════
// THE SCENES
// Each takes the current beat, so the picture follows the sentence
// instead of one backdrop sitting behind four different lines.
// ═══════════════════════════════════════════════════════════════════

type SceneProps = { beat: number; uid: string };

// ── Chapter 1 · dawn, and a shoebox full of paper ──────────────────

const DawnBackdrop = ({ uid }: { uid: string }) => (
  <>
    <defs>
      <linearGradient id={`${uid}s1sky`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#8FC6E0" /><stop offset="45%" stopColor="#FFD59B" />
        <stop offset="100%" stopColor="#FFB27A" />
      </linearGradient>
      <linearGradient id={`${uid}s1field`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#6FA556" /><stop offset="100%" stopColor="#4E7C3E" />
      </linearGradient>
    </defs>
    <rect width="800" height="400" fill={`url(#${uid}s1sky)`} />
    <Sun x={148} y={214} r={38} rise />
    <Cloud x={-60} y={70} s={1.1} fill="#FFE9CF" o={0.85} slow d={-20} />
    <Cloud x={-60} y={48} s={0.75} fill="#FFF0DC" o={0.7} d={-38} />
    <Bird x={0} y={96} s={1.1} d={-6} /><Bird x={0} y={78} s={0.8} d={-22} />
    <path d="M0 246 q 120 -34 240 -8 q 130 28 250 -14 q 170 -32 310 6 L800 400 L0 400 Z" fill={FARM.leafFar} />
    <path d="M0 274 q 160 -26 300 2 q 150 30 300 -12 q 120 -22 200 4 L800 400 L0 400 Z" fill={FARM.leafMid} />
    <Ground y={300} fill={`url(#${uid}s1field)`} />
    <g opacity="0.4">
      {[314, 336, 360, 388].map((y, i) => (
        <path key={y} d={`M0 ${y} q 400 ${-10 - i * 3} 800 ${i * 2}`} stroke={FARM.soilDark} strokeWidth={2 + i} fill="none" />
      ))}
    </g>
  </>
);

const SunriseFarm: React.FC<SceneProps> = ({ beat, uid }) => (
  <>
    <DawnBackdrop uid={uid} />

    {/* 0 — eleven years, nine acres, twelve hens, one van */}
    {beat === 0 && (
      <>
        <Tree x={62} y={302} s={1} canopy="#4F8241" />
        <Barn x={228} y={300} s={0.8} />
        <FarmSign x={128} y={330} s={0.95} />
        <Van x={520} y={352} s={0.86} />
        <g>
          {[[352, 372, 0.62, false, 0.2], [386, 380, 0.56, true, 1.1], [418, 370, 0.5, false, 2.0],
            [300, 384, 0.6, true, 0.7], [332, 392, 0.52, false, 1.6], [268, 374, 0.5, true, 2.4]]
            .map(([x, y, s, flip, d], i) => (
              <Hen key={i} x={x as number} y={y as number} s={s as number} flip={flip as boolean} d={d as number} />
            ))}
        </g>
        <Sam x={690} y={392} s={0.9} pose="idle" flip />
      </>
    )}

    {/* 1 — he sells three ways */}
    {beat === 1 && (
      <>
        <CropRow y={318} from={20} to={780} step={30} h={12} fill="#3F6B33" o={0.35} />
        <Vignette x={168} y={326} label="Saturday market" tint={FARM.barn}><MiniStall /></Vignette>
        <Vignette x={400} y={326} label="Farm gate" tint={FARM.leaf}><MiniGate /></Vignette>
        <Vignette x={632} y={326} label="Two cafés" tint={FARM.amber}><MiniCafe /></Vignette>
      </>
    )}

    {/* 2 — a year of sales in a shoebox under the counter */}
    {beat === 2 && (
      <>
        <Tree x={92} y={302} s={0.9} canopy="#4F8241" />
        <Barn x={584} y={300} s={0.72} />
        <g transform="translate(268 208)">
          <rect x="0" y="60" width="264" height="14" rx="3" fill={FARM.wood} />
          <rect x="0" y="74" width="264" height="8" fill={FARM.woodDark} />
          <line x1="16" y1="82" x2="16" y2="142" stroke={FARM.woodDark} strokeWidth="7" />
          <line x1="248" y1="82" x2="248" y2="142" stroke={FARM.woodDark} strokeWidth="7" />
          <rect x="34" y="34" width="60" height="26" rx="3" fill={FARM.woodDark} />
          <circle cx="50" cy="30" r="8" fill="#D9534F" /><circle cx="70" cy="28" r="9" fill="#C0392B" />
          <g transform="translate(150 26)">
            {[[0, 20], [24, 20], [12, 0]].map(([x, y], i) => (
              <g key={i} transform={`translate(${x} ${y})`}>
                <rect x="0" y="0" width="18" height="18" rx="3" fill={FARM.honey} />
                <rect x="1" y="-4" width="16" height="5" rx="2" fill={FARM.barnDark} />
              </g>
            ))}
          </g>
          {/* the shoebox, tucked underneath, stuffed with paper */}
          <g transform="translate(92 100)">
            <ellipse cx="46" cy="42" rx="62" ry="8" fill="#000000" opacity="0.22" />
            <g className="fs-flutter" style={delay(0.2)}>
              <rect x="14" y="-14" width="20" height="26" rx="2" fill={FARM.cream} stroke="#E0D3B8" strokeWidth="1" transform="rotate(-10 24 -1)" />
            </g>
            <g className="fs-flutter" style={delay(1.1)}>
              <rect x="40" y="-18" width="20" height="26" rx="2" fill={FARM.cream} stroke="#E0D3B8" strokeWidth="1" transform="rotate(7 50 -5)" />
            </g>
            <g className="fs-flutter" style={delay(1.9)}>
              <rect x="64" y="-12" width="20" height="26" rx="2" fill={FARM.cream} stroke="#E0D3B8" strokeWidth="1" transform="rotate(16 74 1)" />
            </g>
            <rect x="0" y="6" width="96" height="36" rx="3" fill="#D9C7A8" />
            <rect x="0" y="6" width="96" height="10" rx="3" fill="#C4AE8C" />
            <text x="48" y="32" textAnchor="middle" fill="#8E7B5E" fontSize="11" fontWeight="700"
              letterSpacing="0.6" fontFamily="system-ui, sans-serif">A YEAR OF SALES</text>
          </g>
        </g>
      </>
    )}

    {/* 3 — his sister asks the question */}
    {beat >= 3 && (
      <>
        <Tree x={82} y={302} s={1} canopy="#4F8241" />
        <Barn x={556} y={300} s={0.85} />
        <Fence y={300} from={180} to={452} />
        <g transform="translate(300 352)">
          <ellipse cx="60" cy="30" rx="88" ry="10" fill={FARM.soilDark} opacity="0.25" />
          <rect x="14" y="-2" width="96" height="32" rx="3" fill="#D9C7A8" />
          <rect x="14" y="-2" width="96" height="9" rx="3" fill="#C4AE8C" />
          <path d="M104 -2 L146 -18 L156 6 L114 22 Z" fill="#E8DCC4" />
          {[[-40, -46, -14, 0], [-8, -56, 8, 0.7], [24, -44, 22, 1.4], [56, -58, -6, 2.1]].map(([x, y, rot, dl], i) => (
            <g key={i} className="fs-flutter" style={delay(dl as number)}>
              <g transform={`rotate(${rot} ${(x as number) + 13} ${(y as number) + 17})`}>
                <rect x={x} y={y} width="26" height="34" rx="2" fill={FARM.cream} stroke="#E0D3B8" strokeWidth="1" />
                <g stroke="#BFB096" strokeWidth="1.6" strokeLinecap="round">
                  {[9, 15, 21, 27].map((o, k) => (
                    <line key={k} x1={(x as number) + 5} y1={(y as number) + o} x2={(x as number) + 21 - (k % 3) * 4} y2={(y as number) + o} />
                  ))}
                </g>
              </g>
            </g>
          ))}
        </g>
        <Sam x={218} y={392} s={0.92} pose="thinking" />
        <Sister x={512} y={392} s={0.9} flip />
      </>
    )}
  </>
);

// ── Chapter 2 · Saturday market ────────────────────────────────────

const MarketBackdrop = ({ uid, dark = false }: { uid: string; dark?: boolean }) => (
  <>
    <defs>
      <linearGradient id={`${uid}s2sky`} x1="0" y1="0" x2="0" y2="1">
        {dark
          ? <><stop offset="0%" stopColor="#2E3B57" /><stop offset="100%" stopColor="#8C7E8E" /></>
          : <><stop offset="0%" stopColor="#8ECFE8" /><stop offset="100%" stopColor="#DFF1F8" /></>}
      </linearGradient>
    </defs>
    <rect width="800" height="400" fill={`url(#${uid}s2sky)`} />
    {dark
      ? <>
        {[[110, 40], [240, 70], [380, 34], [520, 62], [660, 44], [740, 88]].map(([x, y], i) => (
          <circle key={i} className="fs-twinkle" style={delay(i * 0.6)} cx={x} cy={y} r={1.6} fill={FARM.cream} />
        ))}
      </>
      : <>
        <Sun x={676} y={72} r={28} />
        <Cloud x={-60} y={62} s={1} o={0.85} slow d={-14} />
        <Bird x={0} y={92} s={0.8} d={-10} />
      </>}
    <g opacity={dark ? 0.35 : 0.28} fill={dark ? '#243149' : FARM.slate}>
      <path d="M0 214 L0 170 L52 138 L104 170 L104 214 Z" />
      <path d="M118 214 L118 156 L166 128 L214 156 L214 214 Z" />
      <path d="M596 214 L596 148 L648 118 L700 148 L700 214 Z" />
      <path d="M712 214 L712 168 L756 142 L800 168 L800 214 Z" />
    </g>
    <rect y="212" width="800" height="188" fill={dark ? '#7E7666' : '#C9BFA8'} />
    <g opacity="0.3" stroke={dark ? '#635C50' : '#A99C82'} strokeWidth="1.6">
      {[240, 276, 318, 366].map(y => <line key={y} x1="0" y1={y} x2="800" y2={y} />)}
      {[90, 220, 350, 480, 610, 740].map(x => <line key={x} x1={x} y1="212" x2={x} y2="400" />)}
    </g>
  </>
);

/** The stall frame, with the table optionally still bare. */
const Stall = ({ x, y, s = 1, awning = true, children }: {
  x: number; y: number; s?: number; awning?: boolean; children?: React.ReactNode;
}) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <line x1="14" y1="0" x2="14" y2="150" stroke={FARM.woodDark} strokeWidth="7" />
    <line x1="322" y1="0" x2="322" y2="150" stroke={FARM.woodDark} strokeWidth="7" />
    {awning && (
      <>
        <path d="M-6 4 L342 4 L342 -14 L-6 -14 Z" fill={FARM.barnDark} />
        <g className="fs-sway-s" style={{ transformOrigin: '50% 0%' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <path key={i} d={`M${-6 + i * 43.5} 4 L${-6 + (i + 1) * 43.5} 4 L${-6 + (i + 1) * 43.5 - 8} 40 L${-6 + i * 43.5 - 8} 40 Z`}
              fill={i % 2 ? FARM.cream : FARM.barn} />
          ))}
          <path d="M-14 38 q 174 16 350 0 l 0 12 q -176 16 -350 0 Z" fill={FARM.cream} opacity="0.95" />
        </g>
      </>
    )}
    <rect x="-4" y="96" width="338" height="16" rx="3" fill={FARM.wood} />
    <rect x="-4" y="112" width="338" height="8" fill={FARM.woodDark} />
    {children}
  </g>
);

const HoneyPyramid = ({ glint = true }: { glint?: boolean }) => (
  <g>
    <ellipse cx="52" cy="56" rx="60" ry="9" fill={FARM.honey} opacity="0.16" />
    {[[16, 34], [46, 34], [76, 34], [31, 8], [61, 8], [46, -18]].map(([x, y], i) => (
      <g key={i} transform={`translate(${x} ${y})`}>
        <rect x="0" y="0" width="24" height="24" rx="4" fill={FARM.honey} />
        <rect x="0" y="0" width="24" height="9" rx="4" fill="#F2B950" />
        <rect x="2" y="-5" width="20" height="6" rx="2" fill={FARM.barnDark} />
        <rect x="4" y="10" width="16" height="8" rx="1.5" fill={FARM.cream} opacity="0.85" />
        {glint && <rect className="fs-glint" style={delay(i * 0.9)} x="3" y="2" width="5" height="18" rx="2.5" fill="#FFFFFF" />}
      </g>
    ))}
  </g>
);

const PotatoSacks = ({ x, y }: { x: number; y: number }) => (
  <g transform={`translate(${x} ${y})`}>
    {[[0, 0, 1], [56, 6, 0.9], [28, -34, 0.8]].map(([x2, y2, s], i) => (
      <g key={i} transform={`translate(${x2} ${y2}) scale(${s})`}>
        <path d="M0 46 q -6 -46 22 -50 q 28 4 22 50 Z" fill="#9E8A6B" />
        <path d="M12 -6 q 10 -8 20 0 q -10 5 -20 0 Z" fill="#8A785C" />
        <ellipse cx="22" cy="46" rx="24" ry="5" fill={FARM.soilDark} opacity="0.2" />
      </g>
    ))}
  </g>
);

const MarketStall: React.FC<SceneProps> = ({ beat, uid }) => (
  <>
    <MarketBackdrop uid={uid} dark={beat === 0} />

    {/* 0 — half six, the stall goes up in the dark */}
    {beat === 0 && (
      <>
        <Stall x={232} y={200} awning={false} />
        <g className="fs-sway-s" style={{ transformOrigin: '50% 100%' }}>
          <path d="M226 204 L580 130 L584 148 L230 222 Z" fill={FARM.barnDark} opacity="0.9" />
        </g>
        <Van x={40} y={352} s={0.7} lightsOn />
        <Sam x={556} y={352} s={0.86} pose="pointing" flip />
        <SpeechPuff x={534} y={300} s={0.9} />
      </>
    )}

    {/* 1 — by nine the potatoes are moving in sacks */}
    {beat === 1 && (
      <>
        <Stall x={232} y={200}>
          <g transform="translate(6 60)">
            <rect x="0" y="14" width="72" height="22" rx="3" fill={FARM.woodDark} />
            {[10, 26, 42, 58, 18, 34].map((x, i) => (
              <ellipse key={i} cx={x} cy={i > 3 ? 6 : 14} rx="9" ry="7" fill={i % 2 ? '#B98A54' : '#A9784F'} />
            ))}
          </g>
        </Stall>
        <PotatoSacks x={430} y={296} />
        <PotatoSacks x={584} y={302} />
        <Shopper x={230} y={392} s={0.92} />
        <Shopper x={318} y={396} s={0.86} flip coat="#8A6B7E" />
        <Sam x={690} y={392} s={0.86} pose="carrying" flip />
        <g transform="translate(700 330)"><Crate x={0} y={0} w={38} h={22} contents="#A9784F" /></g>
      </>
    )}

    {/* 2 — the honey sits at the back, some weeks he sells four */}
    {beat === 2 && (
      <>
        <Stall x={232} y={200}>
          <g transform="translate(112 44) scale(1.25)"><HoneyPyramid /></g>
        </Stall>
        <g transform="translate(560 250)">
          <rect x="0" y="0" width="86" height="30" rx="15" fill={FARM.night} opacity="0.5" />
          <text x="43" y="20" textAnchor="middle" fill={FARM.cream} fontSize="12" fontWeight="700"
            fontFamily="system-ui, sans-serif">4 jars</text>
        </g>
        <Sam x={666} y={392} s={0.86} pose="idle" flip />
      </>
    )}

    {/* 3 — same eight products, the question is what you count */}
    {beat >= 3 && (
      <>
        <Stall x={232} y={200}>
          <g transform="translate(6 62)">
            <rect x="0" y="12" width="60" height="22" rx="3" fill={FARM.woodDark} />
            {[10, 26, 42, 18, 34].map((x, i) => (
              <circle key={i} cx={x} cy={i > 2 ? 4 : 12} r="7" fill={i % 2 ? '#C0392B' : '#D9534F'} />
            ))}
          </g>
          <g transform="translate(76 64)">
            <rect x="0" y="10" width="56" height="22" rx="3" fill={FARM.woodDark} />
            {[10, 26, 42, 18].map((x, i) => (
              <ellipse key={i} cx={x} cy={i > 2 ? 4 : 12} rx="8" ry="6.5" fill="#A9784F" />
            ))}
          </g>
          <g transform="translate(142 66)">
            <rect x="0" y="10" width="46" height="20" rx="3" fill="#C9B79A" />
            {[9, 22, 35].map((x, i) => <ellipse key={i} cx={x} cy={9} rx="6" ry="7.5" fill={FARM.cream} />)}
          </g>
          <g transform="translate(196 42) scale(0.82)"><HoneyPyramid glint={false} /></g>
          <g transform="translate(268 62)">
            {[0, 22, 44].map((x, i) => (
              <g key={i} transform={`translate(${x} ${i === 1 ? 24 : 30})`}>
                <rect x="0" y="0" width="18" height="22" rx="3.5" fill="#C0392B" />
                <rect x="0" y="0" width="18" height="7" rx="3.5" fill="#D9534F" />
                <rect x="1" y="-4" width="16" height="5" rx="2" fill={FARM.cream} />
              </g>
            ))}
          </g>
        </Stall>
        <g transform="translate(268 344)">
          <rect x="0" y="0" width="272" height="34" rx="17" fill={FARM.night} opacity="0.45" />
          <text x="136" y="23" textAnchor="middle" fill={FARM.cream} fontSize="14" fontWeight="700"
            fontFamily="system-ui, sans-serif">Eight products — count what?</text>
        </g>
        <Sam x={690} y={392} s={0.86} pose="thinking" flip />
      </>
    )}
  </>
);

// ── Chapter 3 · November, and a half-empty table ───────────────────

const WinterBackdrop = ({ uid }: { uid: string }) => (
  <>
    <defs>
      <linearGradient id={`${uid}s3sky`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#8496AC" /><stop offset="100%" stopColor="#C6D4DF" />
      </linearGradient>
      <linearGradient id={`${uid}s3tunnel`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#FFE3A8" /><stop offset="100%" stopColor="#F0C877" />
      </linearGradient>
    </defs>
    <rect width="800" height="400" fill={`url(#${uid}s3sky)`} />
    <Cloud x={-60} y={58} s={1.4} fill="#93A5B8" o={0.75} slow d={-30} />
    <Cloud x={-60} y={40} s={1.1} fill="#A3B3C4" o={0.7} slow d={-55} />
    <Rain />
    <path d="M0 236 q 180 -20 360 0 q 200 22 440 -6 L800 400 L0 400 Z" fill="#8FA98C" />
    <Ground y={278} fill="#7C9377" />
    <g opacity="0.4">
      {[292, 314, 342, 376].map((y, i) => (
        <path key={y} d={`M0 ${y} q 400 ${-8 - i * 2} 800 ${i * 3}`} stroke="#5F7659" strokeWidth={2 + i} fill="none" />
      ))}
    </g>
    <ellipse cx="250" cy="360" rx="86" ry="10" fill="#AFC4D2" opacity="0.55" />
    <ellipse cx="612" cy="386" rx="70" ry="9" fill="#AFC4D2" opacity="0.45" />
  </>
);

const WinterField: React.FC<SceneProps> = ({ beat, uid }) => (
  <>
    <WinterBackdrop uid={uid} />

    {/* 0 — November, rain sideways across the top field */}
    {beat === 0 && (
      <>
        <Tree x={106} y={280} s={1.05} bare /><Tree x={196} y={286} s={0.8} bare d={1.1} />
        <Tree x={686} y={284} s={0.95} bare d={2.3} /><Tree x={758} y={290} s={0.7} bare d={0.6} />
        <Fence y={300} from={280} to={600} />
        <g transform="translate(392 214)">
          <rect x="0" y="0" width="120" height="30" rx="15" fill={FARM.night} opacity="0.4" />
          <text x="60" y="20" textAnchor="middle" fill={FARM.cream} fontSize="13" fontWeight="700"
            letterSpacing="1" fontFamily="system-ui, sans-serif">NOVEMBER</text>
        </g>
        <Sam x={452} y={394} s={0.86} pose="idle" />
        <SpeechPuff x={476} y={334} s={0.9} />
      </>
    )}

    {/* 1 — eggs, potatoes and a row of jam jars. that is it. */}
    {beat === 1 && (
      <>
        <Tree x={716} y={284} s={0.9} bare d={2.3} />
        <g transform="translate(216 240)">
          <rect x="0" y="60" width="240" height="14" rx="3" fill={FARM.wood} />
          <rect x="0" y="74" width="240" height="8" fill={FARM.woodDark} />
          <line x1="14" y1="82" x2="14" y2="150" stroke={FARM.woodDark} strokeWidth="6" />
          <line x1="226" y1="82" x2="226" y2="150" stroke={FARM.woodDark} strokeWidth="6" />
          <g transform="translate(18 30)">
            <rect x="0" y="16" width="52" height="14" rx="2" fill="#C9B79A" />
            {[9, 22, 35, 15, 29].map((x, i) => <ellipse key={i} cx={x} cy={i > 2 ? 8 : 15} rx="6.5" ry="8" fill={FARM.cream} />)}
            <rect x="-2" y="52" width="56" height="18" rx="9" fill={FARM.cream} opacity="0.92" />
            <text x="26" y="65" textAnchor="middle" fill={FARM.barnDark} fontSize="11" fontWeight="700"
              fontFamily="system-ui, sans-serif">Eggs</text>
          </g>
          <g transform="translate(92 28)">
            {[0, 24, 48].map((x, i) => (
              <g key={i} transform={`translate(${x} ${i === 1 ? 6 : 12})`}>
                <rect x="0" y="0" width="20" height="24" rx="4" fill="#C0392B" />
                <rect x="0" y="0" width="20" height="7" rx="4" fill="#D9534F" />
                <rect x="1" y="-4" width="18" height="5" rx="2" fill={FARM.cream} />
              </g>
            ))}
            <rect x="6" y="54" width="56" height="18" rx="9" fill={FARM.cream} opacity="0.92" />
            <text x="34" y="67" textAnchor="middle" fill={FARM.barnDark} fontSize="11" fontWeight="700"
              fontFamily="system-ui, sans-serif">Jam</text>
          </g>
          <g transform="translate(168 34)">
            <rect x="0" y="14" width="52" height="16" rx="3" fill={FARM.woodDark} />
            {[10, 26, 42, 18, 34].map((x, i) => <ellipse key={i} cx={x} cy={i > 2 ? 8 : 15} rx="8" ry="6" fill="#A9784F" />)}
            <rect x="-6" y="52" width="64" height="18" rx="9" fill={FARM.cream} opacity="0.92" />
            <text x="26" y="65" textAnchor="middle" fill={FARM.barnDark} fontSize="11" fontWeight="700"
              fontFamily="system-ui, sans-serif">Potatoes</text>
          </g>
        </g>
        <Hen x={548} y={330} s={0.78} d={0.2} />
        <Hen x={596} y={338} s={0.68} flip d={1.5} />
        <Sam x={620} y={394} s={0.86} pose="idle" flip />
      </>
    )}

    {/* 2 — the summer chart is proud of things that do not exist in January */}
    {beat >= 2 && (
      <>
        <Tree x={92} y={280} s={0.95} bare />
        <g transform="translate(430 176)">
          <path d="M0 104 L0 44 q 96 -58 192 0 L192 104 Z" fill={`url(#${uid}s3tunnel)`} opacity="0.92" />
          <path d="M0 104 L0 44 q 96 -58 192 0 L192 104 Z" fill="none" stroke={FARM.cream} strokeWidth="3" opacity="0.7" />
          <g stroke={FARM.cream} strokeWidth="2.4" opacity="0.55" fill="none">
            <path d="M38 104 L38 26" /><path d="M96 104 L96 16" /><path d="M154 104 L154 26" />
          </g>
          <ellipse className="fs-pulse" cx="96" cy="118" rx="130" ry="16" fill={FARM.honey} />
        </g>
        <ChartBoard x={176} y={352} s={1.05} bars={[62, 54, 40, 26]} strike title="LAST CHAPTER" />
        <Sam x={358} y={394} s={0.84} pose="pointing" />
      </>
    )}
  </>
);

// ── Chapter 4 · five in the morning, five crates ───────────────────

const PredawnBackdrop = ({ uid }: { uid: string }) => (
  <>
    <defs>
      <linearGradient id={`${uid}s4sky`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#33456B" /><stop offset="55%" stopColor="#8E6E86" />
        <stop offset="100%" stopColor="#F0A46A" />
      </linearGradient>
      <radialGradient id={`${uid}s4beam`} cx="0" cy="0.5" r="1">
        <stop offset="0%" stopColor="#FFE9B8" stopOpacity="0.75" />
        <stop offset="100%" stopColor="#FFE9B8" stopOpacity="0" />
      </radialGradient>
    </defs>
    <rect width="800" height="400" fill={`url(#${uid}s4sky)`} />
    {[[92, 44], [188, 76], [276, 36], [404, 62], [520, 30], [636, 84], [724, 50], [148, 112], [352, 106]].map(([x, y], i) => (
      <circle key={i} className="fs-twinkle" style={delay(i * 0.55)} cx={x} cy={y} r={i % 3 === 0 ? 2 : 1.4} fill={FARM.cream} />
    ))}
    <Sun x={702} y={252} r={28} glow="#FFB870" rise />
    <path d="M0 258 q 150 -28 300 -6 q 180 26 340 -12 q 110 -22 160 2 L800 400 L0 400 Z" fill="#4A4257" />
    <Ground y={296} fill="#3A3448" />
  </>
);

const LoadingVan: React.FC<SceneProps> = ({ beat, uid }) => (
  <>
    <PredawnBackdrop uid={uid} />

    {/* 0 — the van holds five crates. not six. */}
    {beat === 0 && (
      <>
        <Barn x={30} y={296} s={0.6} />
        <Van x={220} y={356} s={1.06} loaded={5} lightsOn />
        <g transform="translate(486 330)">
          <Crate x={0} y={0} w={54} h={32} contents="#E8C86A" />
          <path d="M-8 -4 l 70 44 M62 -4 l -70 44" stroke="#D9534F" strokeWidth="5" strokeLinecap="round" opacity="0.7" />
          <rect x="-14" y="-34" width="82" height="22" rx="11" fill="#D9534F" />
          <text x="27" y="-19" textAnchor="middle" fill={FARM.cream} fontSize="12" fontWeight="700"
            fontFamily="system-ui, sans-serif">no room</text>
        </g>
        <g transform="translate(600 244)">
          <rect x="0" y="0" width="150" height="34" rx="17" fill={FARM.night} opacity="0.55" />
          <text x="75" y="23" textAnchor="middle" fill={FARM.cream} fontSize="14" fontWeight="700"
            fontFamily="system-ui, sans-serif">Five. Not six.</text>
        </g>
      </>
    )}

    {/* 1 — every Saturday at five he stands in the cold and guesses */}
    {beat === 1 && (
      <>
        <path className="fs-pulse" d="M300 320 L-40 258 L-40 392 Z" fill={`url(#${uid}s4beam)`} opacity="0.3" />
        <Barn x={22} y={296} s={0.56} />
        <Van x={520} y={352} s={0.82} lightsOn />
        <g transform="translate(150 320)">
          {[[0, 40, FARM.honey], [64, 40, FARM.cream], [128, 40, '#D9534F'], [192, 40, '#A9784F'],
            [32, 4, '#C0392B'], [96, 4, '#E8C86A'], [160, 4, '#B98A54'], [224, 6, '#7FB069']]
            .map(([x, y, col], i) => (
              <Crate key={i} x={x as number} y={y as number} w={54} h={32} contents={col as string} />
            ))}
        </g>
        <Sam x={392} y={394} s={0.94} pose="thinking" />
        <SpeechPuff x={416} y={330} s={1} />
        <g transform="translate(300 218)">
          <rect x="0" y="0" width="130" height="32" rx="16" fill={FARM.night} opacity="0.55" />
          <text x="65" y="22" textAnchor="middle" fill={FARM.cream} fontSize="14" fontWeight="700"
            fontFamily="system-ui, sans-serif">05:00</text>
        </g>
      </>
    )}

    {/* 2 — this week he decides the night before, sitting down */}
    {beat >= 2 && (
      <>
        <Barn x={26} y={296} s={0.5} />
        <Van x={584} y={348} s={0.62} />
        {/* kitchen table, lamp, and the year spread out on it */}
        <g transform="translate(228 258)">
          <ellipse className="fs-pulse" cx="170" cy="10" rx="210" ry="60" fill={FARM.honey} opacity="0.25" />
          <g transform="translate(276 -84)">
            <rect x="-4" y="0" width="8" height="66" fill={FARM.woodDark} />
            <path d="M-26 0 L26 0 L16 -26 L-16 -26 Z" fill={FARM.barn} />
            <circle className="fs-pulse" cx="0" cy="4" r="14" fill={FARM.honey} />
          </g>
          <rect x="0" y="60" width="340" height="16" rx="4" fill={FARM.wood} />
          <rect x="0" y="76" width="340" height="9" fill={FARM.woodDark} />
          <line x1="24" y1="85" x2="24" y2="134" stroke={FARM.woodDark} strokeWidth="8" />
          <line x1="316" y1="85" x2="316" y2="134" stroke={FARM.woodDark} strokeWidth="8" />
          <g transform="rotate(-5 60 30)"><Paper x={22} y={-6} w={96} h={66} rows={5} title="THE YEAR" /></g>
          <g transform="rotate(4 190 26)"><Paper x={136} y={-10} w={90} h={68} rows={6} /></g>
          <ChartBoard x={246} y={58} s={0.62} bars={[54, 44, 36, 24]} />
        </g>
        <Sam x={140} y={394} s={0.9} pose="pointing" />
      </>
    )}
  </>
);

// ── Chapter 5 · Bridge Street, Thursday ────────────────────────────

const StreetBackdrop = ({ uid }: { uid: string }) => (
  <>
    <defs>
      <linearGradient id={`${uid}s5sky`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#A9D6E8" /><stop offset="100%" stopColor="#E8F3F7" />
      </linearGradient>
      <linearGradient id={`${uid}s5win`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#FFE6AE" /><stop offset="100%" stopColor="#F5C46B" />
      </linearGradient>
    </defs>
    <rect width="800" height="400" fill={`url(#${uid}s5sky)`} />
    <Cloud x={-60} y={48} s={0.9} o={0.8} slow d={-18} />
    <Bird x={0} y={54} s={0.7} d={-8} />
    <rect x="0" y="96" width="150" height="216" fill="#C7B9A6" />
    <rect x="0" y="96" width="150" height="14" fill="#A99A85" />
    <rect x="24" y="140" width="46" height="60" rx="3" fill="#9FB5C4" opacity="0.7" />
    <rect x="650" y="82" width="150" height="230" fill="#BFAF9C" />
    <rect x="650" y="82" width="150" height="14" fill="#A0917C" />
    <rect x="682" y="128" width="44" height="66" rx="3" fill="#9FB5C4" opacity="0.6" />
    <rect y="312" width="800" height="88" fill="#BDB5A8" />
    <g opacity="0.35" stroke="#9A9184" strokeWidth="1.8">
      {[336, 366].map(y => <line key={y} x1="0" y1={y} x2="800" y2={y} />)}
      {[70, 190, 310, 430, 550, 670].map(x => <line key={x} x1={x} y1="312" x2={x} y2="400" />)}
    </g>
  </>
);

const CafeFront = ({ uid, street = 'BRIDGE STREET' }: { uid: string; street?: string }) => (
  <g transform="translate(168 70)">
    <rect x="0" y="0" width="470" height="242" fill="#E8DAC4" />
    <rect x="0" y="0" width="470" height="20" rx="3" fill={FARM.barnDark} />
    <g transform="translate(408 24)">
      <line x1="0" y1="0" x2="0" y2="16" stroke={FARM.woodDark} strokeWidth="3" />
      <g className="fs-sway-s" style={{ transformOrigin: '50% 0%' }}>
        <rect x="-52" y="16" width="104" height="42" rx="5" fill={FARM.leaf} />
        <text x="0" y="42" textAnchor="middle" fill={FARM.cream} fontSize="12" fontWeight="800"
          letterSpacing="0.6" fontFamily="system-ui, sans-serif">{street}</text>
      </g>
    </g>
    <g transform="translate(24 26)">
      <g className="fs-sway-s" style={{ transformOrigin: '50% 0%' }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <path key={i} d={`M${i * 46} 0 L${(i + 1) * 46} 0 L${(i + 1) * 46 - 5} 40 L${i * 46 - 5} 40 Z`}
            fill={i % 2 ? FARM.cream : FARM.leaf} />
        ))}
        <path d="M-8 38 q 162 14 330 0 l 0 10 q -168 14 -330 0 Z" fill="#E8DAC4" />
      </g>
    </g>
    <rect x="34" y="98" width="180" height="112" rx="5" fill={`url(#${uid}s5win)`} />
    <rect x="34" y="98" width="180" height="112" rx="5" fill="none" stroke={FARM.woodDark} strokeWidth="5" />
    <line x1="124" y1="98" x2="124" y2="210" stroke={FARM.woodDark} strokeWidth="4" />
    <g fill={FARM.barnDark} opacity="0.35">
      <circle cx="72" cy="140" r="12" /><path d="M52 176 q 20 -26 40 0 Z" />
      <circle cx="168" cy="146" r="11" /><path d="M150 178 q 18 -24 36 0 Z" />
      <rect x="96" y="168" width="48" height="5" rx="2" />
    </g>
    <SpeechPuff x={114} y={162} s={0.8} />
    <rect x="256" y="106" width="72" height="136" rx="4" fill={FARM.woodDark} />
    <rect x="266" y="118" width="52" height="62" rx="3" fill={`url(#${uid}s5win)`} opacity="0.9" />
    <circle cx="318" cy="180" r="4" fill={FARM.honey} />
  </g>
);

const CafeDelivery: React.FC<SceneProps> = ({ beat, uid }) => (
  <>
    <StreetBackdrop uid={uid} />
    {beat < 2 && <CafeFront uid={uid} />}

    {/* 0 — Thursday. the café asks if he can supply more. */}
    {beat === 0 && (
      <>
        <Shopper x={430} y={392} s={0.98} coat="#8E6A56" />
        <Sam x={330} y={392} s={0.9} pose="idle" />
        <g transform="translate(452 236)">
          <rect x="0" y="0" width="152" height="34" rx="17" fill={FARM.cream} />
          <path d="M14 34 l 6 12 l 12 -12 Z" fill={FARM.cream} />
          <text x="76" y="23" textAnchor="middle" fill={FARM.barnDark} fontSize="13" fontWeight="700"
            fontFamily="system-ui, sans-serif">Can you send more?</text>
        </g>
      </>
    )}

    {/* 1 — he says yes before working out what that means */}
    {beat === 1 && (
      <>
        <Shopper x={410} y={392} s={0.98} coat="#8E6A56" />
        <Sam x={330} y={392} s={0.9} pose="pointing" />
        <g transform="translate(196 240)">
          <rect x="0" y="0" width="76" height="34" rx="17" fill={FARM.cream} />
          <path d="M52 34 l -6 12 l -12 -12 Z" fill={FARM.cream} />
          <text x="38" y="23" textAnchor="middle" fill={FARM.barn} fontSize="15" fontWeight="800"
            fontFamily="system-ui, sans-serif">Yes!</text>
        </g>
        <g transform="translate(470 262)">
          <text x="0" y="0" fill={FARM.barnDark} fontSize="30" fontWeight="800"
            fontFamily="system-ui, sans-serif" opacity="0.5">?</text>
        </g>
      </>
    )}

    {/* 2 — three channels, one spreadsheet */}
    {beat >= 2 && (
      <>
        <g transform="translate(58 292)">
          <Crate x={0} y={22} w={54} h={32} contents={FARM.honey} />
          <Crate x={62} y={22} w={54} h={32} contents={FARM.cream} />
          <Crate x={31} y={-12} w={54} h={32} contents="#D9534F" />
        </g>
        <g transform="translate(236 150)">
          {([
            { label: 'Stall', col: FARM.barn, dx: 0 },
            { label: 'Gate', col: FARM.leaf, dx: 96 },
            { label: 'Café', col: FARM.amber, dx: 192 },
          ] as const).map(({ label, col, dx }) => (
            <g key={label} transform={`translate(${dx} 0)`}>
              <rect x="0" y="0" width="82" height="28" rx="14" fill={col} />
              <text x="41" y="19" textAnchor="middle" fill={FARM.cream} fontSize="13" fontWeight="700"
                fontFamily="system-ui, sans-serif">{label}</text>
              <path d={`M41 30 q 0 34 ${137 - dx} 52`} stroke={col} strokeWidth="3"
                fill="none" opacity="0.7" strokeLinecap="round" strokeDasharray="5 5" />
            </g>
          ))}
          <g transform="translate(117 84)">
            <Paper x={0} y={0} w={132} h={86} rows={6} title="ONE SPREADSHEET" />
          </g>
        </g>
        <Sam x={686} y={392} s={0.88} pose="pointing" flip />
      </>
    )}
  </>
);

// ── Chapter 6 · the bank, the calendar, and the whole year ─────────

const YearPanorama: React.FC<SceneProps> = ({ beat, uid }) => {
  const bands = [
    { x: 0, sky: '#9FB3C8', ground: '#8FA98C', label: 'Winter' },
    { x: 200, sky: '#BBD9E8', ground: '#7FB069', label: 'Spring' },
    { x: 400, sky: '#8ECFE8', ground: '#6FA556', label: 'Summer' },
    { x: 600, sky: '#E8C88F', ground: '#B08A4A', label: 'Autumn' },
  ];

  /* 0 — the bank wants a plan before it will lend for the hives */
  if (beat === 0) {
    return (
      <>
        <StreetBackdrop uid={uid} />
        <g transform="translate(196 62)">
          <rect x="0" y="40" width="412" height="212" fill="#D7CDBC" />
          <path d="M-20 40 L206 -18 L432 40 Z" fill="#C2B7A3" />
          {[30, 116, 202, 288, 366].map(x => (
            <g key={x}>
              <rect x={x} y="70" width="26" height="150" rx="4" fill="#EDE5D6" />
              <rect x={x - 5} y="62" width="36" height="10" rx="3" fill="#C2B7A3" />
            </g>
          ))}
          <rect x="140" y="132" width="132" height="120" rx="4" fill={FARM.woodDark} />
          <text x="206" y="26" textAnchor="middle" fill={FARM.barnDark} fontSize="17" fontWeight="800"
            letterSpacing="3" fontFamily="system-ui, sans-serif">BANK</text>
        </g>
        <Sam x={132} y={392} s={0.92} pose="carrying" />
        <g transform="translate(96 292)"><Paper x={0} y={0} w={78} h={54} rows={4} title="PLAN?" /></g>
        <Beehive x={668} y={384} s={1.05} /><Beehive x={748} y={390} s={0.85} d={1.3} />
      </>
    );
  }

  /* 1 — not a story about honey. a plan, with months in it. */
  if (beat === 1) {
    return (
      <>
        <defs>
          <linearGradient id={`${uid}s6plain`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8ECFE8" /><stop offset="100%" stopColor="#DFF1F8" />
          </linearGradient>
        </defs>
        <rect width="800" height="400" fill={`url(#${uid}s6plain)`} />
        <Cloud x={-60} y={54} s={1} o={0.8} slow d={-16} />
        <path d="M0 268 q 200 -24 400 -6 q 200 20 400 -10 L800 400 L0 400 Z" fill={FARM.leafMid} />
        <Ground y={310} fill={FARM.leaf} />
        <g transform="translate(84 148)">
          <g className="fs-lift"><HoneyPyramid glint={false} /></g>
          <g stroke={FARM.barn} strokeWidth="7" strokeLinecap="round" opacity="0.8">
            <line x1="-4" y1="-24" x2="112" y2="72" /><line x1="112" y1="-24" x2="-4" y2="72" />
          </g>
        </g>
        <Calendar x={330} y={150} s={1.12} />
        <Sam x={252} y={392} s={0.9} pose="pointing" />
      </>
    );
  }

  /* 2 — five questions about products. this one is not. */
  return (
    <>
      {bands.map(b => (
        <g key={b.label}>
          <rect x={b.x} y="0" width="200" height="400" fill={b.sky} />
          <rect x={b.x} y="252" width="200" height="148" fill={b.ground} />
        </g>
      ))}
      {[200, 400, 600].map(x => (
        <rect key={x} x={x - 26} y="0" width="52" height="400" fill="#FFFFFF" opacity="0.06" />
      ))}
      <Cloud x={-60} y={58} s={1.2} fill="#A3B3C4" o={0.7} slow d={-25} />
      <Sun x={506} y={72} r={26} />
      <Sun x={694} y={86} r={22} glow="#F0A46A" />
      <Bird x={0} y={92} s={0.7} d={-14} />

      <g clipPath={`url(#${uid}s6winter)`}>
        {Array.from({ length: 14 }).map((_, i) => (
          <circle key={i} className="fs-fall" style={delay(-(i * 0.64))}
            cx={(i * 37) % 200} cy={0} r="2.2" fill={FARM.cream} opacity="0.75" />
        ))}
      </g>
      <g clipPath={`url(#${uid}s6autumn)`}>
        {Array.from({ length: 10 }).map((_, i) => (
          <ellipse key={i} className="fs-fall" style={delay(-(i * 0.9))}
            cx={610 + ((i * 41) % 180)} cy={0} rx="4" ry="2.4" fill={i % 2 ? '#C77B3C' : '#A85C2E'} opacity="0.8" />
        ))}
      </g>
      <defs>
        <clipPath id={`${uid}s6winter`}><rect x="0" y="0" width="200" height="330" /></clipPath>
        <clipPath id={`${uid}s6autumn`}><rect x="600" y="0" width="200" height="340" /></clipPath>
      </defs>

      <path d="M0 252 q 200 -22 400 -4 q 200 20 400 -8 L800 400 L0 400 Z" fill="#000000" opacity="0.06" />
      <Tree x={54} y={256} s={0.8} bare /><Tree x={132} y={260} s={0.6} bare d={1.4} />
      <Hen x={92} y={296} s={0.6} d={0.8} />
      <Tree x={252} y={258} s={0.78} canopy="#8FC46F" d={0.6} />
      <CropRow y={302} from={210} to={392} step={17} h={11} fill="#4E8B44" o={0.85} />
      <Barn x={430} y={256} s={0.5} />
      <CropRow y={310} from={404} to={596} step={13} h={26} fill="#4E7C3E" />
      <g transform="translate(540 268)">
        {[0, 22, 44].map((x, i) => (
          <g key={i} transform={`translate(${x} ${i === 1 ? -8 : 0})`}>
            <rect x="0" y="0" width="15" height="15" rx="3" fill={FARM.honey} />
            <rect x="1" y="-3" width="13" height="4" rx="1.5" fill={FARM.barnDark} />
          </g>
        ))}
      </g>
      <Tree x={664} y={258} s={0.85} canopy="#C77B3C" d={1.9} /><Tree x={746} y={262} s={0.65} canopy="#A85C2E" d={0.3} />
      <CropRow y={330} from={606} to={790} step={19} h={9} fill="#8A6A38" o={0.7} />

      <g className="fs-walk"><Sam x={60} y={340} s={0.62} pose="walking" /></g>

      {bands.map(b => (
        <g key={b.label + 'l'}>
          <rect x={b.x + 44} y="352" width="112" height="28" rx="14" fill={FARM.night} opacity="0.35" />
          <text x={b.x + 100} y="371" textAnchor="middle" fill={FARM.cream}
            fontSize="14" fontWeight="700" letterSpacing="1.5" fontFamily="system-ui, sans-serif">
            {b.label.toUpperCase()}
          </text>
        </g>
      ))}
    </>
  );
};

const SCENES: Record<SceneKey, React.FC<SceneProps>> = {
  'sunrise-farm': SunriseFarm,
  'market-stall': MarketStall,
  'winter-field': WinterField,
  'loading-van': LoadingVan,
  'cafe-delivery': CafeDelivery,
  'year-panorama': YearPanorama,
};

/** Per-beat alt text, so the picture is described as precisely as it is drawn. */
const SCENE_ALT: Record<SceneKey, string[]> = {
  'sunrise-farm': [
    'Foxglove Farm at sunrise: the farm sign, a flock of hens, the van, and Sam beside the barn.',
    'Three labelled vignettes: the Saturday market stall, the farm gate, and two cafés.',
    'A market counter with a shoebox stuffed with a year of receipts tucked underneath.',
    'Sam scratching his head at the tipped-over shoebox while his sister asks him a question.',
  ],
  'market-stall': [
    'Half past six, still dark. Sam raising the stall frame with the van parked beside him.',
    'Mid-morning: sacks of potatoes moving fast, shoppers at the table, Sam carrying more.',
    'The honey pyramid at the back of the stall, barely touched. Four jars sold.',
    'All eight products laid out on the table, with the question of what to count.',
  ],
  'winter-field': [
    'November. Rain sideways across bare trees and an empty field.',
    'The stall in winter, holding only eggs, jam and potatoes.',
    'Last chapter\'s summer chart crossed out, beside the lit polytunnel.',
  ],
  'loading-van': [
    'The van loaded with five crates and a sixth left on the ground, marked no room.',
    'Five in the morning: Sam in the cold in front of eight crates, guessing which five.',
    'Sam at the kitchen table under a lamp, the whole year spread out in front of him.',
  ],
  'cafe-delivery': [
    'Outside the café on Bridge Street, the owner asking Sam whether he can send more.',
    'Sam saying yes, with a question mark hanging over what he has just agreed to.',
    'Stall, gate and café orders flowing into a single spreadsheet.',
  ],
  'year-panorama': [
    'Sam outside the bank carrying a plan, with beehives waiting at the roadside.',
    'The honey chart crossed out beside a twelve-month calendar with summer lit up.',
    'Sam walking the same field across winter, spring, summer and autumn.',
  ],
};

export const FarmScene: React.FC<{
  scene: SceneKey;
  /** Which beat of the chapter to stage. Clamped to the frames that exist. */
  beat?: number;
  className?: string;
  /**
   * Every scene puts its subject on the ground, so wide, short crops should
   * anchor to the bottom ("ground") rather than centring on empty sky.
   */
  anchor?: 'centre' | 'ground';
}> = ({ scene, beat = 0, className, anchor = 'centre' }) => {
  const Painting = SCENES[scene];
  const alts = SCENE_ALT[scene];
  const frame = Math.max(0, Math.min(beat, alts.length - 1));
  // Gradient and clip-path ids live in one document-wide namespace, so two
  // scenes on screen at once (a crossfade, a card grid) would share whichever
  // was defined first. Namespacing them per instance keeps each scene its own.
  const uid = React.useId().replace(/:/g, '');
  return (
    <svg
      viewBox="0 0 800 400"
      className={`fs ${className ?? ''}`}
      preserveAspectRatio={anchor === 'ground' ? 'xMidYMax slice' : 'xMidYMid slice'}
      role="img"
      aria-label={alts[frame]}
    >
      <Motion />
      <Painting beat={frame} uid={uid} />
    </svg>
  );
};

/** How many distinct frames a chapter's scene can stage. */
export const sceneFrameCount = (scene: SceneKey): number => SCENE_ALT[scene].length;

export default FarmScene;
