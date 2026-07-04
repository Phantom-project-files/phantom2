-- 008_trending_audio.sql — trending-audio delivery (Standard tier).
--
-- Reels are cut to a trending track and PREVIEWED with it in the gallery, but the
-- downloadable master ships SILENT + an upload-instruction file (the customer
-- attaches the sound natively in the app — trending/commercial audio can't be
-- legally baked into distributed business content). source_url is the "where to
-- find this sound" link (Instagram audio permalink, or an open-source track page)
-- surfaced in the instruction file.
ALTER TABLE audio_tracks ADD COLUMN source_url TEXT;
