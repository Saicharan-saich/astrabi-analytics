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

// ── Scene 1 · dawn, and a shoebox full of paper ────────────────────

const SunriseFarm = () => (
  <>
    <defs>
      <linearGradient id="s1sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#8FC6E0" /><stop offset="45%" stopColor="#FFD59B" />
        <stop offset="100%" stopColor="#FFB27A" />
      </linearGradient>
      <linearGradient id="s1field" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#6FA556" /><stop offset="100%" stopColor="#4E7C3E" />
      </linearGradient>
    </defs>
    <rect width="800" height="400" fill="url(#s1sky)" />
    <Sun x={168} y={214} r={40} rise />
    <Cloud x={-60} y={70} s={1.1} fill="#FFE9CF" o={0.85} slow d={-20} />
    <Cloud x={-60} y={48} s={0.75} fill="#FFF0DC" o={0.7} d={-38} />
    <Bird x={0} y={96} s={1.1} d={-6} /><Bird x={0} y={78} s={0.8} d={-22} /><Bird x={0} y={70} s={0.7} d={-34} />

    <path d="M0 246 q 120 -34 240 -8 q 130 28 250 -14 q 170 -32 310 6 L800 400 L0 400 Z" fill={FARM.leafFar} />
    <path d="M0 274 q 160 -26 300 2 q 150 30 300 -12 q 120 -22 200 4 L800 400 L0 400 Z" fill={FARM.leafMid} />
    <Ground y={300} fill="url(#s1field)" />

    <g opacity="0.45">
      {[312, 330, 350, 372, 396].map((y, i) => (
        <path key={y} d={`M0 ${y} q 400 ${-10 - i * 3} 800 ${i * 2}`} stroke={FARM.soilDark} strokeWidth={2 + i * 0.8} fill="none" />
      ))}
    </g>

    <Tree x={92} y={302} s={1.05} canopy="#4F8241" />
    <Tree x={738} y={306} s={0.85} canopy="#5C8F4A" d={1.6} />
    <Barn x={506} y={300} s={0.95} />
    <Fence y={300} from={140} to={452} />

    <CropRow y={334} from={20} to={780} step={26} h={16} fill="#3F6B33" o={0.5} />
    <Hen x={214} y={320} s={0.72} d={0.4} />
    <Hen x={258} y={326} s={0.64} flip d={1.9} />

    {/* the shoebox, tipped over, receipts still escaping */}
    <g transform="translate(96 352)">
      <ellipse cx="60" cy="30" rx="88" ry="10" fill={FARM.soilDark} opacity="0.25" />
      <rect x="14" y="-2" width="96" height="32" rx="3" fill="#D9C7A8" />
      <rect x="14" y="-2" width="96" height="9" rx="3" fill="#C4AE8C" />
      <path d="M104 -2 L146 -18 L156 6 L114 22 Z" fill="#E8DCC4" />
      {[[126, -32, -14, 0], [152, -26, 8, 0.7], [172, -16, 22, 1.4], [186, -34, -6, 2.1]].map(([x, y, rot, dl], i) => (
        <g key={i} className="fs-flutter" style={delay(dl as number)}>
          <g transform={`rotate(${rot} ${(x as number) + 13} ${(y as number) + 17})`}>
            <rect x={x} y={y} width="26" height="34" rx="2" fill={FARM.cream} stroke="#E0D3B8" strokeWidth="1" />
            <g stroke="#BFB096" strokeWidth="1.6" strokeLinecap="round">
              <line x1={(x as number) + 5} y1={(y as number) + 9} x2={(x as number) + 21} y2={(y as number) + 9} />
              <line x1={(x as number) + 5} y1={(y as number) + 15} x2={(x as number) + 17} y2={(y as number) + 15} />
              <line x1={(x as number) + 5} y1={(y as number) + 21} x2={(x as number) + 19} y2={(y as number) + 21} />
              <line x1={(x as number) + 5} y1={(y as number) + 27} x2={(x as number) + 13} y2={(y as number) + 27} />
            </g>
          </g>
        </g>
      ))}
    </g>

    {/* Sam, wondering what any of it means */}
    <Sam x={352} y={392} s={0.92} pose="thinking" />
  </>
);

// ── Scene 2 · Saturday market ──────────────────────────────────────

const MarketStall = () => (
  <>
    <defs>
      <linearGradient id="s2sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#8ECFE8" /><stop offset="100%" stopColor="#DFF1F8" />
      </linearGradient>
    </defs>
    <rect width="800" height="400" fill="url(#s2sky)" />
    <Sun x={676} y={78} r={30} />
    <Cloud x={-60} y={62} s={1} o={0.85} slow d={-14} />
    <Cloud x={-60} y={44} s={0.7} o={0.7} d={-40} />
    <Bird x={0} y={92} s={0.8} d={-10} /><Bird x={0} y={76} s={0.6} d={-28} />

    <g opacity="0.28" fill={FARM.slate}>
      <path d="M0 214 L0 170 L52 138 L104 170 L104 214 Z" />
      <path d="M118 214 L118 156 L166 128 L214 156 L214 214 Z" />
      <path d="M596 214 L596 148 L648 118 L700 148 L700 214 Z" />
      <path d="M712 214 L712 168 L756 142 L800 168 L800 214 Z" />
    </g>
    <Tree x={272} y={216} s={0.8} canopy="#6FA556" />
    <Tree x={556} y={218} s={0.7} canopy="#7FB069" d={2.2} />

    <rect y="212" width="800" height="188" fill="#C9BFA8" />
    <g opacity="0.35" stroke="#A99C82" strokeWidth="1.6">
      {[236, 268, 306, 350, 396].map(y => <line key={y} x1="0" y1={y} x2="800" y2={y} />)}
      {[90, 220, 350, 480, 610, 740].map(x => <line key={x} x1={x} y1="212" x2={x} y2="400" />)}
    </g>

    <g transform="translate(232 200)">
      <line x1="14" y1="0" x2="14" y2="150" stroke={FARM.woodDark} strokeWidth="7" />
      <line x1="322" y1="0" x2="322" y2="150" stroke={FARM.woodDark} strokeWidth="7" />
      <path d="M-6 4 L342 4 L342 -14 L-6 -14 Z" fill={FARM.barnDark} />
      <g className="fs-sway-s" style={{ transformOrigin: '50% 0%' }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <path key={i} d={`M${-6 + i * 43.5} 4 L${-6 + (i + 1) * 43.5} 4 L${-6 + (i + 1) * 43.5 - 8} 40 L${-6 + i * 43.5 - 8} 40 Z`}
            fill={i % 2 ? FARM.cream : FARM.barn} />
        ))}
        <path d="M-14 38 q 174 16 350 0 l 0 12 q -176 16 -350 0 Z" fill={FARM.cream} opacity="0.95" />
      </g>

      <rect x="-4" y="96" width="338" height="16" rx="3" fill={FARM.wood} />
      <rect x="-4" y="112" width="338" height="8" fill={FARM.woodDark} />

      <g transform="translate(6 60)">
        <rect x="0" y="14" width="72" height="22" rx="3" fill={FARM.woodDark} />
        {[10, 26, 42, 58, 18, 34, 50].map((x, i) => (
          <circle key={i} cx={x} cy={i > 3 ? 6 : 14} r="7.5" fill={i % 2 ? '#C0392B' : '#D9534F'} />
        ))}
      </g>
      <g transform="translate(92 62)">
        <rect x="0" y="12" width="66" height="24" rx="3" fill={FARM.woodDark} />
        {[12, 28, 44, 20, 36].map((x, i) => (
          <ellipse key={i} cx={x} cy={i > 2 ? 6 : 14} rx="9" ry="7" fill={i % 2 ? '#B98A54' : '#A9784F'} />
        ))}
      </g>
      {/* the honey pyramid, catching the light */}
      <g transform="translate(196 44)">
        <ellipse cx="52" cy="56" rx="60" ry="9" fill={FARM.honey} opacity="0.16" />
        {[[16, 34], [46, 34], [76, 34], [31, 8], [61, 8], [46, -18]].map(([x, y], i) => (
          <g key={i} transform={`translate(${x} ${y})`}>
            <rect x="0" y="0" width="24" height="24" rx="4" fill={FARM.honey} />
            <rect x="0" y="0" width="24" height="9" rx="4" fill="#F2B950" />
            <rect x="2" y="-5" width="20" height="6" rx="2" fill={FARM.barnDark} />
            <rect x="4" y="10" width="16" height="8" rx="1.5" fill={FARM.cream} opacity="0.85" />
            <rect className="fs-glint" style={delay(i * 0.9)} x="3" y="2" width="5" height="18" rx="2.5" fill="#FFFFFF" />
          </g>
        ))}
      </g>
      <g transform="translate(-26 116)">
        <rect x="0" y="0" width="58" height="44" rx="4" fill={FARM.night} />
        <rect x="0" y="0" width="58" height="44" rx="4" fill="none" stroke={FARM.wood} strokeWidth="4" />
        <g stroke={FARM.cream} strokeWidth="2" strokeLinecap="round" opacity="0.8">
          <line x1="10" y1="14" x2="42" y2="14" /><line x1="10" y1="24" x2="36" y2="24" /><line x1="10" y1="34" x2="44" y2="34" />
        </g>
      </g>
    </g>

    {/* sacks of potatoes, doing the heavy lifting */}
    <g transform="translate(596 300)">
      {[[0, 0, 1], [56, 6, 0.9], [28, -34, 0.8]].map(([x, y, s], i) => (
        <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
          <path d="M0 46 q -6 -46 22 -50 q 28 4 22 50 Z" fill="#9E8A6B" />
          <path d="M12 -6 q 10 -8 20 0 q -10 5 -20 0 Z" fill="#8A785C" />
          <ellipse cx="22" cy="46" rx="24" ry="5" fill={FARM.soilDark} opacity="0.2" />
        </g>
      ))}
    </g>
    <Crate x={96} y={332} w={62} h={38} contents="#D9534F" />

    {/* Sam at the end of the stall, clear of the honey */}
    <Sam x={720} y={392} s={0.86} pose="idle" flip />
  </>
);

// ── Scene 3 · November, and a half-empty table ─────────────────────

const WinterField = () => (
  <>
    <defs>
      <linearGradient id="s3sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#8496AC" /><stop offset="100%" stopColor="#C6D4DF" />
      </linearGradient>
      <linearGradient id="s3tunnel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#FFE3A8" /><stop offset="100%" stopColor="#F0C877" />
      </linearGradient>
    </defs>
    <rect width="800" height="400" fill="url(#s3sky)" />
    <Cloud x={-60} y={58} s={1.4} fill="#93A5B8" o={0.75} slow d={-30} />
    <Cloud x={-60} y={40} s={1.1} fill="#A3B3C4" o={0.7} slow d={-55} />

    {/* rain */}
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

    <path d="M0 236 q 180 -20 360 0 q 200 22 440 -6 L800 400 L0 400 Z" fill="#8FA98C" />
    <Ground y={278} fill="#7C9377" />
    <g opacity="0.4">
      {[292, 314, 342, 376].map((y, i) => (
        <path key={y} d={`M0 ${y} q 400 ${-8 - i * 2} 800 ${i * 3}`} stroke="#5F7659" strokeWidth={2 + i} fill="none" />
      ))}
    </g>
    <ellipse cx="250" cy="360" rx="86" ry="10" fill="#AFC4D2" opacity="0.55" />
    <ellipse cx="612" cy="386" rx="70" ry="9" fill="#AFC4D2" opacity="0.45" />

    <Tree x={86} y={280} s={1} bare /><Tree x={166} y={286} s={0.75} bare d={1.1} />
    <Tree x={726} y={284} s={0.9} bare d={2.3} />

    <g transform="translate(430 176)">
      <path d="M0 104 L0 44 q 96 -58 192 0 L192 104 Z" fill="url(#s3tunnel)" opacity="0.92" />
      <path d="M0 104 L0 44 q 96 -58 192 0 L192 104 Z" fill="none" stroke={FARM.cream} strokeWidth="3" opacity="0.7" />
      <g stroke={FARM.cream} strokeWidth="2.4" opacity="0.55" fill="none">
        <path d="M38 104 L38 26" /><path d="M96 104 L96 16" /><path d="M154 104 L154 26" />
      </g>
      <ellipse className="fs-pulse" cx="96" cy="118" rx="130" ry="16" fill={FARM.honey} />
    </g>

    <Fence y={288} from={210} to={412} />
    <Hen x={252} y={312} s={0.8} d={0.2} />
    <Hen x={300} y={318} s={0.7} flip d={1.5} />
    <Hen x={340} y={308} s={0.65} d={2.7} />

    {/* the near-empty stall */}
    <g transform="translate(78 292)">
      <rect x="0" y="34" width="176" height="12" rx="3" fill={FARM.wood} />
      <rect x="0" y="46" width="176" height="7" fill={FARM.woodDark} />
      <line x1="10" y1="46" x2="10" y2="92" stroke={FARM.woodDark} strokeWidth="5" />
      <line x1="166" y1="46" x2="166" y2="92" stroke={FARM.woodDark} strokeWidth="5" />
      <g transform="translate(10 12)">
        <rect x="0" y="10" width="42" height="12" rx="2" fill="#C9B79A" />
        {[7, 18, 29].map(x => <ellipse key={x} cx={x} cy={9} rx="5.5" ry="7" fill={FARM.cream} />)}
      </g>
      {[62, 86, 110].map((x, i) => (
        <g key={x} transform={`translate(${x} ${8}) scale(0.8)`}>
          <rect x="0" y="0" width="22" height="26" rx="4" fill="#C0392B" opacity="0.85" />
          <rect x="0" y="0" width="22" height="8" rx="4" fill="#D9534F" />
          <rect x="2" y="-4" width="18" height="5" rx="2" fill={FARM.cream} />
        </g>
      ))}
      <g transform="translate(134 20)">
        {[0, 13, 6].map((x, i) => <ellipse key={i} cx={x + 6} cy={i === 2 ? 3 : 12} rx="8" ry="6" fill="#A9784F" />)}
      </g>
    </g>

    {/* Sam, out in it, breath showing */}
    <Sam x={398} y={394} s={0.86} pose="idle" flip />
    <SpeechPuff x={374} y={334} s={0.9} />
  </>
);

// ── Scene 4 · five in the morning, five crates ─────────────────────

const LoadingVan = () => (
  <>
    <defs>
      <linearGradient id="s4sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#33456B" /><stop offset="55%" stopColor="#8E6E86" />
        <stop offset="100%" stopColor="#F0A46A" />
      </linearGradient>
      <radialGradient id="s4beam" cx="0" cy="0.5" r="1">
        <stop offset="0%" stopColor="#FFE9B8" stopOpacity="0.75" />
        <stop offset="100%" stopColor="#FFE9B8" stopOpacity="0" />
      </radialGradient>
    </defs>
    <rect width="800" height="400" fill="url(#s4sky)" />
    {[[92, 44], [188, 76], [276, 36], [404, 62], [520, 30], [636, 84], [724, 50], [148, 112], [352, 106], [596, 118]].map(([x, y], i) => (
      <circle key={i} className="fs-twinkle" style={delay(i * 0.55)} cx={x} cy={y} r={i % 3 === 0 ? 2 : 1.4} fill={FARM.cream} />
    ))}
    <Sun x={702} y={252} r={30} glow="#FFB870" rise />

    <path d="M0 258 q 150 -28 300 -6 q 180 26 340 -12 q 110 -22 160 2 L800 400 L0 400 Z" fill="#4A4257" />
    <Ground y={296} fill="#3A3448" />
    <Barn x={44} y={296} s={0.72} />
    <Tree x={264} y={298} s={0.8} canopy="#3E5540" />

    <path className="fs-pulse" d="M156 320 L-40 268 L-40 388 Z" fill="url(#s4beam)" opacity="0.3" />

    <g transform="translate(190 176)">
      <ellipse cx="220" cy="152" rx="220" ry="14" fill="#241F30" opacity="0.5" />
      <path d="M28 40 L250 40 L250 132 L28 132 Z" fill={FARM.cream} />
      <path d="M250 62 L296 62 L342 104 L342 132 L250 132 Z" fill="#EFE3CE" />
      <path d="M258 68 L292 68 L328 102 L258 102 Z" fill="#7FA8C4" />
      <path d="M258 68 L282 68 L258 92 Z" fill="#A8C8DC" opacity="0.7" />
      <path d="M28 40 L-24 22 L-24 122 L28 132 Z" fill="#E4D7C0" />
      <path d="M-24 22 L-30 24 L-30 124 L-24 122 Z" fill={FARM.woodDark} opacity="0.5" />
      <rect x="52" y="66" width="150" height="34" rx="4" fill={FARM.leaf} opacity="0.22" />
      <g stroke={FARM.leaf} strokeWidth="3.4" strokeLinecap="round" opacity="0.75">
        <line x1="64" y1="78" x2="150" y2="78" /><line x1="64" y1="90" x2="120" y2="90" />
      </g>
      <circle cx="86" cy="134" r="24" fill="#241F30" />
      <g className="fs-spin"><circle cx="86" cy="134" r="10" fill="#5A5468" /></g>
      <circle cx="300" cy="134" r="24" fill="#241F30" />
      <g className="fs-spin"><circle cx="300" cy="134" r="10" fill="#5A5468" /></g>
      <ellipse className="fs-pulse" cx="340" cy="112" rx="7" ry="9" fill="#FFEBB8" opacity="0.9" />
      {/* five crates, loaded */}
      <g transform="translate(40 48)">
        <Crate x={0} y={40} w={44} h={28} contents={FARM.honey} />
        <Crate x={50} y={40} w={44} h={28} contents={FARM.cream} />
        <Crate x={100} y={40} w={44} h={28} contents="#D9534F" />
        <Crate x={25} y={10} w={44} h={28} contents="#A9784F" />
        <Crate x={75} y={10} w={44} h={28} contents="#C0392B" />
      </g>
    </g>

    {/* the crate that did not make the cut */}
    <g transform="translate(88 336)">
      <Crate x={0} y={0} w={54} h={32} contents="#E8C86A" />
      <path d="M-8 -4 l 70 44 M62 -4 l -70 44" stroke="#D9534F" strokeWidth="4" strokeLinecap="round" opacity="0.55" />
    </g>

    {/* Sam, mid-load */}
    <g className="fs-lift">
      <Sam x={222} y={392} s={0.86} pose="carrying" />
      <g transform="translate(200 330)">
        <Crate x={0} y={0} w={44} h={26} contents={FARM.honey} />
      </g>
    </g>
  </>
);

// ── Scene 5 · Bridge Street, Thursday ──────────────────────────────

const CafeDelivery = () => (
  <>
    <defs>
      <linearGradient id="s5sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#A9D6E8" /><stop offset="100%" stopColor="#E8F3F7" />
      </linearGradient>
      <linearGradient id="s5win" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#FFE6AE" /><stop offset="100%" stopColor="#F5C46B" />
      </linearGradient>
    </defs>
    <rect width="800" height="400" fill="url(#s5sky)" />
    <Cloud x={-60} y={48} s={0.9} o={0.8} slow d={-18} />
    <Cloud x={-60} y={34} s={0.7} o={0.65} d={-46} />
    <Bird x={0} y={54} s={0.7} d={-8} /><Bird x={0} y={40} s={0.55} d={-26} />

    <rect x="0" y="96" width="150" height="216" fill="#C7B9A6" />
    <rect x="0" y="96" width="150" height="14" fill="#A99A85" />
    <rect x="24" y="140" width="46" height="60" rx="3" fill="#9FB5C4" opacity="0.7" />
    <rect x="92" y="140" width="40" height="60" rx="3" fill="#9FB5C4" opacity="0.55" />
    <rect x="650" y="82" width="150" height="230" fill="#BFAF9C" />
    <rect x="650" y="82" width="150" height="14" fill="#A0917C" />
    <rect x="682" y="128" width="44" height="66" rx="3" fill="#9FB5C4" opacity="0.6" />

    <g transform="translate(168 70)">
      <rect x="0" y="0" width="470" height="242" fill="#E8DAC4" />
      <rect x="0" y="0" width="470" height="20" rx="3" fill={FARM.barnDark} />
      <g transform="translate(408 24)">
        <line x1="0" y1="0" x2="0" y2="16" stroke={FARM.woodDark} strokeWidth="3" />
        <g className="fs-sway-s" style={{ transformOrigin: '50% 0%' }}>
          <rect x="-46" y="16" width="92" height="42" rx="5" fill={FARM.leaf} />
          <g stroke={FARM.cream} strokeWidth="3" strokeLinecap="round" opacity="0.85">
            <line x1="-30" y1="32" x2="30" y2="32" /><line x1="-22" y1="44" x2="22" y2="44" />
          </g>
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
      <rect x="34" y="98" width="180" height="112" rx="5" fill="url(#s5win)" />
      <rect x="34" y="98" width="180" height="112" rx="5" fill="none" stroke={FARM.woodDark} strokeWidth="5" />
      <line x1="124" y1="98" x2="124" y2="210" stroke={FARM.woodDark} strokeWidth="4" />
      <g fill={FARM.barnDark} opacity="0.35">
        <circle cx="72" cy="140" r="12" /><path d="M52 176 q 20 -26 40 0 Z" />
        <circle cx="168" cy="146" r="11" /><path d="M150 178 q 18 -24 36 0 Z" />
        <rect x="96" y="168" width="48" height="5" rx="2" />
      </g>
      <SpeechPuff x={114} y={162} s={0.8} />
      <rect x="256" y="106" width="72" height="136" rx="4" fill={FARM.woodDark} />
      <rect x="266" y="118" width="52" height="62" rx="3" fill="url(#s5win)" opacity="0.9" />
      <circle cx="318" cy="180" r="4" fill={FARM.honey} />
      <g transform="translate(358 168)">
        <path d="M0 74 L14 20 L58 20 L72 74 Z" fill={FARM.woodDark} opacity="0.35" />
        <rect x="8" y="8" width="56" height="60" rx="4" fill={FARM.night} />
        <rect x="8" y="8" width="56" height="60" rx="4" fill="none" stroke={FARM.wood} strokeWidth="4" />
        <g stroke={FARM.cream} strokeWidth="2.2" strokeLinecap="round" opacity="0.8">
          <line x1="18" y1="24" x2="52" y2="24" /><line x1="18" y1="36" x2="46" y2="36" />
          <line x1="18" y1="48" x2="54" y2="48" />
        </g>
      </g>
    </g>

    <rect y="312" width="800" height="88" fill="#BDB5A8" />
    <g opacity="0.35" stroke="#9A9184" strokeWidth="1.8">
      {[336, 366].map(y => <line key={y} x1="0" y1={y} x2="800" y2={y} />)}
      {[70, 190, 310, 430, 550, 670].map(x => <line key={x} x1={x} y1="312" x2={x} y2="400" />)}
    </g>

    <g transform="translate(64 296)">
      <Crate x={0} y={22} w={58} h={34} contents={FARM.honey} />
      <Crate x={66} y={22} w={58} h={34} contents={FARM.cream} />
      <Crate x={33} y={-12} w={58} h={34} contents="#D9534F" />
      <ellipse cx="62" cy="62" rx="80" ry="8" fill={FARM.woodDark} opacity="0.2" />
    </g>

    <g transform="translate(660 322)" stroke={FARM.night} strokeWidth="3.4" fill="none" opacity="0.7">
      <circle cx="18" cy="42" r="18" /><circle cx="86" cy="42" r="18" />
      <path d="M18 42 L48 42 L64 14 L86 42 M48 42 L58 14 L74 14" />
      <path d="M58 14 L52 6" strokeLinecap="round" />
    </g>

    {/* Sam, taking the order */}
    <Sam x={252} y={392} s={0.9} pose="pointing" />
  </>
);

// ── Scene 6 · one field, four seasons ──────────────────────────────

const YearPanorama = () => {
  const bands = [
    { x: 0, sky: '#9FB3C8', ground: '#8FA98C', label: 'Winter' },
    { x: 200, sky: '#BBD9E8', ground: '#7FB069', label: 'Spring' },
    { x: 400, sky: '#8ECFE8', ground: '#6FA556', label: 'Summer' },
    { x: 600, sky: '#E8C88F', ground: '#B08A4A', label: 'Autumn' },
  ];
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
      <Cloud x={-60} y={44} s={0.85} o={0.8} d={-50} />
      <Sun x={506} y={72} r={28} />
      <Sun x={694} y={86} r={24} glow="#F0A46A" />
      <Bird x={0} y={92} s={0.7} d={-14} /><Bird x={0} y={78} s={0.55} d={-32} />

      {/* snow over winter, leaves over autumn */}
      <g clipPath="url(#s6winter)">
        {Array.from({ length: 14 }).map((_, i) => (
          <circle key={i} className="fs-fall" style={delay(-(i * 0.64))}
            cx={(i * 37) % 200} cy={0} r="2.2" fill={FARM.cream} opacity="0.75" />
        ))}
      </g>
      <g clipPath="url(#s6autumn)">
        {Array.from({ length: 10 }).map((_, i) => (
          <ellipse key={i} className="fs-fall" style={delay(-(i * 0.9))}
            cx={610 + ((i * 41) % 180)} cy={0} rx="4" ry="2.4" fill={i % 2 ? '#C77B3C' : '#A85C2E'} opacity="0.8" />
        ))}
      </g>
      <defs>
        <clipPath id="s6winter"><rect x="0" y="0" width="200" height="330" /></clipPath>
        <clipPath id="s6autumn"><rect x="600" y="0" width="200" height="340" /></clipPath>
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
            <rect className="fs-glint" style={delay(i * 1.2)} x="2" y="2" width="4" height="11" rx="2" fill="#FFFFFF" />
          </g>
        ))}
      </g>
      <Tree x={664} y={258} s={0.85} canopy="#C77B3C" d={1.9} /><Tree x={746} y={262} s={0.65} canopy="#A85C2E" d={0.3} />
      <g transform="translate(608 284)">
        {[[0, 0], [30, 6], [60, 0]].map(([x, y], i) => (
          <g key={i} transform={`translate(${x} ${y})`}>
            <path d="M0 26 q -4 -26 13 -28 q 17 2 13 28 Z" fill="#9E8A6B" />
          </g>
        ))}
      </g>
      <CropRow y={330} from={606} to={790} step={19} h={9} fill="#8A6A38" o={0.7} />

      {/* Sam walks the whole year, winter through to autumn */}
      <g className="fs-walk">
        <Sam x={60} y={340} s={0.62} pose="walking" />
      </g>

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

const SCENES: Record<SceneKey, React.FC> = {
  'sunrise-farm': SunriseFarm,
  'market-stall': MarketStall,
  'winter-field': WinterField,
  'loading-van': LoadingVan,
  'cafe-delivery': CafeDelivery,
  'year-panorama': YearPanorama,
};

const SCENE_ALT: Record<SceneKey, string> = {
  'sunrise-farm': 'Sunrise over Foxglove Farm. Sam stands scratching his head beside a tipped-over shoebox, receipts fluttering across the field.',
  'market-stall': 'Sam behind his Saturday market stall, sacks of potatoes beside a small pyramid of honey jars.',
  'winter-field': 'The farm in November: rain, bare trees, a lit polytunnel, and Sam beside a stall holding only eggs, jam and potatoes.',
  'loading-van': 'Sam loading crates into the van before dawn, with a sixth crate left behind on the ground.',
  'cafe-delivery': 'Sam outside a café on Bridge Street, crates of honey, eggs and strawberries stacked on the pavement.',
  'year-panorama': 'Sam walking through the same field across winter, spring, summer and autumn.',
};

export const FarmScene: React.FC<{
  scene: SceneKey;
  className?: string;
  /**
   * Every scene puts its subject on the ground, so wide, short crops should
   * anchor to the bottom ("ground") rather than centring on empty sky.
   */
  anchor?: 'centre' | 'ground';
}> = ({ scene, className, anchor = 'centre' }) => {
  const Painting = SCENES[scene];
  return (
    <svg
      viewBox="0 0 800 400"
      className={`fs ${className ?? ''}`}
      preserveAspectRatio={anchor === 'ground' ? 'xMidYMax slice' : 'xMidYMid slice'}
      role="img"
      aria-label={SCENE_ALT[scene]}
    >
      <Motion />
      <Painting />
    </svg>
  );
};

export default FarmScene;
