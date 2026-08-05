-- FR-18: one warranty revision per contract — the buyer changes which of the
-- three already-generated concepts the brand pack is built from.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH: `concepts`.
--
-- Task 23's ruling is the reason this file exists in the shape it does. A
-- revision keyed so that it OVERWRITES the `concepts` rows collides on
-- PK (contract_id, slot) — which is precisely what `assembleDisputeEvidence`
-- reads — so the evidence of what was delivered would be destroyed by the
-- delivery being revised, at the one moment it matters most. The scheme built
-- here walks around that rather than migrating over it: the revision REBUILDS
-- THE PACK FROM A CONCEPT THAT ALREADY EXISTS, so `concepts` is read-only on
-- the whole revision path and needs no discriminator at all. If a future
-- revision ever REGENERATES concepts, this file is the wrong place to start —
-- re-read Task 23 first, because that change does need the PK to move.
--
-- WHY `revision` DEFAULTS TO 0 EVERYWHERE. Every row that exists today, and
-- every code path that exists today, means revision 0. `buildJobKey(contractId,
-- stage)` still returns the byte-identical `sha256(contractId):stage` it always
-- did, every current read filters to `revision = 0` and gets the same rows back,
-- and a pre-migration row satisfies the new primary key by construction. The
-- migration is a no-op for existing data — the same self-healing property
-- 0002's `parked_since` had, and for the same reason: a schema change that
-- needs a backfill to be correct is a schema change that can be half-applied.

-- --- jobs --------------------------------------------------------------------
-- A plain ADD COLUMN: the primary key does not move (`job_key` is already
-- revision-distinct, because a revision job's key is derived from a different
-- string — see `buildJobKey`). SQLite permits NOT NULL on an added column when
-- a non-null DEFAULT is supplied, so existing rows take 0 without a backfill.
--
-- The column is not redundant with the key. `job_key` is a HASH: nothing can
-- read a revision number back out of it, and `runVectorStage` has to know which
-- revision it is building in order to look up the right `selection` row. A fact
-- the code must branch on cannot live only inside a digest.
ALTER TABLE jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

-- --- selection ---------------------------------------------------------------
-- WHY A TABLE REBUILD. SQLite cannot ALTER a PRIMARY KEY, so this follows the
-- same twelve-step procedure 0004 used: build the replacement, copy the rows,
-- drop the original, rename. Every column and both CHECK constraints are
-- reproduced BYTE-FOR-BYTE from 0004; the differences are the `revision`
-- column, the composite primary key, and `pack_delivered_at`.
--
-- WHY THE PRIMARY KEY IS (contract_id, revision) AND NOT THE OTHER ORDER:
-- `contract_id` stays the leading column, so every existing lookup
-- (`WHERE contract_id = ?`) keeps using the index exactly as it does today.
--
-- WHY A SECOND ROW RATHER THAN AN UPDATE IN PLACE. `winner_slot`, `source` and
-- `selected_at` are the record of a decision the buyer made, and
-- `assembleDisputeEvidence` publishes all three. Re-pointing them at the new
-- winner would destroy the answer to "which concept did you deliver, and who
-- chose it" — the same evidence-loss failure the `concepts` collision would
-- have caused, one table over. Both rows survive; the dispute document reports
-- every revision.
--
-- WHY `pack_delivered_at` IS ITS OWN COLUMN. The revision trigger reads the
-- contract thread for messages posted AFTER the pack was delivered, and
-- `updated_at` cannot answer that: `select()` touches it too, so on a revision
-- row it measures the last write of any kind. This is the identical mistake
-- 0002 records me making with `parked_since` — reaching for `updated_at`
-- because it looked right — so the column is exact and written at exactly one
-- site (`markPackDelivered`).
--
-- The BACKFILL below is exact rather than a guess, and only because of the
-- state machine: `pack_delivered` is TERMINAL, and `markPackDelivered` is the
-- only statement that can produce it, so for a row already in that state
-- `updated_at` IS the instant the pack was delivered. Rows in any other state
-- get NULL, because for them no pack has been delivered and inventing a
-- timestamp would be asserting a delivery that did not happen.
CREATE TABLE selection_new (
  contract_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
    CHECK (state IN ('concepts_delivered', 'winner_selected', 'pack_delivered')),
  winner_slot INTEGER,
  source TEXT CHECK (source IN ('buyer', 'inferred', 'default')),
  m1_delivered_at TEXT NOT NULL,
  selected_at TEXT,
  pack_delivered_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (contract_id, revision)
);

INSERT INTO selection_new
  (contract_id, revision, state, winner_slot, source, m1_delivered_at, selected_at,
   pack_delivered_at, updated_at)
  SELECT contract_id, 0, state, winner_slot, source, m1_delivered_at, selected_at,
         CASE WHEN state = 'pack_delivered' THEN updated_at ELSE NULL END, updated_at
  FROM selection;

DROP TABLE selection;

ALTER TABLE selection_new RENAME TO selection;
