// Root.tsx — every Phantom composition, registered for studio + programmatic render.
//
// Reel overlays are 9:16 1080x1920 @30fps with TRANSPARENT backgrounds — the
// backend renders them as ProRes 4444 alpha .mov and ffmpeg-composites them onto
// the assembled reel (mp4 can't carry alpha). PostStill is the 4:5 1080x1350 post.
//
// ALL brand content arrives via inputProps (logoText / headline / accent) —
// defaultProps below are neutral placeholders for the studio, never shipped.
// NOTE: captions were removed from this product on purpose (operator decision) —
// do not add a caption/subtitle composition here.

import React from 'react';
import { Composition, Still } from 'remotion';
import { EndCard } from './compositions/EndCard';
import { InfographicOverlay } from './compositions/InfographicOverlay';
import { MotionCurveAccents } from './compositions/MotionCurveAccents';
import { ChalkEffect } from './compositions/ChalkEffect';
import { PostStill } from './compositions/PostStill';

const FPS = 30;
const REEL = { width: 1080, height: 1920 };
const ACCENT = '#9d86ff'; // placeholder — real accent comes from inputProps

export const Root: React.FC = () => (
  <>
    {/* brand logo end-card: overlays the reel's last 1.4s (42f) — mirrors the
        chrome_overlay fallback's card so both backends read as one design */}
    <Composition
      id="EndCard"
      component={EndCard}
      durationInFrames={42}
      fps={FPS}
      {...REEL}
      defaultProps={{ logoText: 'BRAND', accent: ACCENT }}
    />
    {/* animated stat/infographic card (graphics_notes: stat/number/infographic) */}
    <Composition
      id="InfographicOverlay"
      component={InfographicOverlay}
      durationInFrames={72}
      fps={FPS}
      {...REEL}
      defaultProps={{ headline: '87% sold out in 9 minutes', accent: ACCENT }}
    />
    {/* swooshing corner curves (graphics_notes: curve/swoosh/motion accents) */}
    <Composition
      id="MotionCurveAccents"
      component={MotionCurveAccents}
      durationInFrames={72}
      fps={FPS}
      {...REEL}
      defaultProps={{ accent: ACCENT }}
    />
    {/* hand-drawn chalk underline + circle (graphics_notes: chalk/scribble) */}
    <Composition
      id="ChalkEffect"
      component={ChalkEffect}
      durationInFrames={72}
      fps={FPS}
      {...REEL}
      defaultProps={{ accent: '#ffffff' }}
    />
    {/* 4:5 post still — brand-token driven, rendered via renderStill */}
    <Still
      id="PostStill"
      component={PostStill}
      width={1080}
      height={1350}
      defaultProps={{ logoText: 'BRAND', headline: 'Headline goes here', accent: ACCENT, bg: '#0a0b10' }}
    />
  </>
);
