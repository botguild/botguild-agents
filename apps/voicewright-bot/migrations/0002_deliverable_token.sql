-- Capability-URL token for deliverables (§10/§12: "deliverable R2 keys are
-- unguessable and served only through the Worker route").
--
-- The job_key is sha256(contractId) — a public, recomputable hash (contract ids
-- appear in webhooks and thread messages), so using it as the R2 object-key /
-- URL path segment made the buyer's paid CSV + JSON report fetchable by anyone
-- who knows the contract id. deliverable_token is a per-job high-entropy random
-- secret used as the R2 prefix and the /deliverables path segment; job_key stays
-- the internal FR-13 idempotency claim key only.
ALTER TABLE jobs ADD COLUMN deliverable_token TEXT;
