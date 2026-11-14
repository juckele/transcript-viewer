# transcript-viewer

A small local web app for reading Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`) and
seeing where the tokens went. Pages update live as sessions are written.

```bash
node server.js            # http://127.0.0.1:4777
```

No dependencies (Node 18+). It only listens on 127.0.0.1, and only answers requests addressed to `localhost`,
`127.0.0.1` or `[::1]` on its port, so a web page can't reach it through DNS rebinding.

## Screenshots

The session that built this tool, as the viewer shows it.

**Reader.** Each prompt box shows that turn's time, API calls, tokens and cost. Steps with no visible
reply collapse to one line with their cost and tokens; this one is open to show a tool call.

![Reader with one step expanded](docs/screenshots/reader.png)

**Reader, everything collapsed** (dark theme).

![Reader with all steps collapsed, dark theme](docs/screenshots/reader-collapsed-dark.png)

**Usage.** Estimated cost or tokens per day, split by category.

![Usage page with a daily cost tooltip](docs/screenshots/usage.png)

**Sessions.**

![Sessions list](docs/screenshots/sessions.png)

## Views

- **Sessions**: every session, most recent first: title, folder, prompts, API calls, tokens, estimated cost.
- **Session**: the conversation, split into turns. Tool calls, thinking and subagent conversations are
  collapsed. Each API call shows its tokens (input, cache write, cache read, output, thinking) and cost.
- **Usage**: tokens or estimated cost per day, split by category, plus totals by model.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4777` | HTTP port |
| `HOST` | `127.0.0.1` | Address to listen on |
| `ALLOWED_HOSTS` | unset | Extra host names the server answers to, comma-separated (e.g. a LAN name when `HOST` is `0.0.0.0`) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Folder of transcripts to read |
| `WEEKLY_RESET_AT` | unset | Any past or future weekly-limit reset time (ISO 8601, e.g. `2026-11-12T01:00:00Z`). When set, the Usage page shows totals for the current weekly window. |

## How the numbers are calculated

- Claude Code writes one API response over several lines that repeat the same `usage`. The viewer
  counts each `message.id` once.
- Costs use the list prices in `pricing.json`. The Opus 5.5 figures match the cost Claude Code itself logs.
  Prices marked `"assumed": true` are guesses; costs that use them show a `~`.
- Thinking text is usually empty in the logs (the API leaves it out by default). Its token count is still logged.
- The cost is what this usage would cost at API list prices. Your subscription plan's limits are measured
  differently, so treat these numbers as a guide.
- The bold **Discounted cost** column scales list cost by `monthlyPrice / apiCreditsPerMonth` from the
  `subscription` block in `pricing.json`: roughly what the usage costs on the subscription. `apiCreditsPerMonth`
  is our own rough estimate of how much list-price usage the plan covers in a month; edit it as that changes.

## Usage sampler

`sampler/sample-usage.js` records how full the plan's limits are (5-hour, weekly and per-model weekly), so they
can be matched against list-price cost to measure what each limit is worth. `sampler/install.sh` runs it every
minute (a systemd user timer on Linux, a launchd agent on macOS); `install.sh --uninstall` removes it.

```bash
sampler/install.sh
```

Each run:

- Asks `api.anthropic.com/api/oauth/usage` (the endpoint behind `/usage`; not documented, so it may change)
  for the current percentages. It polls every minute while a transcript was written in the last 15 minutes,
  otherwise every 15 minutes.
- Appends a line to `samples-YYYY-MM.jsonl` when any percentage or reset time changes, and at least hourly.
  `prevPollTs` is the last poll that saw the old values, so each change happened between `prevPollTs` and `ts`.
  The percentages are whole numbers; the times they tick over are what pins the estimate down.
- Every 10 minutes while active, updates `ledger.jsonl`: one row per API response in this computer's
  transcripts (`message.id`, time, model, token counts, session), with no message text.
- Uses Claude Code's own login. When the token is about to expire it runs `claude auth status`, which refreshes
  it the same way Claude Code does. On macOS the login is read from the keychain, which may ask once to let
  `security` read "Claude Code-credentials".

Files go to `~/.local/share/claude-usage/<host>/` (`--dir <path>` or `CLAUDE_USAGE_DIR` changes it).

To combine several computers, make an empty private repo and install with it on each one:

```bash
sampler/install.sh --repo https://github.com/<you>/<private-repo>.git   # or set CLAUDE_USAGE_REPO
```

The installer clones it to `~/git/<repo name>`. Every 30 minutes, if anything changed, the sampler commits its
own `<host>/` folder, rebases onto the other computers' commits and pushes. Each computer only writes its own
folder, so the rebase never conflicts. The clone gets its credentials from the GitHub CLI's login
(`gh auth git-credential`) when `gh` is installed, so pushing needs no prompt. The percentages are for the whole
account, so a sample from any computer counts; ledgers combine by `message.id`.

Usage that leaves no transcript here (claude.ai chat, the phone app, cloud sessions) still moves the
percentages, so keep it out of the measuring week or note when it happened.

### Estimating what the limits are worth

```bash
node sampler/analyze.js        # --dir <data dir>, --out <file>, --quiet
```

It reads every computer's folder in the data dir, which it finds the way `install.sh` does (`--dir`,
`CLAUDE_USAGE_DIR`, `~/git/<repo name>` when `CLAUDE_USAGE_REPO` is set, else `~/.local/share/claude-usage`).
Each time a limit goes up by 1%, it adds up the list-price cost of every API call since that window opened.
Cost against percentage is close to a straight line, and its slope is the list-price value of 1% of the limit.
Each window gets its own intercept, which absorbs usage the plan counted but the ledgers don't have. Ticks
where the polls around it are more than 15 minutes apart are left out.

It prints a summary and writes `~/.local/state/claude-usage-sampler/analysis.json` (or under
`CLAUDE_USAGE_STATE_DIR`). The viewer's Usage page shows the last run under "Plan limits at list price": the
value of each limit, its weekly value per month next to `pricing.json`'s estimate, how much usage the
transcripts miss, and which computers have stopped sending samples.

## How it works

`server.js` reads each transcript once, then reads only the lines appended since. It watches the folder
with `fs.watch` (and rescans every 5 s in case an event is missed). It tells open pages what changed over
server-sent events (`/events`), and each page reloads only the data it shows.
