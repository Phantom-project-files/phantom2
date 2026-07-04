// PostStill — 4:5 1080x1350 brand still (posts). Token-driven sibling of the
// chrome-composited post (lib/edit/post-compose.js hero archetype): dark ground,
// bottom-anchored headline, accent rule, letterspaced wordmark. A base image can
// arrive later as an inputProp; for now it's the pure-graphic variant.

import React from 'react';
import { AbsoluteFill } from 'remotion';

export type PostStillProps = { logoText: string; headline: string; accent: string; bg: string };

const FONT = "-apple-system, 'Helvetica Neue', Arial, sans-serif";

export const PostStill: React.FC<PostStillProps> = ({ logoText, headline, accent, bg }) => (
  <AbsoluteFill style={{ background: bg, fontFamily: FONT, color: '#fff' }}>
    <AbsoluteFill
      style={{ background: `radial-gradient(120% 90% at 80% 0%, ${accent}33 0%, transparent 60%)` }}
    />
    <div
      style={{
        position: 'absolute',
        left: 64,
        right: 64,
        bottom: 64,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}
    >
      <h1 style={{ fontSize: 64, lineHeight: 1.08, fontWeight: 800, letterSpacing: '-.01em', margin: 0 }}>
        {String(headline).slice(0, 140)}
      </h1>
      <div style={{ width: 72, height: 3, background: accent }} />
      <span
        style={{
          fontSize: 22,
          letterSpacing: '.32em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,.55)',
          fontWeight: 500,
        }}
      >
        {logoText}
      </span>
    </div>
  </AbsoluteFill>
);
