-- 20260903190000_bucket_size_limits.sql
-- WO-4b step 1. Give every bucket an explicit file_size_limit.
--
-- WHY THIS MATTERS MORE THAN IT LOOKS. A NULL bucket limit is not "unlimited" — it falls
-- through to the PROJECT-LEVEL global limit, which is invisible from SQL and, as of
-- 2026-09-03, is bracketed by evidence between 43.0 MB and 113.9 MB (a 113.9 MB upload was
-- rejected; the largest object ever stored anywhere is 43.0 MB; nothing above 50 MB exists in
-- any bucket). So a NULL limit means "governed by a number nobody in this repo can read".
--
-- ⚠ THE EFFECTIVE LIMIT IS min(bucket, global), AND THE GLOBAL WINS. Setting a bucket limit
-- here does NOT raise the ceiling. reel-sources already carries 300 MB and still rejected
-- 113.9 MB, which is exactly how that misleading value produced a client-side size gate
-- calibrated to the wrong number. These values take effect only once the global limit is
-- raised (WO-4b step 2, Mac, Dashboard). Until then they are declarations of intent.
--
-- Written as direct SQL, which bypasses the Storage API's validation that a bucket limit may
-- not exceed the global. That is how reel-sources came to hold 300 MB against a ~50 MB global
-- in the first place. Recorded so the next person does not read these numbers as effective.

-- reel-audio: 0 objects today. Kevin MacLeod CC-BY tracks. An MP3/M4A track runs a few MB;
-- 25 MB is generous for the class and bounds abuse on a bucket nothing currently guards.
update storage.buckets
   set file_size_limit = 26214400            -- 25 MB
 where id = 'reel-audio' and file_size_limit is null;

-- reel-renders: 17 objects, all video/mp4, largest 43.7 MB (45,793,481 B).
-- 300 MB, matching reel-sources: same media class, and a render is derived from those sources.
--
-- ⚠ THIS ONE IS NOT HOUSEKEEPING. At 43.7 MB the largest existing render sits within ~13% of
-- the current effective ceiling. A slightly longer reel would fail on write, and the render
-- pipeline has no size telemetry — it would fail the way the 08-17 uploads failed, silently.
-- The explicit limit does not fix that until the global is raised; it makes the intent legible.
update storage.buckets
   set file_size_limit = 314572800           -- 300 MB
 where id = 'reel-renders' and file_size_limit is null;

-- NOT CHANGED, and deliberately so:
--   client-photos  50 MB, mime allowlist set   — already explicit
--   studio-photos  50 MB, mime allowlist set   — already explicit, largest object 18.8 MB
--   reel-sources  300 MB, mime NULL            — already explicit
-- allowed_mime_types is NULL on reel-audio, reel-renders and reel-sources. Out of scope for
-- this WO, which asked for limits only. Reported rather than silently widened: a bucket that
-- accepts any MIME type is a separate decision from one that accepts any size.
