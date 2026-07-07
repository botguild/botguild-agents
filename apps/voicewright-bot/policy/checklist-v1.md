# VoiceWright Ad-Policy Checklist — v1

Human-readable companion to `src/policy/checklist-v1.ts` (the executable
version). The two files are versioned together: a rule change means a new
version (`checklist-v2.*`) and a gig-terms bump — delivered verdicts always
name the version that judged them.

**Scope.** This checklist is the local half of the §9 policy gate, alongside
the pinned moderation vendor (OpenAI Moderation, model
`omni-moderation-2024-09-26`). It encodes reproducible, deterministic checks
for the ad-review failure modes a text-only rule can catch. It does **not**
promise Meta ad approval — no automated check can — and disputes over Meta
rejections are carried by the 21-day warranty, not by this document.

## Rules

| Rule id | Requirement |
| --- | --- |
| `no-personal-attribute-callouts` | Copy must not assert or imply the reader's personal attributes — health conditions, financial status, identity ("Are you diabetic?", "struggling with debt?"). Meta rejects personal-attribute call-outs outright. |
| `no-prohibited-claims` | No miracle/cure language, no guaranteed-outcome claims (results, weight loss, income, returns), no "100% risk-free" or get-rich framing. |
| `no-excessive-punctuation` | No repeated terminal punctuation (`!!`, `???`, `!?`). |
| `no-all-caps-shouting` | No fully-capitalized words of four or more letters. Short acronyms (USA, CTA, SDK) are allowed. |
| `buyer-policy-constraints` | The significant terms of every buyer-specified prohibition in the brief's `policyConstraints` (e.g. "no weight-loss or body-transformation claims") must not appear in the copy. The full constraint text is also fed to generation as a hard instruction; this rule is the deterministic backstop. |

## Evaluation

- Every variant is checked against every rule at the policy gate (FR-7); a
  failing variant is rewritten within the FR-5 caps, never delivered.
- The per-variant result (`version`, `pass`, failing rule ids) is snapshotted
  to D1 at delivery time and included in the delivered JSON report.
- Checks run on the concatenated headline + primary text + link description.

## Versioning

- Version: **v1** (initial release, drafted per PRD §14 Phase 1).
- A version bump requires: rule review against accrued Meta-policy learnings,
  a matching update to gig terms, and republication of this document.
