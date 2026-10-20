# Trust Lens

Trust Lens is the bridge between the customer organisation's search engine/AI and its users.

Answers with visible trust. For every question, Trust Lens finds the relevant company documents, scores each one on **freshness, ownership, applicability and agreement**, and tells you whether you can rely on the answer, should check first, or should not act yet. It surfaces conflicts between sources, flags knowledge gaps, and names who to ask.

The data lives in a real SQLite database. The demo data is fictional: a company ("Northwind"), 11 documents, 6 people and three payroll questions.

## Quick start

Requires **Node >= 22.13**. No dependencies and no `npm install`: the database is Node's built-in `node:sqlite`.

```bash
npm start            # UI + API at http://localhost:3000 (creates and seeds data/trustlens.db on first run)
npm test             # 37 tests (node:test, in-memory databases)
npm run demo         # scripted CLI demo: good / conflict / gap / gap closed live
npm run reseed       # delete the database file and load the demo data again
```

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/trustlens.db` | database file |
| `ADMIN_TOKEN` | unset | when set, write routes require `Authorization: Bearer <token>` |
| `TRUST_NOW` | value in the DB (`2026-09`) | reference date for freshness |
| `SEED_DEMO` | `true` | set to `false` to start with an empty database |

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

SQLite in WAL mode with foreign keys on. The schema is an append-only list of migrations; the applied version is stored in `PRAGMA user_version`, so opening an old database upgrades it automatically.

| Table | Holds |
|---|---|
| `documents` | file name, title, type, `doc_date` (YYYY-MM), owner, topic, claim, answer, body, version, timestamps |
| `document_countries` | which countries each document applies to (many-to-many) |
| `document_versions` | a snapshot of the document and who edited it, for every save |
| `people` | owners, as name and role |
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

Errors return JSON `{error}`: `400` invalid input, `401` missing or wrong token, `404` unknown route or document, `409` file name already used, `413` body too large, `500` unexpected error (details are logged, not returned).

**Security notes:** every query uses bound parameters (tested with hostile input), document names are checked against the database instead of the file system, request bodies are size-limited, and write routes can be protected with `ADMIN_TOKEN` (compared in constant time). There is no per-user authentication yet.

### 5. The gap log

Every answer that is not green is stored in `answer_log`, so it survives restarts. `/api/gaps` ranks the most-asked unreliable questions and splits them into **gaps** (no source covers the country) and **conflicts** (sources disagree). Adding the missing document closes the gap immediately, which is the feedback loop the product is built on.

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
- `documents.test.js`: live create and update, version history, validation, SQL injection safety, admin token, gap log.
- `api.test.js`: read endpoints, input validation, size limits, 404s.

## Project layout

```
data/seed.json       fictional demo data (questions, documents with full text)
data/trustlens.db    the database (created on first run, ignored by git)
src/db.js            connection and migrations
src/repo.js          all SQL, validation and transactions
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
- One shared admin token, no per-user accounts or permissions.
- SQLite fits a single server. Multiple servers would need PostgreSQL.
- `ExperimentalWarning`: Node marks `node:sqlite` as experimental; the npm scripts hide the warning.
