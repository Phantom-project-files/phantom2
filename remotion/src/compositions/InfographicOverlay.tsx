// InfographicOverlay — animated stat card (graphics_notes: "animated stat overlay").
// Slides up from the lower third; the first integer in the headline counts up and
// an accent progress bar fills — the classic "big number" reel beat.

import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export type InfographicOverlayProps = { headline: string; accent: string };

const FONT = "-apple-system, 'Helvetica Neue', Arial, sans-serif";

export const InfographicOverlay: React.FC<InfographicOverlayProps> = ({ headline, accent }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 16 } });
  const exit = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // count-up: animate the first integer in the headline, keep the rest verbatim
  const m = String(headline).match(/\d+/);
  const progress = interpolate(frame, [4, 34], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const shown = m
    ? headline.replace(m[0], String(Math.round(parseInt(m[0], 10) * progress)))
    : headline;
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <div
        style={{
          position: 'absolute',
          left: 64,
          right: 64,
          bottom: 420,
          background: 'rgba(6,7,12,.72)',
          border: '1px solid rgba(255,255,255,.14)',
          borderRadius: 26,
          padding: '40px 48px',
          opacity: Math.min(enter, exit),
          transform: `translateY(${(1 - enter) * 120}px)`,
        }}
      >
        <h1 style={{ color: '#fff', fontSize: 66, lineHeight: 1.1, fontWeight: 800, margin: 0 }}>{shown}</h1>
        <div style={{ marginTop: 26, height: 8, borderRadius: 4, background: 'rgba(255,255,255,.16)' }}>
          <div style={{ width: `${progress * 100}%`, height: '100%', borderRadius: 4, background: accent }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};
