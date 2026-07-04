// MotionCurveAccents — accent-color swooshes drawn along the frame edges
// (graphics_notes: "motion curves"). pathLength=1 normalizes every path so a
// single dashoffset interpolation draws any curve tip-to-tail.

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

export type MotionCurveAccentsProps = { accent: string };

const Curve: React.FC<{ d: string; accent: string; draw: number; width: number }> = ({ d, accent, draw, width }) => (
  <path
    d={d}
    pathLength={1}
    fill="none"
    stroke={accent}
    strokeWidth={width}
    strokeLinecap="round"
    strokeDasharray={1}
    strokeDashoffset={1 - draw}
  />
);

export const MotionCurveAccents: React.FC<MotionCurveAccentsProps> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const draw = (from: number, to: number) =>
    interpolate(frame, [from, to], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const fade = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <svg width="1080" height="1920" viewBox="0 0 1080 1920">
        {/* top-right swoosh */}
        <Curve d="M 640 120 C 860 90, 1010 180, 1000 380" accent={accent} draw={draw(2, 26)} width={14} />
        {/* bottom-left counter-swoosh, slightly delayed */}
        <Curve d="M 440 1800 C 220 1830, 70 1740, 80 1540" accent={accent} draw={draw(10, 34)} width={14} />
        {/* thin echo line beside the first */}
        <Curve d="M 620 170 C 820 145, 950 220, 945 380" accent={accent} draw={draw(8, 32)} width={5} />
      </svg>
    </AbsoluteFill>
  );
};
