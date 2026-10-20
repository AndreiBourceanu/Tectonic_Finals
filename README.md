# Trust Lens

Trust Lens is the bridge between the customer organisation's search engine/AI and its users.

Answers with visible trust. For every question, Trust Lens finds the relevant company documents, scores each one on **freshness, ownership, applicability and agreement**, and tells you whether you can rely on the answer, should check first, or should not act yet. It surfaces conflicts between sources, flags knowledge gaps, and names who to ask.

The data lives in a real SQLite database. The demo data is fictional: a company ("Northwind"), 11 documents, 6 people and three payroll questions.

## Quick start

Works on **Node 18.18 or newer** (check with `node --version`).

- **Node 22.13+:** uses the built-in `node:sqlite`. No install needed.
- **Node 18 or 20:** run `npm install` once. It installs `better-sqlite3`, an optional dependency used as the SQLite driver. The app picks the driver automatically, and `/api/health` reports which one is active.

```bash
npm start            # UI + API at http://localhost:3000 (creates and seeds data/trustlens.db on first run)
npm test             # 72 tests (node:test, in-memory databases)
npm run demo         # scripted CLI demo: good / conflict / gap / gap closed live
npm run reseed       # delete the database file and load the demo data again
npm run llm:check    # confirms your Gemini key works (never prints the key)
```

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/trustlens.db` | database file |
| `TRUST_NOW` | value in the DB (`2026-09`) | reference date for freshness |
| `SEED_DEMO` | `true` | set to `false` to start with an empty database |
| `TRUST_SQLITE_DRIVER` | auto | force `node:sqlite` or `better-sqlite3` |
| `GEMINI_API_KEY` | unset | enables the Gemini integration (see "LLM integration") |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Gemini model name |
| `LLM_PROVIDER` | `gemini` | set to `none` to switch the LLM off even when a key is present |
| `GEMINI_API_MODE` | `auto` | `auto`, `interactions` or `generateContent` (which Gemini API route to use) |
| `GEMINI_BASE_URL` | Google's URL | override for tests or a proxy |
| `GEMINI_TIMEOUT_MS` | `30000` | how long to wait for Gemini before using the fallback |

## How everything works

### 1. The big picture

```
                                   ┌──────────────────────────────────────┐
 POST/PUT /api/documents ────────► │  SQLite  (data/trustlens.db)         │
 (staff, connectors, AI agent)     │  documents · people · versions ·     │
                                   │  questions · answer_log · settings   │
                                   └───────────────┬──────────────────────┘
                                                   │ src/repo.js (all SQL, parameterised)
                                                   ▼
 UI ◄── JSON ◄── src/server.js ◄── src/trust.js (pure scoring + verdict)
                       │
                       └─► every answer that is not green is written to answer_log
```

1. **Database:** documents, people, versions, questions and the answer log are stored in SQLite.
2. **Repository** (`src/repo.js`) is the only place with SQL. It validates input, runs transactions and returns plain objects.
3. **Scoring** (`src/trust.js`) is pure logic. It takes one question with its sources and an employee country, and returns the verdict.
4. **Server** (`src/server.js`) exposes it as a JSON API and serves the UI.
5. **UI** (`public/index.html`) calls the API and shows verdict, conflicts, who to ask, and the source text.

Because every answer is computed from the database on request, **changes are live**: add or edit a document and the next answer reflects it, with no restart and no re-indexing.

### 2. The database (`src/db.js`)

SQLite in WAL mode with foreign keys on. The two drivers (built-in `node:sqlite` and `better-sqlite3`) expose the same calls, so `src/repo.js` doesn't know which one is in use. The schema is an append-only list of migrations; the applied version is stored in `PRAGMA user_version`, so opening an old database upgrades it automatically.

| Table | Holds |
|---|---|
| `documents` | file name, title, type, `doc_date` (YYYY-MM), owner, topic, claim, answer, body, version, timestamps |
| `document_countries` | which countries each document applies to (many-to-many) |
| `document_versions` | a snapshot of the document and who edited it, for every save |
| `people` | owners and editors: name, role and email |
| `countries` | the countries in use (ISO code and name); new ones are validated against `src/countries.js` |
| `document_types` | every document type, stored once (starts with Policy, Wiki, Chat, Email, Contract, Document; new ones are added on first use) |
| `keywords` | every keyword, stored once (new ones are added on first use) |
| `document_keywords` | which keywords belong to which document, with a weight and a flag for manually entered ones |
| `questions` | the question text and the expert to contact when documents are not enough |
| `answer_log` | every answer that was not green: question, country, verdict, gap and conflict flags |
| `settings` | the demo reference date |

The database enforces the rules as well as the code: dates must look like `YYYY-MM`, a document with a topic must have a claim and an answer, topics must reference an existing question, and verdicts are limited to `rely`, `check` or `hold`.

**Document fields that drive trust:** `doc_date` (freshness), `owner` (accountability), countries (applicability), and `claim` with `answer` (what the document says, and which documents agree). `claim` is a label: documents with the same claim agree with each other. Today a person or an AI step fills `claim` and `answer`; an LLM extraction step is the natural next addition.

### 3. Scoring (`src/trust.js`)

For a given question and employee country, every source gets up to 100 points:

| Dimension | Points | Rule |
|---|---|---|
| **Fresh** | 30 / 20 / 10 / 0 | updated ≤ 6 / ≤ 18 / ≤ 36 / more than 36 months ago |
| **Owner** | 20 or 0 | a named owner exists (someone is accountable) |
| **Applies** | 30 or 0 | the source covers the employee's country |
| **Agreed** | 0 to 20 | +10 for each *other applicable* source with the same `claim` (max 20) |

Sources that do not apply to the country are still shown (greyed out) but are never used as the answer, and they earn no "Agreed" points.

| Verdict | Condition |
|---|---|
| 🟢 **You can rely on it** | top score ≥ 75 **and** no conflict |
| 🟡 **Check before you act** | top score ≥ 50, or there is a conflict |
| 🔴 **Don’t act on this yet** | top score < 50, or no source covers this country (a knowledge gap) |

A **conflict** exists when the applicable sources contain more than one distinct `claim`. The UI then shows the two competing statements side by side. The "Who can help" box appears whenever the verdict is not green.

### 4. The API (`src/server.js`)

A plain Node `http` server with no framework.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | the UI |
| GET | `/api/health` | liveness, demo date, document count |
| GET | `/api/questions` | questions, countries, score maxima |
| POST | `/api/answer` | body `{questionId, country}`. Returns verdict, answer, conflict, expert and all sources with per-dimension scores and explanations |
| GET | `/api/documents` | all documents (metadata) |
| GET | `/api/documents/:file` | one document with its full text |
| POST | `/api/documents` | create a document (returns `201`) |
| PUT | `/api/documents/:file` | update a document; provided fields are merged, the version number goes up |
| GET | `/api/documents/:file/versions` | version history, newest first, with who edited |
| POST | `/api/upload` | upload a new file or a new version of one (email required) |
| POST | `/api/ask` | the search bar. Body `{query, country, useLlm}`. Returns `answers` (one verdict per question or standalone document, each with scored sources), `found`, `llmAvailable` and `llm: {used, model, error, cached, keywords, people, question}` |
| POST | `/api/draft` | body `{query, country}`. Second model call: a short drafted answer from the strongest sources. Returns `{draft: {answer, covered, sources, model, cached} \| null, reason}`; `reason` is `disabled`, `no-source` or `error` |
| POST | `/api/diagnose` | body `{file}`. Result of the knowledge check for a document (the one the upload or edit already started in the background, or a new run): `{findings, compared, resolved, llm}` |
| GET | `/api/findings?status=&file=` | findings (`open` by default; `resolved`, `dismissed` or `all`), each with its documents, quotes and suggested contacts |
| POST | `/api/findings/:id/status` | body `{status}` (`open`, `resolved`, `dismissed`). Returns the finding |
| GET | `/api/search?q=` | plain keyword match over questions and documents (used internally and kept for API users) |
| GET | `/api/countries` | countries in use |
| POST | `/api/countries` | body `{country}` (name or ISO code); adds a real country, `201` if new, `200` if it already existed, `400` if not a country |
| GET | `/api/countries/iso` | all 249 ISO 3166-1 countries (for suggestions) |
| GET | `/api/types` | all document types |
| GET | `/api/keywords?limit=` | all keywords with how many documents use them (default 40, max 500) |
| GET | `/api/people` | people and how many documents they own |
| GET | `/api/gaps` | ranked log of unreliable answers, with gap and conflict counts |

Creating a document:

```bash
curl -s localhost:3000/api/documents -H 'Content-Type: application/json' -d '{
  "title": "Leaver bonus rule (Germany)", "type": "Policy", "date": "2026-09",
  "owner": "Jan Weber (Compliance DE)", "countries": ["DE"],
  "topic": "leaver-bonus", "claim": "A", "answer": "Pro rata by months worked",
  "body": "# Leaver bonus - Germany\nPro rata by months worked.", "editedBy": "Jan Weber"
}'
```

Errors return JSON `{error}`: `400` invalid input, `404` unknown route or document, `409` file name already used, `413` body too large, `500` unexpected error (details are logged, not returned).

**Security notes:** every query uses bound parameters (tested with hostile input), document names are checked against the database instead of the file system, and request bodies are size-limited. **There is no authentication yet: every write route (`/api/upload`, `POST` and `PUT /api/documents`) is open to anyone who can reach the server, and the email on an upload is not verified.** Run it locally or behind your own access control until accounts are added.

### 5. The gap log

Every answer that is not green is stored in `answer_log`, so it survives restarts. `/api/gaps` ranks the most-asked unreliable questions and splits them into **gaps** (no source covers the country) and **conflicts** (sources disagree). Adding the missing document closes the gap immediately, which is the feedback loop the product is built on.

### 5b. Upload, metadata and search

The home page has a **search bar** with a country selector, and an **Add or update a document** panel.

- **Upload (`POST /api/upload`):** body `{email, fileName, content, countries, title?, type?, topic?, answer?, replaces?}`. A new upload is owned by the email given (the email becomes a `people` record). With `replaces: "<file>"` the document gets a new version, the original owner is kept, and the email is stored as last editor. Updating an ownerless document claims it. Only `.md` and `.txt` for now, with a maximum of 200,000 characters (about 200 KB) of text per document; the form checks this before sending, and the API answers `400` otherwise. Identical content is rejected as a duplicate.
- **Generated metadata:** title (first `# heading` or file name), summary, weighted keywords and a suggested type. With a Gemini key these come from the model (`meta_source` = `llm`); otherwise, or if Gemini fails, from the built-in heuristic in `src/metadata.js` (`heuristic`). Hand-written summaries and keywords are marked `manual`. Each document also stores owner email, last editor, last edited date, size, content hash, original file name and `source` (`api`, `upload`, `seed`). Keywords live in the `document_keywords` table (indexed) and drive search.
- **Countries:** the "Applies to" checkboxes and the search country selector come from the `countries` table (it starts with Belgium, Netherlands and Germany). The upload form has an **Add country** box with all 249 official countries of ISO 3166-1 as suggestions. You can type the English name or the two-letter code (`France`, `fr`; a few common aliases such as `UK` work too). Anything that is not a real country is rejected (`400`), and a country is stored once. A new country can then be used on documents and in searches; a question with no document for it shows as a knowledge gap.
- **Type:** the Type field is free text with the stored types as suggestions. An unknown type is added to the `document_types` table the first time it is used (the confirmation says so). Matching ignores case and extra spaces, so "meeting NOTES" reuses "Meeting notes". Types are 1 to 40 characters (letters, digits, spaces, `& / . -`). On an update, leaving the type empty keeps the current one.
- **Keywords (optional):** the upload form has one Keywords field (comma separated). Manual keywords are added to the generated ones and ranked first. Every keyword is stored once in the global `keywords` table, so a new keyword is added the first time anyone uses it, and the form lists existing keywords as clickable suggestions. Manual keywords are kept when a document is updated without new keywords; giving new ones replaces the manual set. The upload response lists what was new to the database (`added.type`, `added.keywords`).
- **Question links:** the upload form no longer links a document to a question. Uploaded documents are searchable by their keywords but do not take part in a trust verdict yet; the API (`topic`, `answer`, `claim` on `POST /api/upload` and `/api/documents`) still supports it, and the LLM step is meant to do this automatically.
- **Search:** see 5e below.

### 5d. LLM integration (Gemini)

1. Create a key in Google AI Studio and put it in a file in the project folder: `.env` or any `*.env` file, containing either `GEMINI_API_KEY=your-key` or just the key. (`GEMENI_API_KEY` is accepted as a spelling.) Environment variables set in your shell win over files. These files are git-ignored; **never commit a key**.
2. Run `npm run llm:check` once. It first tests the network and key by listing the models your key can use (and whether `GEMINI_MODEL` is one of them), then analyses a sample document, with timings. It describes each env file (size, encoding, variable names, whether a key was detected; never the key itself) and whether Gemini answers in the expected shape. The loader also accepts `KEY: value` lines, UTF-16 files (what some Windows editors and PowerShell write) and a key pasted among other text.
3. Run `npm start`. The first lines say `LLM: Gemini (...)` or `LLM: off`.

How it works (`src/llm.js`, plain HTTPS, no SDK): on upload, the server first validates the request (bad email, wrong file type, empty or duplicate files never reach the model), then sends the document text (max 12,000 characters) with a prompt that treats it as untrusted data and offers the known document types. The answer must be JSON with `summary`, `keywords` and `type`; it is validated and cleaned (lengths, allowed characters, at most 8 keywords) before use. The model suggests a type only for **new** documents and only when the user left Type empty; a suggested new type is added to the types table. The call happens before the database transaction, never inside it, with a 30 s timeout (per attempt, one retry on timeout) and one retry after a 429 or 503. Any failure (no key, rate limit, timeout, unusable answer) falls back to the heuristic, so uploads never fail because of the LLM; the upload response and the page say which was used (`llm: {used, model, error}`). The key is sent only in a request header and is removed from any logged or returned error text.

Tests and the demo never call Gemini: the LLM client is only created when the server is started with `npm start`.

Data: with a free-tier key, Google's terms allow prompts to be used to improve its products. Use only fictional or non-confidential documents, or a billing-enabled project. The model is not used for search routing yet.

### 5e. Search (`src/ask.js`, `POST /api/ask`)

The LLM interprets the question; it never scores anything.

1. **Quick local match (`useLlm: false`).** The words of the query are matched against stored keywords. The page shows this at once.
2. **Interpretation (`useLlm: true`).** The server sends the query plus our vocabulary (up to 400 keywords, the people with their roles, the stored questions) and asks for the most likely keywords, people and stored question. The model may only copy entries from those lists. Anything else it returns is dropped (`sanitizeQuery`). The query is treated as untrusted data.
3. **Retrieval (`repo.retrieve`).** Documents are fetched locally from the query words (matched against keywords, with double weight for words in a stored question or a document title), the model's keywords, the owners it named and the stored question it picked. A document matched in several ways ranks higher.
4. **Scoring (`trust.js`).** Documents that belong to a stored question are scored together with all other documents of that question, so agreement and conflicts are found. A document with no question stands alone, so nothing can confirm it (`agreed` stays 0). Each group gets a verdict, a conflict banner and "who can help" (a standalone document points to its owner).
5. **Order.** Most relevant group first; trust only breaks ties, otherwise a loosely related but trusted answer would beat the one that was asked. Only groups about as relevant as the best one are kept (a single shared word is not enough), at most 3.

6. **Draft answer (`POST /api/draft`, `ask.draft`).** A second, separate model call. The server re-runs the search (the interpretation is cached, so it is not paid twice), then takes the strongest sources **that apply to the selected country**: up to 3 from the best group and 1 from each other group, 4 at most, sorted by trust. Their full text (6,000 characters each, 16,000 in total) is attached to the prompt together with title, date, owner, countries and trust score. The model returns `{answer, sources, covered}`: at most three sentences, in the language of the question, using only facts in the documents, naming a conflict when documents disagree, and saying `covered: false` when the documents do not answer. Citation numbers are checked against the documents actually sent. If no source applies to the country, the model is not called. The draft is cached (query, country and document versions), appears in its own box above the scored sources, and is labelled as written by the model. The trust verdict and scores stay the authority: the model writes text, it never scores. A failure only hides the box.

The heading of the result is **the user's own query**: a stored question is only how documents are grouped for scoring. When several groups match, each gets a small "About: …" line naming its topic or document.

The page shows step 1 immediately ("Refining with Gemini…"), then replaces it with step 4's result and a line saying what the model understood. If the model is off, slow or fails, the quick results stay, with the reason shown, so search never depends on the LLM. Interpretations are cached in memory (50 entries, keyed by the query and the size of the vocabulary), so a repeated question does not call the model again. The country always comes from the selector, never from the model. Only the quick search is written to the gap log, and only for the top answer when it is a stored question that is not "rely".

### 5f. Knowledge check (`src/diagnose.js`)

After every upload or edit (`/api/upload`, `POST` and `PUT /api/documents`), the server starts a check in the background, so the upload answers at once and the page asks for the result (`POST /api/diagnose`, which waits for the same run).

1. **Settle old findings.** Open findings about an earlier *version* of this document are marked resolved ("a document it was about was updated"). Findings record the document versions they were based on.
2. **Neighbours (`repo.neighbours`).** The 4 documents that share the most keywords with the changed one, plus the documents of the same stored question.
3. **Local rules (always run, no model).** Same question with different claims for a shared country (conflict); a country that other documents cover but no source about this question covers (gap); documents with no owner; documents not updated for more than 36 months (outdated).
4. **Model diagnosis (`llm.diagnose`).** The changed document (up to 6,000 characters) and its neighbours (4,000 each, 20,000 in total) go into one prompt, with the people list. The model reports conflicts, duplicates, outdated documents and gaps with an explanation, a suggested fix and up to two people to contact. This finds contradictions without any hand-written label, so an uploaded document is compared with the others.
5. **Validation (`sanitizeDiagnosis`).** A finding is kept only if its document numbers are real, its **quotes occur verbatim in the document** (markdown and spacing ignored), and a conflict, duplicate or outdated finding has at least one verified quote. Contacts must be names in the people table; if none is valid, the owners and last editors of the documents involved are used. One verified side only lowers "high" confidence to "medium". At most 5 findings.
6. **Storage (`findings`, `finding_documents`, `finding_contacts`).** An open finding about the same documents is refreshed, not duplicated. A dismissed finding is not brought back unless one of its documents changed. If the model and the local rules find the same conflict, there is one finding with the model's wording.

The page shows a **Knowledge check** card under every upload and a **Knowledge health** list of all open findings, each with the evidence, how to fix it, who can help (with a pre-filled email link when the person has an address) and a *Dismiss* button. If the model fails, the local findings still show, with the reason. The model never changes data: it only proposes findings.

### 5c. Countries

`src/countries.js` holds the official ISO 3166-1 list and resolves what the user types (name, code, accents, a few aliases). `repo.addCountry()` stores only resolved countries. Document validation and `/api/answer` check against the `countries` table, so a country must be added before it can be used.

### 6. The UI (`public/index.html`)

A single page with no build step. The search bar calls `POST /api/ask` (quick result first, then the Gemini-refined one); the suggested-question chips call `POST /api/answer`. Both render:

- the verdict card (colour, answer, based-on source and score, conflict banner, who can help);
- the ranked sources, each with four tappable score bars that show *why*;
- an **Open source file** button that shows the original document text.

All API text is HTML-escaped, and an error banner appears if the backend is unreachable.

### 7. The demo scenarios

| Scenario | Result | Why |
|---|---|---|
| Retro correction, **NL** | 🟢 rely | The approval matrix scores 80 and nothing contradicts it. |
| Leaver bonus, **BE** | 🟡 check | The manual scores 90, but an ownerless chat contradicts it. The conflict caps the verdict and the owner is suggested. |
| Leaver bonus, **DE** | 🔴 don't act | No source covers Germany. Logged as a gap. |
| Same question after a German policy is added through the API | 🟢 rely | The new document scores 80 (fresh, owned, applies). No restart. |

Run `npm run demo` to see all four in the terminal.

### 8. Tests (`test/`)

- `trust.test.js`: freshness buckets, agreement cap, applicability, conflicts, gaps, each verdict.
- `db.test.js`: migrations, seeding, persistence across reopening a file, constraints, rollback on failure, answer log aggregation.
- `documents.test.js`: live create and update, version history, validation, SQL injection safety, gap log.
- `llm.test.js`, `env.test.js`: the Gemini client against mocked responses (both API routes, failures, retries, timeouts, key never leaked), prompt-injection guard, env file parsing, upload with a stubbed model, no model call for invalid or duplicate uploads.
- `countries.test.js`: the ISO list, resolving names and codes, rejecting invented countries, using a new country, email to people record.
- `upload.test.js`: metadata generation, upload and update, email ownership, manual keywords, duplicates, size limit, search.
- `ask.test.js`: closed-vocabulary check, query prompt, search without and with the model (stubbed), model failure, cache, standalone documents, relevance order, gap log, and the draft step (which sources are sent, only those applying to the country, no call when none apply, failure, cache, prompt caps and injection guard, citation validation).
- `diagnose.test.js`: local rules, no duplicates on a second run, automatic check after an upload, model findings and suggested people, one finding for the same conflict, model failure, dismiss and resolve-on-edit, endpoint validation, validation of the model output (invented quotes, people and documents), prompt caps, the real client.
- `api.test.js`: read endpoints, input validation, size limits, 404s.

## Project layout

```
data/seed.json       fictional demo data (questions, documents with full text)
data/trustlens.db    the database (created on first run, ignored by git)
src/db.js            driver selection, connection and migrations
src/repo.js          all SQL, validation and transactions
src/countries.js     ISO 3166-1 country list and name/code resolver
src/llm.js           Gemini client (document analysis, query interpretation, validation)
src/ask.js           search bar: interpretation, retrieval, grouping, scoring and the drafted answer
src/diagnose.js      knowledge check after an upload or edit (local rules + model, findings)
src/env.js           .env / *.env loader
src/metadata.js      built-in fallback for summary/keywords
scripts/llm-check.js checks the Gemini key
src/seed.js          loads demo data into an empty database
src/trust.js         scoring and verdict logic
src/server.js        HTTP API and static UI
public/index.html    UI
test/                unit, database and API tests
demo/demo.js         scripted CLI demo
```

## Extending

- **Add data:** use `POST /api/documents`, or add entries to `data/seed.json` and run `npm run reseed`.
- **Add a question:** add it to `data/seed.json` (the questions table has no write API yet).
- **Add a country:** add it to `COUNTRIES` in `src/trust.js` and to the dropdown in `public/index.html`.
- **Schema changes:** append a new string to `MIGRATIONS` in `src/db.js`. Never edit an existing one.
- **Different database:** all SQL is in `src/repo.js`, so moving to PostgreSQL means reimplementing that one file.
- **Automatic claim extraction:** replace the hand-provided `claim` and `answer` with an LLM step that runs when a document is created or updated.

## Limitations (proof of concept)

- The demo data is fictional and small.
- `claim` labels are provided by hand, so conflict detection is only as good as those labels.
- The LLM fills metadata on upload and interprets search queries. It does not yet extract claims or link documents to questions, so an uploaded document is scored alone (no agreement or conflict) until someone gives it a topic and claim through the API.
- The knowledge check compares a document with its 4 nearest neighbours only, so a conflict with a document that shares no keywords is not seen. The local ownership and age rules also flag neighbours that were not changed (dismiss them if they are not a concern). Findings are proposals: nothing is notified or changed automatically, and the contact link just opens an email.
- The drafted answer is only as good as the attached text: long documents are cut at 6,000 characters, and a model can still misread a source. That is why it cites its sources and sits next to the trust scores.
- Search quality depends on the keywords stored. With thousands of keywords the list sent to the model would need pre-filtering.
- Scores are transparent heuristics, not calibrated against real outcomes.
- No authentication: no accounts, permissions or email verification, and all write routes are open.
- Uploads are limited to `.md`/`.txt` files of about 200 KB. No PDF or Word parsing yet.
- SQLite fits a single server. Multiple servers would need PostgreSQL.
- Node marks `node:sqlite` as experimental. The app hides that one warning when it starts, and `better-sqlite3` is the fallback if that API changes.
- Tests were run on Node 18.18 (with `better-sqlite3`) and Node 22 (with `node:sqlite`).
