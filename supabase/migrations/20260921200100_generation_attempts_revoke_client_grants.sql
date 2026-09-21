-- 2026-09-21 delta security review of 200000.
--
-- generation_attempts is deny-all to clients only because RLS is on with no policies. anon and
-- authenticated still held Supabase's default table grants (SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER), so one permissive policy added later, or RLS switched off,
-- would reopen direct reads AND writes to outcome/outcome_detail: the very row the app trusts.
-- Nobody needs them. The generator writes with service_role, and the app reads only through
-- get_generation_outcome() (SECURITY DEFINER, runs as its owner). Same pattern as
-- generation_voice_provenance_revoke_client_grants.
revoke all on table public.generation_attempts from anon, authenticated;

-- Recorded assumption (HQ item 3: "a caller gets the outcome of a request id they hold"): the
-- capability IS holding the client_request_id. It is minted in the requester's browser
-- (crypto.randomUUID), is stored only in generation_attempts.client_request_id, and no client-
-- readable table, RPC or storage exposes it (checked 2026-09-21). The function additionally
-- fences by studio. If an id ever becomes visible to other members, stamp the requester's
-- verified identity on the row and compare it in the function.
