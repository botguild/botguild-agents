-- A third selection source: `inferred`.
--
-- WHY A MIGRATION AT ALL. `selection.source` carries a CHECK constraint that
-- ENUMERATES the permitted values, so widening the TypeScript union alone does
-- not widen the column: an UPDATE writing 'inferred' fails the constraint and
-- throws. Loudly, which is the right direction — but a funded contract whose
-- winner cannot be written is a stalled contract, so the schema has to move
-- with the type.
--
-- WHY THE VALUE IS ITS OWN, RATHER THAN REUSING 'buyer'. The strict parser
-- (threads.ts `parseSelection`) reads a reply literally; the Haiku fallback
-- (inferSelection.ts) reads a pick out of a reply it could not parse, grounded
-- in a verbatim span of the buyer's own words. Those are different claims. When
-- a payer disputes "I never chose that", `assembleDisputeEvidence` has to be
-- able to say which one happened and quote what they actually wrote — and a
-- third case that silently reads as 'buyer' would make the evidence document
-- assert something stronger than the record supports, which is this project's
-- own highest-severity class of defect.
--
-- WHY A TABLE REBUILD. SQLite cannot ALTER a CHECK constraint; the twelve-step
-- procedure in the SQLite docs is to build the replacement, copy the rows,
-- drop the original and rename. The table is one row per contract and has no
-- foreign keys pointing at it, so the copy is exact and the rename is safe.
-- Every other column, the primary key and the `state` CHECK are reproduced
-- BYTE-FOR-BYTE from 0001_init.sql; the only difference is the third value in
-- the `source` CHECK. Existing rows all hold 'buyer', 'default' or NULL and
-- satisfy the wider constraint by construction, so the copy cannot fail.
CREATE TABLE selection_new (
  contract_id TEXT PRIMARY KEY,
  state TEXT NOT NULL
    CHECK (state IN ('concepts_delivered', 'winner_selected', 'pack_delivered')),
  winner_slot INTEGER,
  source TEXT CHECK (source IN ('buyer', 'inferred', 'default')),
  m1_delivered_at TEXT NOT NULL,
  selected_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO selection_new
  (contract_id, state, winner_slot, source, m1_delivered_at, selected_at, updated_at)
  SELECT contract_id, state, winner_slot, source, m1_delivered_at, selected_at, updated_at
  FROM selection;

DROP TABLE selection;

ALTER TABLE selection_new RENAME TO selection;
