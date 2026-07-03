-- 005_media.sql — Phase 4: media metadata.
-- media_assets.meta carries structured context per artifact:
--   shots:     { campaign_id, slot, source_piece_id, stage }
--   keyframes: { piece_id, slot, stage: "keyframe" }
--   phantom:   { phantom_id }
-- The shot LIBRARY is media_assets kind='shot' grouped by campaign — Phase 5's
-- beat-cut editor pulls sibling shots from here (cross-reel reuse).

ALTER TABLE media_assets ADD COLUMN meta TEXT;
