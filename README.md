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
npm test             # 52 tests (node:test, in-memory databases)
npm run demo         # scripted CLI demo: good / conflict / gap / gap closed live
npm run reseed       # delete the database file and load the demo data again
```

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/trustlens.db` | database file |
| `TRUST_NOW` | value in the DB (`2026-09`) | reference date for freshness |
| `SEED_DEMO` | `true` | set to `false` to start with an empty database |
| `TRUST_SQLITE_DRIVER` | auto | force `node:sqlite` or `better-sqlite3` |

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
| GET | `/api/search?q=` | simulated search over questions and keywords |
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
- **Generated metadata** (`src/metadata.js`, no LLM yet): title (first `# heading` or file name), summary, weighted keywords. Each document also stores owner email, last editor, last edited date, size, content hash, original file name, `source` (`api`, `upload`, `seed`) and `meta_source` (`heuristic`, `manual`, later `llm`). **`generate()` in `metadata.js` is the one function an LLM call replaces.** Keywords live in the `document_keywords` table (indexed) and drive search.
- **Countries:** the "Applies to" checkboxes and the search country selector come from the `countries` table (it starts with Belgium, Netherlands and Germany). The upload form has an **Add country** box with all 249 official countries of ISO 3166-1 as suggestions. You can type the English name or the two-letter code (`France`, `fr`; a few common aliases such as `UK` work too). Anything that is not a real country is rejected (`400`), and a country is stored once. A new country can then be used on documents and in searches; a question with no document for it shows as a knowledge gap.
- **Type:** the Type field is free text with the stored types as suggestions. An unknown type is added to the `document_types` table the first time it is used (the confirmation says so). Matching ignores case and extra spaces, so "meeting NOTES" reuses "Meeting notes". Types are 1 to 40 characters (letters, digits, spaces, `& / . -`). On an update, leaving the type empty keeps the current one.
- **Keywords (optional):** the upload form has one Keywords field (comma separated). Manual keywords are added to the generated ones and ranked first. Every keyword is stored once in the global `keywords` table, so a new keyword is added the first time anyone uses it, and the form lists existing keywords as clickable suggestions. Manual keywords are kept when a document is updated without new keywords; giving new ones replaces the manual set. The upload response lists what was new to the database (`added.type`, `added.keywords`).
- **Question links:** the upload form no longer links a document to a question. Uploaded documents are searchable by their keywords but do not take part in a trust verdict yet; the API (`topic`, `answer`, `claim` on `POST /api/upload` and `/api/documents`) still supports it, and the LLM step is meant to do this automatically.
- **Search (`GET /api/search?q=`):** simulated. It matches the words against question texts and stored keywords and returns matching questions and documents. Opening a question shows the trust verdict. This is the part an LLM question-routing step replaces.

### 5c. Countries

`src/countries.js` holds the official ISO 3166-1 list and resolves what the user types (name, code, accents, a few aliases). `repo.addCountry()` stores only resolved countries. Document validation and `/api/answer` check against the `countries` table, so a country must be added before it can be used.

### 6. The UI (`public/index.html`)

A single page with no build step. It loads the questions from the API, then on every change calls `POST /api/answer` and renders:

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
- `countries.test.js`: the ISO list, resolving names and codes, rejecting invented countries, using a new country, email to people record.
- `upload.test.js`: metadata generation, upload and update, email ownership, manual keywords, duplicates, size limit, search.
- `api.test.js`: read endpoints, input validation, size limits, 404s.

## Project layout

```
data/seed.json       fictional demo data (questions, documents with full text)
data/trustlens.db    the database (created on first run, ignored by git)
src/db.js            driver selection, connection and migrations
src/repo.js          all SQL, validation and transactions
src/countries.js     ISO 3166-1 country list and name/code resolver
src/metadata.js      placeholder summary/keyword generation (LLM goes here)
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
- Scores are transparent heuristics, not calibrated against real outcomes.
- No authentication: no accounts, permissions or email verification, and all write routes are open.
- Uploads are limited to `.md`/`.txt` files of about 200 KB. No PDF or Word parsing yet.
- SQLite fits a single server. Multiple servers would need PostgreSQL.
- Node marks `node:sqlite` as experimental. The app hides that one warning when it starts, and `better-sqlite3` is the fallback if that API changes.
- Tests were run on Node 18.18 (with `better-sqlite3`) and Node 22 (with `node:sqlite`).
