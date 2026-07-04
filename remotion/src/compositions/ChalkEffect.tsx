// ChalkEffect — hand-drawn chalk underline + circle (graphics_notes: "chalk").
// Chalk feel = wobbly path + a per-frame 1px jitter + a faint dashed ghost stroke
// underneath (dust). Positioned in the lower third under where the hook text sits.

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

export type ChalkEffectProps = { accent: string };

export const ChalkEffect: React.FC<ChalkEffectProps> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const draw = (from: number, to: number) =>
    interpolate(frame, [from, to], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const fade = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // subtle hand-jitter — deterministic per frame (no Math.random: renders must be pure)
  const jx = Math.sin(frame * 1.7) * 1.2;
  const jy = Math.cos(frame * 2.3) * 1.2;
  const underline = 'M 140 1480 C 320 1462, 620 1498, 940 1470';
  const circle = 'M 540 1330 C 760 1300, 900 1360, 880 1440 C 860 1530, 420 1560, 260 1500 C 130 1450, 260 1350, 500 1336';
  const stroke = (d: string, p: number, w: number, o: number, dash?: string) => (
    <path
      d={d}
      pathLength={1}
      fill="none"
      stroke={accent}
      strokeWidth={w}
      strokeLinecap="round"
      opacity={o}
      strokeDasharray={dash ?? 1}
      strokeDashoffset={dash ? 0 : 1 - p}
    />
  );
  return (
    <AbsoluteFill style={{ opacity: fade, transform: `translate(${jx}px, ${jy}px)` }}>
      <svg width="1080" height="1920" viewBox="0 0 1080 1920">
        {/* dust ghost under the main strokes */}
        {draw(4, 22) > 0.5 && stroke(underline, 1, 16, 0.18, '.02 .015')}
        {stroke(underline, draw(4, 22), 11, 0.92)}
        {stroke(circle, draw(20, 52), 10, 0.85)}
      </svg>
    </AbsoluteFill>
  );
};
