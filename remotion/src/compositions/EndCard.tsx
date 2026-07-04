// EndCard — brand logo card, springs in over the reel's final beat.
// Same card design as the chrome_overlay fallback (graphics.js endcardHtml),
// so a Remotion outage doesn't change the brand look — only removes the motion.

import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export type EndCardProps = { logoText: string; accent: string };

const FONT = "-apple-system, 'Helvetica Neue', Arial, sans-serif";

export const EndCard: React.FC<EndCardProps> = ({ logoText, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.8 } });
  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  const rule = interpolate(frame, [6, 22], [0, 88], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div
        style={{
          background: 'rgba(6,7,12,.55)',
          borderRadius: 26,
          padding: '44px 72px',
          textAlign: 'center',
          border: '1px solid rgba(255,255,255,.14)',
          opacity: fadeIn,
          transform: `scale(${0.9 + 0.1 * pop})`,
        }}
      >
        <h1 style={{ color: '#fff', fontSize: 74, fontWeight: 800, letterSpacing: '.14em', margin: 0 }}>
          {logoText}
        </h1>
        <div style={{ width: rule, height: 4, background: accent, margin: '20px auto 0', borderRadius: 2 }} />
      </div>
    </AbsoluteFill>
  );
};
