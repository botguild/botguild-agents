# JiffyApp Template Catalog — Product Requirements Document

> The ten bounded templates JiffyApp is allowed to build — each with declared codegen slots, a stable `data-testid` element contract, deterministic golden-example affordances, and vendored pinned dependencies. Codegen fills slots; it never invents architecture.

| Field | Value |
| --- | --- |
| Parent PRD | `docs/prds/jiffyapp.md` (bot `bot-jiffyapp`) |
| Doc role | The Phase 0 **"template catalog v1" decision record** required by the parent build plan (jiffyapp.md §14) |
| Handler/Owner | TBD — inherits the parent PRD's Phase 0 assignment |
| Status | **v1.0 — Proposed, 2026-07-07** |
| Catalog size | 10 templates: **Tier A** (1–5, launch) + **Tier B** (6–10, fast-follow) |

**Relationship to the parent PRD.** The parent defines the pipeline, gates, pricing, and platform integration; this document enumerates *what may be built*. A brief that doesn't confidently match a template here is skipped at proposal time (parent FR-1) — the catalog is the scope boundary, and growing it is a deliberate act (§4), never silent scope creep. Tier A must be green before listing (parent Phase 2 exit); Tier B templates list individually as each passes the identical CI exit (target ≤ day 16) and never block the launch showcase.

## 1. Shared template contract (invariants — every template, both tiers)

1. **File set:** a small set of static files (HTML/CSS/JS) or a single tiny Worker script; **no build step at job time** — no npm install, no bundler. Anything violating this belongs in §4 future work (parent §16 Sandbox trigger).
2. **Slots:** each template declares its codegen-writable slots — copy, config JSON, logic functions, style tokens. Codegen writes **only** inside slots; template structure, dependencies, and element contract are immutable at job time.
3. **Element contract:** a stable `data-testid` set (per-template below). The golden-example compiler (parent FR-3) may only bind assertions to contract testids, so assertions are deterministic across regenerations.
4. **Golden assertion vocabulary** (the only actions/expectations the compiler may emit — all exact and machine-decidable):
   - Actions: `load`, `fill {testid→value}`, `select`, `click {testid}`, `paste {testid, text}`, `upload {testid, fixture}`.
   - Expectations: `equals`, `contains`, `count`, `visible`, `hidden`, `hrefEquals`, `hrefStartsWith`, `attrEquals {attr}`, `titleEquals`, `metaEquals {property}` (head/OG tags); optional `nth` on any expectation.
   - No "looks right", no regex, no screenshots-as-oracle — screenshots are evidence, never the check. Per-assertion timeout budgets are frozen at parent Phase 2 calibration.
5. **Dependencies:** vendored, version-pinned, license-audited at bot build time; nothing fetched at runtime; strict CSP (`self` + vendored assets only), no cookies, no storage, no third-party origins.
6. **Statelessness:** tools hold no data and no secrets. The only permitted side effect is the parent's signed relay (`POST /relay/:toolId`, FR-12); relay-bearing templates never promote before the recipient's double-opt-in verification.
7. **Quality floor:** every template's CI reference build must pass its own golden suite **and** score PSI performance ≥ 95 / accessibility ≥ 95 (margin above the ≥ 90 contractual gate) on a live reference deploy, on every bot deploy.
8. **Footer:** every served page carries the "Built by JiffyApp" attribution + report-abuse link (parent FR-17).
9. **Matcher duty:** each template ships matcher keywords + a disambiguation rule (§3); the proposal always names the matched template so a mismatch surfaces before funding.

## 2. Tier A — launch templates

### T1. Landing page — `landing` · $15 anchor

One-page marketing site: hero, features, CTA, OG tags. **Load-bearing:** this is the template Foreman's $99 Launch Kit subcontracts, so its gates must keep Foreman's parent check (URL 200 + Lighthouse a11y ≥ 90) green — its CI accessibility margin is the least negotiable number in the catalog.

- **Slots:** headline/sub/CTA copy, feature list (title + body + optional icon from the vendored icon set), brand tokens (accent hex, font stack from the bundled set), CTA target URL, OG title/description/image URL.
- **Element contract:** `hero-headline`, `hero-sub`, `cta` (href), `feature` (count) + `feature-title`/`feature-body` (nth), `footer`.
- **Golden affordances:** `load` → text equals on hero/features, `hrefEquals` on CTA, `count` on features, `titleEquals`, `metaEquals` on `og:title`/`og:description`/`og:image`.
- **Deps:** none (vanilla). **Matcher keywords:** landing page, launch page, homepage, one-pager, marketing site.

### T2. Calculator — `calculator` · $25 anchor

Pricing/quote/estimator tools with buyer-supplied rate logic, pure client-side JS (the parent §8 example brief is a consulting-rate estimator). Deterministic numeric output is the ideal golden material.

- **Slots:** input field definitions (name, type, options), rate/config JSON, the compute function (pure `(inputs) → {total, breakdown}` — no DOM, no network), result formatting (currency/locale), copy.
- **Element contract:** `input-<name>` (per declared field), `calc-submit`, `result`, `breakdown-<key>` (optional), `reset`.
- **Golden affordances:** `fill` + `click(calc-submit)` → `equals` on `result`/`breakdown-*` (e.g. `{hours: "10", seniority: "senior", rush: true} → result "$1,800.00"`).
- **Deps:** none. **Matcher keywords:** calculator, estimator, quote, pricing tool, converter (numeric).

### T3. Form-to-email — `form` · $15 anchor

Contact/intake form that POSTs to the bot's signed relay and lands in the buyer's double-opt-in verified inbox; **never goes live before verification** (parent FR-12), rate-capped, nothing stored beyond delivery metadata.

- **Slots:** field definitions (name, type, required, validation message), form copy, success/error copy, subject-line template.
- **Element contract:** `field-<name>`, `submit`, `success-msg`, `error-msg`.
- **Golden affordances:** `fill` + `click(submit)` → `visible(success-msg)`; required-field goldens assert `visible(error-msg)` on empty submit. The **live relay proof** (verified-recipient test delivery with message-id) is a parent §9 hard gate, not a Playwright assertion.
- **Deps:** none. **Matcher keywords:** contact form, intake form, inquiry, get in touch, lead form.

### T4. CSV dashboard — `csv-dashboard` · $25 anchor

Paste/upload a CSV, get a table + charts, all client-side (Papa Parse + Chart.js, vendored and pinned). No data leaves the page.

- **Slots:** expected column schema, aggregate definitions (sum/avg/count/group-by), chart configs (type, axis columns), copy.
- **Element contract:** `csv-input` (paste) / `csv-upload` (file), `render-submit`, `table`, `row` (count), `chart-<n>` (visible), `summary-<stat>`, `error-msg` (schema mismatch).
- **Golden affordances:** `paste`/`upload` a golden fixture CSV + `click(render-submit)` → `count(row)`, `equals(summary-*)` (deterministic aggregates), `visible(chart-*)`; malformed-fixture golden asserts `visible(error-msg)`.
- **Deps:** Papa Parse, Chart.js (pinned). **Matcher keywords:** CSV, dashboard, spreadsheet, data table, chart, report viewer.

### T5. Embeddable widget — `widget` · $5 anchor

Small embed-snippet tools — FAQ accordion, countdown, testimonial rotator — served as a standalone page plus an iframe embed snippet the buyer pastes into their existing site (script-injection embeds are §4 future work).

- **Slots:** widget variant (`faq` | `countdown` | `testimonials`), items JSON (Q/A pairs, target ISO datetime, quotes), brand tokens, embed dimensions.
- **Element contract:** `widget-root`, `embed-snippet`; per variant: `faq-item` (count) / `faq-question` / `faq-answer` (visibility toggles on click); `countdown` (`attrEquals data-target`); `testimonial-item` (count).
- **Golden affordances:** `count` on items, `click(faq-question, nth)` → `visible(faq-answer, nth)`, `attrEquals` on the countdown target (wall-clock text is never asserted — non-deterministic), `contains(embed-snippet)` with the final slug URL.
- **Deps:** none. **Matcher keywords:** widget, embed, FAQ, accordion, countdown, testimonials.

## 3. Tier B — fast-follow templates

### T6. Link-in-bio page — `link-in-bio` · $10 anchor

Linktree-style profile page: avatar, name, bio, ordered link list, social icons. The highest-volume consumer ask that is pure static content.

- **Slots:** profile copy, avatar image URL (fetched and re-hosted on R2 at build time under the parent's §12 fetch guards — no runtime hotlinking), link list (label + URL), social handles (vendored icon set), brand tokens.
- **Element contract:** `avatar`, `display-name`, `bio`, `link` (count; `hrefEquals` per nth), `social-<network>` (href).
- **Golden affordances:** `load` → `equals(display-name/bio)`, `count(link)`, `hrefEquals(link, nth)`, `hrefStartsWith(social-*)`, OG `metaEquals`.
- **Deps:** none. **Matcher keywords:** link in bio, links page, linktree, profile page, socials page.

### T7. Pricing table — `pricing-table` · $15 anchor

Plan-comparison page: tiered cards, feature matrix, per-plan CTAs. *Displays* fixed plans (vs T2, which *computes* — see the disambiguation table).

- **Slots:** plan definitions (name, price string, period, highlight flag), feature matrix (feature × plan → `✓`/`—`/text), CTA targets, copy, brand tokens.
- **Element contract:** `plan` (count), `plan-name`, `plan-price`, `plan-cta` (href, nth), `feature-<key>-<plan>` (cell), `highlight` (attr on the featured plan).
- **Golden affordances:** `count(plan)`, `equals(plan-price, nth)`, `equals(feature-*-*)` cell states, `hrefEquals(plan-cta, nth)`, `attrEquals(highlight)`.
- **Deps:** none. **Matcher keywords:** pricing page, plans, tiers, compare plans, price list, menu (fixed-price list).

### T8. Scored quiz — `quiz` · $25 anchor

Lead-magnet quiz/assessment: fixed questions, client-side deterministic scoring table, an outcome page ("You're **The Planner**"), and an *optional* relay of the result to the buyer via the parent's verified relay. Branch-scored outcomes (vs T2's numeric formula).

- **Slots:** question list (text + options), scoring table (option → points/outcome mapping — a pure lookup, no free logic), outcome definitions (title + body per bracket), copy, optional relay-on-completion flag.
- **Element contract:** `question` (count), `option` (nth per question), `quiz-next`, `quiz-submit`, `result`, `result-detail`, `retake`; when relay is on: `send-result`, `success-msg`.
- **Golden affordances:** scripted `click(option, nth)` sequences + `click(quiz-submit)` → `equals(result)` for each outcome bracket (one golden per outcome is the compiler's default); relay-on template inherits T3's verification + relay-proof gates.
- **Deps:** none. **Matcher keywords:** quiz, assessment, personality test, scorecard, "which X are you", lead magnet.

### T9. Waitlist / coming-soon page — `waitlist` · $10 anchor

Pre-launch page: headline, countdown to a launch datetime, email-capture into the buyer's verified inbox via the relay. The founder staple; productizes the landing + relay affordances into one SKU.

- **Slots:** headline/sub copy, launch ISO datetime, email-capture copy, success copy, brand tokens, OG tags.
- **Element contract:** `headline`, `countdown` (`attrEquals data-target`), `email-input`, `join-submit`, `success-msg`, `error-msg`.
- **Golden affordances:** `equals(headline)`, `attrEquals(countdown, data-target)` (never the ticking text), `fill(email-input)` + `click(join-submit)` → `visible(success-msg)`, invalid-email golden → `visible(error-msg)`, OG `metaEquals`. Inherits T3's verification + relay-proof gates (it is a relay template).
- **Deps:** none. **Matcher keywords:** waitlist, coming soon, pre-launch, early access, notify me, launch countdown.

### T10. Text/data transformer — `transformer` · $15 anchor

Paste-in/paste-out utility: JSON pretty-printer, CSV→JSON, slugifier, word-counter, case/format converter — one specific transform per delivered tool. The dev-audience demo-catnip: `paste → click → exact output` is the purest golden assertion in the catalog.

- **Slots:** transform function (pure `(input: string) → string` — no DOM, no network, no globals; CSP enforces the no-network half, the slot pattern the rest), input/output labels, example placeholder, copy.
- **Element contract:** `input`, `transform-submit`, `output`, `copy-btn`, `error-msg` (invalid input).
- **Golden affordances:** `paste(input)` + `click(transform-submit)` → `equals(output)` with exact expected strings; invalid-input golden → `visible(error-msg)`. A runaway transform (infinite loop) fails its assertion timeout and can never ship.
- **Deps:** none (fixture transforms are hand-rolled; Papa Parse may be borrowed for CSV-involving transforms). **Matcher keywords:** formatter, converter, JSON, slugify, word count, cleaner, "paste and convert".

**Disambiguation rules (matcher precedence, encoded in FR-1's template matcher):**

| Brief wants… | Template |
| --- | --- |
| Compute a number/quote from user inputs | `calculator` |
| Display fixed plans/prices side by side | `pricing-table` |
| Transform pasted text/data into other text/data | `transformer` |
| Branch-scored outcome from multiple-choice answers | `quiz` |
| Full marketing page for a product | `landing` |
| Announce + collect emails pre-launch | `waitlist` |
| A list of my links/profiles | `link-in-bio` |
| Collect structured inquiries to my inbox | `form` |
| Something to embed inside an existing site | `widget` |
| Visualize a CSV/spreadsheet | `csv-dashboard` |

Briefs matching nothing above with confidence are skipped (parent FR-1); the skip reason is logged and feeds the off-catalog skip-rate KPI (parent §15).

## 4. Catalog governance

- **Versioning:** templates are semver'd; every delivered tool pins `template@version` in D1 and its eject README. Hosting edits (parent FR-14) run against the pinned version; version bumps require the CI exit (§5) and never retro-change delivered tools. Deprecation = no new bids on that template; hosted tools keep serving their pinned version.
- **Addition criteria (all required):** no build step at job time; stateless (relay is the only side effect); goldens expressible in the §1 assertion vocabulary; reference build clears PSI ≥ 95/95; CSP-clean with vendored deps only; a disambiguation row that doesn't blur an existing template. The off-catalog skip-rate KPI is the demand signal for what to add next.
- **Named future candidates** (parent §16 alignment): QR-code generator (with an in-page decode round-trip gate), event/RSVP page (relay-based), survey with **stored** responses (needs D1 + PII/retention work — out until the parent's data-tools expansion), booking widget (external calendar integration), script-injection embeds, multi-page sites (FrontCraft's lane).
- **Removal/kill:** a template whose live gates flake (PSI variance, assertion nondeterminism) is pulled from bidding until its CI margin is restored; delivered tools are unaffected.

## 5. CI & calibration requirements (feeds parent Phase 2)

- Per template: ≥1 committed **reference brief** + golden fixture set (including the failure-path goldens: invalid email, malformed CSV, empty required field); CI deploys the reference build to a staging slug, runs the full golden suite on Browser Rendering, and fetches PSI — all on every bot deploy.
- Tier A green (all five) is the parent Phase 2 exit and blocks listing; each Tier B template lists individually when its identical CI exit passes (target ≤ day 16), and is announced in the gig catalog as it lands.
- Phase 2 calibration freezes, per template: assertion timeout budgets, PSI margins observed on live deploys, and matcher-confidence thresholds — after which gig terms reference this document by version.

## 6. Catalog-specific risks

| Risk | Mitigation |
| --- | --- |
| Ten templates double the maintenance surface of five. | Tiering (launch never waits on Tier B); shared contract keeps per-template code small; CI reference builds catch rot on every deploy; the kill rule (§4) pulls flaky templates from bidding. |
| Matcher confusion across overlapping templates (landing vs waitlist vs link-in-bio; calculator vs pricing-table vs transformer vs quiz). | The §3 disambiguation table is encoded in the matcher; low-confidence matches are skipped, not guessed; the proposal names the matched template so mismatch surfaces before funding (parent §13). |
| Quiz outcomes drift nondeterministic if scoring were free-form logic. | Scoring is a pure lookup table slot, never generated control flow; the compiler emits one golden per outcome bracket by default. |
| Transformer's logic slot is the closest thing to open-ended codegen in the catalog. | Pure-function slot pattern (no DOM/network/globals), CSP, assertion timeouts, and exact-output goldens bound it; briefs needing more than one transform are off-catalog. |
| Relay templates (T3, T8-with-relay, T9) triple the relay's exposure. | One shared relay implementation with per-tool tokens/caps/verification (parent FR-12/§12) — templates add configuration, never new relay code paths. |
| Avatar/OG image re-hosting (T6, T1) pulls remote bytes at build time. | Parent §12 fetch guards (HTTPS-only, size/type caps) + moderation of imagery via the pinned vendor before promote. |
