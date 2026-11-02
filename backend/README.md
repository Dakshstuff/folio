# Folio Backend — User Provisioning (`create_user.py`)

> **WARNING — PRIVATE, LOCAL-ONLY ADMIN UTILITY.**
> This script authenticates with a full-privilege Appwrite API key. The key
> must never leave the administrator's machine: never commit it, never embed
> it in the Folio frontend, never paste it into chat, tickets or e-mail, and
> never pass it on a command line. The Folio frontend (3 static files) talks
> to Appwrite with each user's own session and must **never** receive or
> contain this key.

## Purpose

Folio runs on an Appwrite Cloud project with **Email/Password auth enabled and
public signup disabled**: nobody can register themselves. An administrator
uses this script to enrol each user. One run creates — or safely reuses:

1. the two Folio teams (`admins` / `viewers`, IDs configurable);
2. the user's auth account (created through the administrative users API);
3. the user's profile document in the `profiles` collection — document `$id`
   equals the Appwrite user ID, with the string attributes `email`,
   `displayName`, `username` and `role` (`"admin"` or `"viewer"`);
4. the user's membership in **exactly one** team: `viewer` → viewers,
   `admin` → admins.

Team membership is the server-enforced role: the database collections and the
storage bucket grant `write` only to the `admins` team, while every
authenticated user can read.

The script is **idempotent**: every step is an "ensure" operation, so
re-running the same command after a partial failure is the official recovery
procedure.

## Scripts in this folder

| Script | What it does | When to run it |
| --- | --- | --- |
| `setup_database.py` | Creates the **entire schema**: teams, database, all five collections, every attribute and index, and the storage bucket. Prints a ready-to-paste `FOLIO_CONFIG`. | **Once** per Appwrite project — before the first sign-in. Safe to re-run any time (idempotent, never deletes). |
| `create_user.py` | Enrols **one user**: auth account, profile document, team membership. | Once per person. |
| `schema-*.csv` | Spreadsheet checklists of the exact schema (collections, attributes, indexes) — for reference or hand-building in the console. | Optional. |

## `setup_database.py` — one-command schema provisioning

```bash
python3 setup_database.py
```

What it does, in order: connectivity check → ensure teams → ensure database →
ensure the five collections (with permissions and document-security flags) →
create every attribute and wait until Appwrite reports it `available` →
create every index (full-text `searchText`, key, unique) → ensure the
`resources` bucket (extension allowlist, size cap, `read: users` /
`write: team:admins`) → best-effort registration of a `localhost` web
platform → prints the `FOLIO_CONFIG` block to paste into `script.js`.

**Required API-key scopes** (Console → Integrations → API Keys):

| Scope | Used for |
| --- | --- |
| `databases.read` / `databases.write` | ensure database |
| `collections.read` / `collections.write` | ensure collections |
| `attributes.read` / `attributes.write` | create attributes |
| `indexes.read` / `indexes.write` | create indexes |
| `buckets.read` / `buckets.write` | ensure storage bucket |
| `teams.read` / `teams.write` | ensure teams |
| `projects.write` *(optional)* | auto-register the `localhost` platform |

If your console groups scopes differently, grant the Databases, Storage,
Teams and Projects read/write scopes. Missing scopes are reported per step
with a manual fallback.

> **Tip — one key for everything:** while editing the key, also enable
> `users.read`, `users.write` and `documents.write`. Those are the scopes
> `create_user.py` needs later, so a single key can drive the whole
> deployment (schema + user enrolment) without a second console visit.
> Appwrite reports a missing scope as **HTTP 401** with a
> `missing scopes (["…"])` message — that means the key is valid and only
> its scope list needs editing.

**Useful options** (env equivalents use the `APPWRITE_` prefix, e.g.
`APPWRITE_BUCKET_ID`):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--endpoint` / `--project-id` | from `.env` | override connection settings |
| `--database-id` | `folio` | database identifier |
| `--bucket-id` | `resources` | storage bucket identifier |
| `--max-file-size-mb` | `25` | bucket size cap (match your Appwrite plan; mirror it in `FOLIO_ADVANCED.maxFileSizeMB`) |
| `--*-collection-id` | `profiles` / `subjects` / `documents` / `document_versions` / `starred` | override any collection ID |
| `--skip-platform` | — | do not touch platform registration |

Nothing is ever deleted or overwritten: if an existing collection or bucket
differs from the expected definition, the script prints a warning with the
exact fix and moves on.

## Prerequisites

- Python **3.9+** (standard library only; third-party packages are optional).
- An Appwrite Cloud project (see https://appwrite.io/docs) with the
  `profiles` collection created (default IDs: database `folio`, collection
  `profiles`).
- Optional: the official SDK — `pip install "appwrite>=6.0.0"`. Without it
  the script automatically uses a built-in pure-standard-library REST
  transport, so it runs with zero dependencies either way.

## 1. Create the API key

In the Appwrite Console → your project → **Integrations → API Keys**, create
a key with **exactly these scopes** (nothing more):

| Scope | Used for |
| --- | --- |
| `users.read` | duplicate-email lookup |
| `users.write` | creating auth accounts |
| `teams.read` | team operations (read) |
| `teams.write` | ensuring teams and memberships |
| `databases.read` | reading existing profile documents |
| `documents.write` | creating/updating profile documents |

Store the key in a local `.env` file — never commit it:

```bash
cp .env.example .env
chmod 600 .env      # then fill in the real values in an editor
```

The script reads `.env` from its **working directory first**, then from the
`backend/` directory. Variables already exported in your shell win over
`.env` values.

## 2. Configuration reference

| Variable | Required | Default | Example |
| --- | --- | --- | --- |
| `APPWRITE_ENDPOINT` | yes | — | `https://sgp.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | yes | — | `my-folio-project` |
| `APPWRITE_API_KEY` | yes | — | secret server key (see step 1) |
| `APPWRITE_DATABASE_ID` | no | `folio` | |
| `APPWRITE_PROFILES_COLLECTION_ID` | no | `profiles` | |
| `APPWRITE_ADMIN_TEAM_ID` | no | `admins` | |
| `APPWRITE_VIEWER_TEAM_ID` | no | `viewers` | |

CLI flags `--endpoint`, `--project-id` and `--database-id` override the
corresponding environment values. **The API key is deliberately not accepted
as a CLI flag** — command-line arguments leak into shell history and process
listings. If the key is missing, the script prints exactly this explanation
and exits with code 1.

## 3. Usage

Fully interactive (prompts for everything; password typed hidden, twice):

```bash
python3 backend/create_user.py
```

Non-interactive with a generated temporary password:

```bash
python3 backend/create_user.py \
  --name "Ada Lovelace" \
  --username ada.lovelace \
  --email ada@example.edu \
  --role viewer \
  --generate-password
```

`--generate-password` creates a ≥16-character random password (`secrets`),
stores it in `generated-password-<email>.txt` with permissions `0600`, and
prints only that file path. Share the password privately, then **delete the
file**. Unless `--skip-password-change-hint` is given, the summary recommends
that the user change this temporary password at first sign-in
(Settings → Change Password).

Granting administrator rights always requires a typed confirmation (also when
`--role admin` is passed as a flag):

```bash
python3 backend/create_user.py --name "Root" --username root \
  --email root@example.edu --role admin
# ...
# Type I UNDERSTAND to grant administrator privileges:
```

For automation (CI, batch enrolment) add `--yes` to skip the typed
confirmation.

Full flag list: `--endpoint`, `--project-id`, `--database-id`, `--name`,
`--username`, `--email`, `--role {viewer,admin}`, `--generate-password`,
`--skip-password-change-hint`, `--yes`.

## 4. What a run does, step by step

1. **Ensure teams** — creates `admins` ("Folio Administrators") and `viewers`
   ("Folio Viewers") if missing; a 409 "already exists" is tolerated.
2. **Ensure account** — looks the email up first (`users.list` with an
   `equal("email", ...)` query, falling back to a paged scan of 100 users at
   a time, capped at 1000). If the account exists it is reused and clearly
   reported; its password is unknown to the script (reset it in the console
   or use a different email). New accounts get a user ID derived from the
   username (lowercased, safe characters, ≤36 chars); on an ID collision a
   short random suffix is added (up to 3 attempts).
3. **Ensure profile document** — `$id` = Account ID, attributes `email`,
   `displayName`, `username`, `role`; readable by that user
   (`read("user:…")`) and by the admins team (`read("team:admins")`). If the
   document already exists, only `role`/`displayName` are updated when they
   differ.
4. **Ensure membership** — exactly one team, based on the role.

Each step prints its outcome. If a step fails, the error report lists
precisely which step failed, what already succeeded (account ID, profile
document, membership) and the recovery path: fix the cause and **re-run the
same command** (idempotent), or complete the missing step in the Appwrite
console.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `py -3` → "Unable to create process ... The system cannot find the file specified" | the Windows `py` launcher has a stale registration pointing at a python.exe that no longer exists (partial uninstall / moved runtime) | run `py -0p` to list what is actually installed; either reinstall Python from python.org (tick **Add python.exe to PATH**, reopen the terminal) or call a working interpreter directly, e.g. `py -3.13 setup_database.py` or `"C:\Users\you\AppData\Local\Programs\Python\Python313\python.exe" setup_database.py` — any Python 3.9+ works |
| `HTTP 401` — API key rejected (invalid/expired) | the key is missing, malformed or was deleted | re-create the key and update `.env` |
| `HTTP 401` with `missing scopes (["teams.read"])` (or similar) | the key itself is **valid** — its scope list is incomplete | Console → Integrations → API Keys → open the key and enable the missing scopes (see the scope table above); updating the existing key keeps its secret, so `.env` stays unchanged — then just re-run |
| `HTTP 403` — "The maximum number of … allowed for the selected plan has reached. Upgrade …" | **plan limit, not a key problem** (e.g. the free tier allows only ONE database and one already exists) | Folio needs just one database/bucket, so no upgrade is required: either delete the unused leftover in the console, or reuse the existing one — set `APPWRITE_DATABASE_ID` / `APPWRITE_BUCKET_ID` to its ID in `.env` and re-run |
| `HTTP 403` — scope missing | key lacks one of the required scopes | edit the key's scopes as above, or re-create it with all scopes from step 1 |
| `409` / `user_email_already_exists` | the email is already registered | the script reuses the account; reset its password in the console or use another email |
| `409` / `user_already_exists` on the ID | username-derived ID already taken | automatic random-suffix retry (3 attempts) |
| network error / timeout | wrong endpoint URL or no connectivity | check `APPWRITE_ENDPOINT` (full URL incl. `/v1`) and your connection |
| SDK "calling convention" error | unusual SDK version installed | `pip install "appwrite>=6.0.0"`, or uninstall it to use the REST fallback |

Exit codes: `0` success · `1` configuration error · `2` validation error ·
`3` backend/API error · `130` interrupted (Ctrl-C).

**Reminder:** the Folio frontend itself must never contain or receive the API
key — provisioning happens exclusively through this local script.

## Security notes

- Keep `.env` at permissions `600` and out of version control; never copy
  real values into `.env.example` or any frontend file.
- Delete `generated-password-*.txt` files immediately after securely sharing
  the password; the script never prints a password itself.
- Rotate the API key if exposure is suspected: Console → API Keys → delete
  the key, create a new one with the same scopes, update `.env`.
- The key grants user administration on the whole project — treat it like a
  root credential for Folio's identity store. Appwrite's console records API
  activity, which helps with audits.
- The script masks the key in all of its output (`****last4`) and scrubs it
  from upstream error messages.
