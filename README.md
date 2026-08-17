# TempoQuiz

Live classroom quizzes over a phone browser. An instructor writes questions in
Markdown, opens a room, and puts a QR code on the projector; students join with a
nickname and answer against a shared clock. Scoring, timing and one-answer-only are
decided server-side.

Built at [WING](https://wing.comp.nus.edu.sg/), School of Computing, National
University of Singapore. Runs anywhere Node runs, and is published over an ngrok
tunnel so no firewall changes or university hosting are needed.

<p align="center">
  <img src="public/assets/wing-logo.png" alt="WING — Web Information Retrieval / Natural Language Processing Group" width="360">
</p>

---

## Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Operating](#operating)
- [Configuration](#configuration)
- [Writing a quiz](#writing-a-quiz)
- [Running a session](#running-a-session)
- [The question bank](#the-question-bank)
- [Data, exports and backups](#data-exports-and-backups)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [HTTP API](#http-api)
- [Development](#development)

---

## Requirements

| | |
|---|---|
| Node.js | 22.5 or newer — uses the built-in `node:sqlite`, which is why nothing needs compiling |
| ngrok | free account; only if you want students outside your LAN to reach it |
| OS | Linux or macOS. On Windows use WSL2 |

Nothing else. `./run.sh` installs the three npm dependencies on first run.

---

## Setup

```bash
git clone https://github.com/sahajps/WING-TempoQuiz.git
cd WING-TempoQuiz
./run.sh
```

The first run creates `config/tempoquiz.yml` from the committed template and stops,
because two values are yours to supply:

```
────────────────────────────────────────────────────────────────
  Created config/tempoquiz.yml
────────────────────────────────────────────────────────────────
  admin.password
     still holds the placeholder from the template
     → Set it to a password of at least 10 characters with a letter and a digit.

  ngrok.authtoken
     still holds the placeholder from the template
     → Copy your free token from
       https://dashboard.ngrok.com/get-started/your-authtoken
```

Edit those two lines, then run `./run.sh` again:

```
  Students   https://quiz-yourname.ngrok-free.app
  Console    https://quiz-yourname.ngrok-free.app/admin
  Local      http://localhost:3000
```

`config/tempoquiz.yml` holds your credentials. It is created `chmod 600` and is listed
in `.gitignore`; the committed file is `config/tempoquiz.example.yml`, which contains
only placeholders. Verify with `./run.sh doctor`, which fails loudly if the private
config ever becomes tracked.

### Claim a static domain

Free ngrok accounts include one permanent domain. Without it, every restart issues a
new random URL and yesterday's QR code is dead. Claim one at
[dashboard.ngrok.com/domains](https://dashboard.ngrok.com/domains) and set it:

```yaml
ngrok:
  domain: "quiz-yourname.ngrok-free.app"
```

---

## Operating

`run.sh` is the only command. The server and tunnel are started in their own session,
so **closing your SSH connection leaves them running**.

| Command | |
|---|---|
| `./run.sh` | start the server and the tunnel; print the public link |
| `./run.sh stop` | stop both |
| `./run.sh restart` | stop, then start |
| `./run.sh status` | what is running, and on what URL |
| `./run.sh url` | print just the public URL |
| `./run.sh logs` | follow both logs |
| `./run.sh doctor` | check everything; explains anything wrong |
| `./run.sh passwd` | change the console username and password |
| `./run.sh backup` | snapshot the database now |
| `./run.sh test` | run the test suite |

Starting twice is refused rather than half-starting a second copy. Logs are in
`logs/`, process ids in `run/`; both are git-ignored.

For a one-off override without editing config:

```bash
PORT=8080 NGROK_DOMAIN=other.ngrok-free.app ./run.sh
```

---

## Configuration

Everything lives in `config/tempoquiz.yml`. Only the first two matter to get started.

| Key | Default | |
|---|---|---|
| `admin.username` | `admin` | Console sign-in |
| `admin.password` | — | Used **once**, to create the account. After that it is ignored; change the password with `./run.sh passwd` and blank this line |
| `ngrok.enabled` | `true` | `false` runs on the LAN only, with no tunnel |
| `ngrok.authtoken` | — | Free token from the ngrok dashboard |
| `ngrok.domain` | — | Your permanent domain, without `https://` |
| `ngrok.region` | — | `us`, `eu`, `ap`, `au`, `sa`, `jp`, `in` |
| `server.port` | `3000` | |
| `server.bind` | `0.0.0.0` | `127.0.0.1` to refuse direct LAN connections |
| `server.public_url` | — | Only if you terminate TLS behind your own proxy |
| `server.session_secret` | generated | Changing it signs everyone out |
| `server.session_hours` | `12` | |
| `quiz.max_participants` | `400` | |
| `quiz.answer_grace_ms` | `1500` | Latency allowance for an answer arriving just after time |
| `backup.interval_minutes` | `60` | `0` disables automatic snapshots |
| `backup.keep` | `24` | |
| `security.login_max_attempts` | `8` | Failures per IP before lockout |
| `security.login_window_minutes` | `15` | |

Environment variables of the same name override the file, which is what the test
suite uses.

---

## Writing a quiz

In the console, **New quiz**. Press *Insert example* to see the shape, then replace it.
Validation runs as you type and points at the exact line of anything wrong.

This is what *Insert example* gives you, verbatim:

````markdown
# Example — Ranked retrieval

## Question 1
**Time:** 20
**Topic:** Example — Ranked retrieval
**Difficulty:** easy

In a term-document incidence matrix, what does a 1 in row *calpurnia*, column *Hamlet* mean?

- [ ] The term is the most frequent word in the play
- [x] The term occurs somewhere in the play
- [ ] The term occurs exactly once in the play
- [ ] The play is the top result for the query

## Question 2
**Time:** 30
**Topic:** Example — Ranked retrieval
**Difficulty:** medium

Why is inverse document frequency used alongside term frequency?

- [ ] It makes the index smaller
- [ ] It speeds up posting-list intersection
- [x] It reduces the weight of terms that appear in many documents
- [ ] It normalises for document length

## Question 3
**Time:** 25
**Topic:** Example — Ranked retrieval
**Difficulty:** hard

A system returns 10 documents, 4 of which are relevant, out of 20 relevant documents in the collection. What are precision and recall?

- [x] Precision 0.4, recall 0.2
- [ ] Precision 0.2, recall 0.4
- [ ] Precision 0.4, recall 0.4
- [ ] Precision 0.2, recall 0.2
````

The correct option does not have to be first — `- [x]` marks it wherever it sits.

| Field | Required | |
|---|---|---|
| `# Title` | yes | Exactly one, at the top |
| `## Question N` | yes | Numbered consecutively from 1 |
| `**Time:**` | yes | Whole seconds, 10–600 |
| Options | yes | 4–6 `- [ ]` lines, exactly one `- [x]` |
| `**Image:**` | no | `http(s)://…` or a root-relative `/path`; executable URLs are refused |
| `**Image alt:**` | with image | Required whenever an image is present |
| `**Reveal:**` | no | `show` (default) or `slow` |
| `**Show ranking:**` | no | `yes` (default) or `no` — suppresses standings after that question |
| `**Topic:**` | no | Groups the question in the bank |
| `**Difficulty:**` | no | `easy`, `medium`, `hard` |

The format is deliberately trivial to generate. Give an LLM the table above and ask for
questions "in exactly this format".

---

## Running a session

### Prepare now, run later

A quiz is **saved the moment you create it** and waits for you — write Monday's quiz on
Friday, close the laptop, and come back to it on the day.

Until you say otherwise the room is **shut**: the code exists but nobody can join it, so
a class cannot wander into tomorrow's quiz tonight. Prepared quizzes are listed under
*Console → Quizzes* with a **prepared** badge (filter the list to *Prepared* to see just
those); **Set up** reopens the host screen exactly as you left it.

When the lecture starts, press **Open the room** on the host screen. Only then do the QR
code and the room code appear, and only then can students join. A student who scans
ahead of time gets a *Not open yet* page that lets them in by itself the moment you open
the room, so nobody needs to rescan.

Opened one too early? **Close the room again** shuts it, up until the first question is
released. After that it stays open, because the class is mid-quiz.

### On the day

1. **Create quiz** — you get a six-character room code. Nothing is live yet.
2. **Open the room**, and put the host screen on the projector. The QR code appears and
   students join into the lobby.
3. **Release question 1.** Everyone gets a synchronised two-second ready screen, then
   the clock starts together.
4. The projector shows the question, its options, and a count of how many have
   answered — never who chose what. *Close now* ends it early; otherwise it closes
   itself.
5. When the timer stops, the buzzer sounds and the breakdown, the correct answer and
   the leaderboard appear together, to applause.
6. Release the next, or **Finish quiz**.
7. After finishing, the host screen becomes a review console: pick a question and it
   appears on every student's phone with the correct answer marked. Questions are
   listed worst-answered first.
8. Export as Markdown, CSV or JSON.

Questions can be appended to a quiz that is already running, from *Questions → Add more
questions*.

**Scoring.** A correct answer is worth 500 points plus up to 500 more for speed, linear
from the moment the question opens to the moment it closes. Wrong answers score
nothing; one answer each. Ties break on total answering time, so two students on equal
points are only shown level if they were equally fast.

**What the room can see.** The host screen shows nicknames, scores, and the text of
questions that have already been released. It never shows Student IDs, never shows a
question before the class has been given it, and never shows the answer distribution
while students are still voting.

**Sound.** The host screen runs a pitched countdown while a question is open — a bass
pulse on the beat with an alternating pluck over it, which doubles in tempo and steps
up for the last five seconds. Time expiring plays a falling sting; the leaderboard
arrives on a rising fanfare with applause.

All of it is synthesised in the browser with the Web Audio API: no audio files, nothing
to download, and no third party's copyrighted sounds in the repository. The applause is
built as forty-odd individual clappers, each with its own pair of hands and its own
rhythm, rather than as filtered noise — which is what makes it sound like a room rather
than static. Mute it with the **Sound** button in the header (remembered per browser).
Student phones stay silent throughout.

---

## The question bank

Every question carries a status:

| | |
|---|---|
| **Never used** | Free. The only ones a random draw will pick |
| **Reserved** | Sitting in a quiz you have built but not yet run |
| **Already used** | A class has seen it. Permanently spent |
| **Retired** | Withdrawn by you. Never offered again; history kept |

A question becomes *used* when it is **released to students**, not when it is added to a
quiz.

Where the rule bites:

- The editor warns, naming the earlier quiz and date, if a pasted question has been
  asked before — and separately if it is already committed to another quiz waiting to
  run.
- **Draw** picks only from never-used questions, and says plainly when the pool is too
  small rather than quietly returning fewer.
- Building a quiz from a used question is refused unless you tick *Allow questions that
  have already been used*.
- Importing Markdown skips questions already in the bank instead of duplicating them.
- A question that has been asked **cannot be deleted**, only retired — deleting it would
  destroy the record the no-repeat rule depends on.

Questions enter the bank automatically when you create a quiz from the editor, or in
bulk via *Import Markdown*.

---

## Data, exports and backups

```
data/
├── tempoquiz.db                      everything (mode 600)
├── archives/2026-08-13/
│   └── week-3-ranked-retrieval__H7K2QP.json
└── backups/
    └── tempoquiz-2026-08-13T09-00-00-000Z-auto.db
```

`data/` is `chmod 700`, the database `600`, and the whole directory is git-ignored.

**Archives** are a complete human-readable record per quiz, filed by creation date and
named after the quiz. Written on create, append and finish, so they are never more than
one action behind.

**Backups** are taken at startup and hourly, keeping the newest 24, using SQLite's
`VACUUM INTO` — safe to run mid-quiz, and each file is a standalone database.

To restore:

```bash
./run.sh stop
cp data/backups/tempoquiz-<timestamp>-auto.db data/tempoquiz.db
rm -f data/tempoquiz.db-wal data/tempoquiz.db-shm
./run.sh
```

---

## Troubleshooting

Start here:

```bash
./run.sh doctor
```

It checks Node version, `node:sqlite`, dependencies, the ngrok binary, config validity
and file permissions, port ownership, database integrity, backup count, free disk, and
whether your private config has accidentally become tracked by git.

### Startup

**`Node 20.x is too old`**
TempoQuiz needs 22.5+ for the built-in SQLite. `nvm install 22 && nvm use 22`. If
`node -v` disagrees with what `run.sh` reports, run.sh is finding a different binary —
`NODE_BIN=$(which node) ./run.sh`.

**`Cannot find module 'node:sqlite'`**
Same cause. Node is below 22.5.

**`Port 3000 is already in use`**
An earlier copy is probably still running: `./run.sh stop`. If something else owns it,
change `server.port`. To identify the holder without `ss` or `lsof`:
`grep ':0BB8' /proc/net/tcp` (`0BB8` is 3000 in hex).

**Server exits immediately, no error on screen**
`./run.sh logs`, or `tail -50 logs/server.log`. A YAML syntax error is the usual cause
and is reported with a line number — most often a tab used for indentation, or a value
containing `: ` that is not quoted.

**`config/tempoquiz.yml is not valid YAML`**
YAML forbids tabs for indentation. Quote any value containing a colon, `#`, or leading
`*`/`&`.

### ngrok

**Students see an ngrok warning page**
Expected on the free tier. Each phone taps *Visit Site* once per browser session. The
app's own polling bypasses it, so gameplay is unaffected. Warn the room, or upgrade.

**`ERR_NGROK_108` / "limited to 1 simultaneous session"**
Free accounts allow one agent. Something else is already connected — another terminal,
or a previous run. `./run.sh stop`, then `pkill ngrok` if needed. Check
[dashboard.ngrok.com/agents](https://dashboard.ngrok.com/agents).

**`ERR_NGROK_105` / authentication failed**
The authtoken is wrong or truncated. Re-copy it whole from the dashboard into
`ngrok.authtoken`.

**`ERR_NGROK_313` / domain not authorized**
The domain in `ngrok.domain` is not on your account, or is misspelled. It must be the
bare hostname — no `https://`, no trailing slash.

**Tunnel opens but the QR sends phones to `localhost`**
`run.sh` starts ngrok first and passes the live URL to the server, so this should not
happen. If it does, you likely started the server by hand. Use `./run.sh`. Confirm with
`./run.sh url` and by checking the join link on the host screen.

**URL changed and yesterday's QR is dead**
Expected without a static domain. Claim your free one and set `ngrok.domain`.

### During a quiz

**A student's phone is stuck on "Connecting…"**
Their session token was lost — usually a closed tab. They rejoin at the room code with
the *same nickname and the same last 4 characters*, and their score is preserved.

**"Someone in this room is already using that nickname"**
Nicknames are unique per room. A student who genuinely dropped out should rejoin with
the identical nickname *and* Student ID suffix, which is recognised as the same person
rather than a clash.

**Answers rejected as "Time is up"**
The clock is the server's. `quiz.answer_grace_ms` (default 1500 ms) absorbs latency;
raise it for a poor connection.

**Timers disagree between phones**
They should not — clients sync to server time on every poll. Persistent disagreement
means a phone is polling very slowly; check the venue Wi-Fi.

**Rankings not showing after a question**
On student phones, that question has `**Show ranking:** no`. The host screen always
shows the leaderboard once a question closes, regardless of that setting.

**No sound on the host screen**
Browsers refuse to play audio until you have interacted with the page — click anywhere
once. Check the **Sound** button in the header does not read "Sound off". Sound is
deliberate on the host screen only; student phones never make noise.

**The tally is not appearing during a question**
That is intentional. Counts and the correct answer are withheld until the timer stops,
so a projected screen cannot bias the vote. The "Answers in" meter shows participation
without revealing choices.

### Console and data

**Locked out after failed sign-ins**
Eight failures per IP triggers a 15-minute lockout. Wait, or reset on the host machine
with `./run.sh passwd`.

**Forgot the password**
`./run.sh passwd`. The value in `config/tempoquiz.yml` is *not* used once the account
exists.

**"Set a new administrator password before using the console"**
You are still on a generated first-run password. Change it; the console then unlocks.
Until then that session can do nothing else.

**Signed out on every restart**
`server.session_secret` is changing. It is written into your config on first run;
confirm it is a real value and not the placeholder.

**Draw returns nothing**
Every matching question is used, reserved or retired. Import more, widen the topic
filter, or tick *Allow questions that have already been used*.

**Cannot delete a bank question**
It has been asked in class. Retire it instead. This is deliberate.

**Database integrity check fails**
Stop, restore the newest snapshot from `data/backups/` (see above), and restart. If the
process is still running and the file was deleted out from under it, the data is
recoverable from `/proc/<pid>/fd/` before you stop it.

---

## Security

- **Passwords** — scrypt (N=16384) with a per-account salt, constant-time comparison. A
  wrong username and a wrong password give the same message in the same time.
- **First-run password quarantine** — a generated bootstrap password is printed to the
  log, so a session holding it can do nothing but replace it.
- **Sign-in throttling** — per-IP, recorded in the database so a restart does not clear
  it.
- **Sessions** — 32 random bytes, stored as an HMAC. Cookie is `HttpOnly`,
  `SameSite=Lax`, and `Secure` whenever the request arrived over HTTPS.
- **CSRF** — required on every cookie-authenticated state change, plus a same-origin
  check. Requests authenticated by an explicit host token are exempt, since those are
  not sent ambiently by a browser.
- **Host tokens** — stored only as a SHA-256 hash, shown once, and carried in request
  bodies so they stay out of browser history and access logs.
- **SQL injection** — every statement is parameterised.
- **XSS** — the front end builds all DOM through `textContent`; no user text is ever
  interpolated into markup. CSP is `script-src 'self'` with no `unsafe-inline`.
  (`style-src` permits inline styles, which are used for layout.)
- **Question images** — restricted to `http(s)` and root-relative paths; `javascript:`
  and `data:` are rejected by the parser.
- **One answer per student** — a `UNIQUE` constraint in the database, so two racing taps
  cannot both land.
- **No early answer leak** — the correct option is withheld from the API until the
  question closes, and submitting does not reveal whether you were right.
- **Student identifiers** — never sent to a student screen, and never sent to the host
  screen either. They exist only in exports and the on-disk archive.

**Scope.** The student-number suffix is for classroom tracking, not identity
verification: anyone with the room code can join under any nickname. Do not use
TempoQuiz for assessment that counts without a separate check on who is present. While
the tunnel is up the app is on the public internet — `./run.sh stop` when you are done.

---

## HTTP API

Admin routes need a session cookie. Quiz routes accept either a session or the quiz's
host token (`X-Host-Token`, or `hostToken` in the body).

| | |
|---|---|
| `POST /api/quizzes/validate` | Check Markdown; returns line-numbered errors |
| `POST /api/quizzes` | Create from `markdown` or `questionIds`; the room starts shut |
| `GET /api/quizzes/:code/host` | Host state |
| `GET /api/quizzes/:code/qr.svg` | Join QR code |
| `POST /api/quizzes/:code/open` | Open the room to students. Idempotent |
| `POST /api/quizzes/:code/close-room` | Shut it again; refused once the quiz has started |
| `POST /api/quizzes/:code/release` | Open the next question |
| `POST /api/quizzes/:code/close` | Close the current question |
| `POST /api/quizzes/:code/append` | Add questions to a live quiz |
| `POST /api/quizzes/:code/review` | Push a question to student screens |
| `POST /api/quizzes/:code/finish` | End the quiz |
| `POST /api/quizzes/:code/export` | `format`: `markdown` \| `csv` \| `json` |
| `GET POST /api/bank/questions` | List / create |
| `POST /api/bank/import` | Bulk import, skipping duplicates |
| `POST /api/bank/draw` | Random draw of never-used questions |
| `POST /api/bank/check-reuse` | Which of these have been asked before? |
| `GET /api/play/:code` | Public lobby summary |
| `POST /api/play/:code/join` | Join; returns a player token |
| `GET /api/play/:code/state` | Student state (`X-Player-Token`) |
| `POST /api/play/:code/answer` | Submit an answer |

Appends are guarded against two editors working from different versions:

```http
POST /api/quizzes/ABC123/append
Content-Type: application/json

{
  "hostToken": "…",
  "expectedQuestionCount": 3,
  "markdown": "## Question 4\n**Time:** 20\n\nWhich choice is correct?\n\n- [x] One\n- [ ] Two\n- [ ] Three\n- [ ] Four"
}
```

If the quiz no longer holds exactly three questions the request fails with `409` and
reports the real count, rather than appending in the wrong place.

---

## Development

```bash
./run.sh test
```

77 tests: Markdown parser, scoring and ranking, bank rules including the no-repeat
guarantee, and the HTTP API end to end — including that a prepared quiz cannot be joined
until its room is opened. They run against a temporary data directory and never touch
`data/`.

```
server/
├── index.js          Express app, routes, startup, shutdown
├── config.js         YAML config with environment overrides
├── db.js             SQLite connection, WAL, transactions, migrations
├── schema.sql        Tables and constraints
├── auth.js           scrypt passwords, sessions, throttling
├── security.js       Headers, CSRF, rate limits, cookies
├── markdown.js       Quiz format parser and serializer
├── bank.js           Question bank and the no-repeat rule
├── quiz-service.js   Quiz lifecycle, scoring, exports
├── scoring.js        Points and ranking
├── archive.js        JSON records on disk
├── backup.js         Database snapshots
├── routes/           admin, bank, quizzes, play
└── cli/              init, passwd, backup

public/               Hand-written HTML, CSS and JS. No build step
test/                 Parser, scoring, bank, API
config/               tempoquiz.example.yml — the committed template
run.sh                Start, stop, diagnose; the only command you need
```

---

## Report Issue/Feedback

To report any bug, please feel free to open an issue or email Sahaj. If you’re part of a research group and have used this for teaching or other educational purposes, we’d love to hear about your experience. Thanks!
