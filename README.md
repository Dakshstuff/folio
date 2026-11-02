# Folio — the animated academic resource library

Folio is a private academic resource portal. An administrator uploads and organises
educational resources; authorised viewers sign in, discover documents by subject,
search the whole library, preview supported files, star favourites and download.

The entire frontend is **three files** — `index.html`, `style.css`, `script.js` —
plus one vendored library (`appwrite.sdk.js`, the official Appwrite Web SDK IIFE
build, unmodified) so the app works even when CDNs are blocked. No framework,
no bundler, no build step. The backend is **Appwrite Cloud**
(authentication, database, storage, server-enforced permissions).

---

## 1. What's in this package

```
Folio/
├── index.html         ← the application (semantic HTML5 + original SVG artwork)
├── style.css          ← retro-pop editorial design system + animation system
├── script.js          ← all logic: Appwrite integration, views, uploads, search
├── appwrite.sdk.js    ← vendored Appwrite Web SDK v11.0.0 (IIFE build, unmodified)
├── README.md          ← this file
├── .env.example       ← documentation-only template for the backend script
└── backend/
    ├── create_user.py        ← private admin utility: provisions accounts
    ├── setup_database.py     ← one-command schema provisioning (see below)
    └── README.md             ← operator guide for the scripts
```

Launch `index.html` over **HTTP** (see §7) — not via a `file://` URL, which the
browser security model and the Appwrite SDK do not support.

**Frontend SDK:** Appwrite Web SDK **v11.0.0**, vendored as `appwrite.sdk.js`
(the official IIFE build — `dist/iife/sdk.min.js` — kept unmodified next to
`index.html`). `index.html` loads the local file; if it is ever deleted,
`script.js` falls back to the official CDN copies (jsDelivr → unpkg).
**Note:** the IIFE build lives at `/dist/iife/sdk.min.js` — an older URL,
`/dist/iife/appwrite.js`, does **not** exist in the package and 404s.
It exposes the global `window.Appwrite`. APIs used, all verified
against SDK 11.x: `Client`, `Account` (`createEmailPasswordSession` with a legacy
`createEmailSession` fallback, `get`, `updatePassword`, `deleteSessions`,
`listMemberships`), `Databases` (list/get/create/update/delete + `Query`), `Storage`
(`createFile` with chunked-upload `onProgress` callbacks, `getFileDownload`,
`getFileView`), `ID`, `Permission`, `Role`, `AppwriteException`.

---

## 2. Prerequisites

- An **Appwrite Cloud** account (free tier is enough to start) — https://appwrite.io
- Any modern browser.
- Python 3.9+ **only for the administrator's provisioning script** (§6).
- A static file server for local use, or any static host for deployment (§8).

---

## 3. Create the Appwrite project

1. In the Appwrite Console, **Create project** → name it (e.g. `Folio`).
2. Open the project → **Overview** → note the **Project ID** and the **API
   Endpoint** (e.g. `https://sgp.cloud.appwrite.io/v1`).
3. **Platforms → Add platform → Web app** → set the host to where Folio runs
   (for local use: `localhost`). This is required for browser (CORS) access.
   Add another platform later for your deployed domain.

### Authentication settings

- **Auth → Email/password**: enable it.
- Leave every social/OAuth provider disabled.
- There is deliberately **no public sign-up**: the frontend never calls
  account-creation APIs, and accounts exist only if you create them with the
  provisioning script or the console.

### Teams (server-enforced roles)

Roles in Folio are enforced by Appwrite **team membership**, never by a value in
the browser:

| Team ID   | Display name           | Grants                                    |
|-----------|------------------------|-------------------------------------------|
| `admins`  | Folio Administrators   | Write on collections + storage bucket      |
| `viewers` | Folio Viewers          | Read only                                  |

Create both teams under **Auth → Teams** (or let `create_user.py` create them
automatically — it tolerates existing teams). The team IDs must match
`FOLIO_ADVANCED.adminTeamId` / `viewerTeamId` in `script.js` (defaults above).

### ⚡ Fast path — one command instead of §4 + §5

You can skip the manual console work in **§4 (database)** and **§5 (storage
bucket)** entirely:

```bash
cd backend
python3 setup_database.py
```

It creates the teams, the database, all five collections, every attribute and
index, and the storage bucket — then prints a ready-to-paste `FOLIO_CONFIG`
for `script.js`. It is idempotent: re-run it any time; it never deletes or
overwrites. See `backend/README.md` for the required API-key scopes and all
options. (Spreadsheet checklists of the exact schema it creates live in
`backend/schema-*.csv` if you prefer to build it by hand — the sections below
document the same thing.)

---

## 4. Create the database

**Databases → Add database** → ID `folio` (or your own; you'll configure it).

Inside it, create **five collections**. Attribute types are case-sensitive;
`$createdAt` / `$updatedAt` are built-in and need no attributes.

### 4.1 `profiles`

| Attribute     | Type    | Size | Required | Notes                    |
|---------------|---------|------|----------|--------------------------|
| `email`       | string  | 256  | yes      |                          |
| `displayName` | string  | 128  | no       |                          |
| `username`    | string  | 64   | no       |                          |
| `role`        | string  | 32   | no       | `admin` or `viewer`; display only |

Indexes: none required.
**Permissions**: collection-level **read: none, write: none**. Enable
**document security**, and give every profile document these document-level
permissions (the provisioning script sets them automatically):
`read: user:<userId>` + `read: team:admins`.

### 4.2 `subjects`

| Attribute     | Type    | Size  | Required | Default |
|---------------|---------|-------|----------|---------|
| `name`        | string  | 128   | yes      |         |
| `description` | string  | 1024  | no       | `""`    |
| `archived`    | boolean | —     | yes      | `false` |

Indexes: **key** on `name` (used for A–Z ordering); optionally a **unique** index
on `name` to prevent duplicates.
**Permissions**: read `Role.users()` · write `team:admins`.

### 4.3 `documents`

| Attribute       | Type     | Size  | Required | Notes                              |
|-----------------|----------|-------|----------|------------------------------------|
| `title`         | string   | 256   | yes      |                                    |
| `description`   | string   | 2048  | no       | default `""`                       |
| `subjectId`     | string   | 64    | yes      | references a `subjects` document   |
| `subjectName`   | string   | 128   | no       | denormalised for list display      |
| `fileId`        | string   | 64    | yes      | current storage file ID            |
| `fileName`      | string   | 256   | yes      | original file name                 |
| `mimeType`      | string   | 128   | yes      |                                    |
| `category`      | string   | 32    | yes      | pdf/document/presentation/…        |
| `fileSize`      | integer  | —     | yes      | bytes                              |
| `tags`          | string[] | 64    | no       | up to 10 items                     |
| `uploadedBy`    | string   | 64    | yes      | admin user ID                      |
| `uploadedByName`| string   | 128   | no       | display convenience                |
| `version`       | integer  | —     | yes      | current version number             |
| `searchText`    | string   | 2048  | no       | lowercase index blob               |

Indexes (create all of these — search and sorting rely on them):
- **fulltext** on `searchText` → powers `Query.search`
- **key** on `subjectId`, `category`, `title`, `fileSize`

**Permissions**: read `Role.users()` · write `team:admins`.

File contents are never stored in these records — only metadata + the storage
file ID.

### 4.4 `document_versions`

| Attribute       | Type    | Size | Required |
|-----------------|---------|------|----------|
| `documentId`    | string  | 64   | yes      |
| `fileId`        | string  | 64   | yes      |
| `fileName`      | string  | 256  | yes      |
| `mimeType`      | string  | 128  | yes      |
| `fileSize`      | integer | —    | yes      |
| `versionNumber` | integer | —    | yes      |
| `changeNote`    | string  | 512  | no       |
| `createdBy`     | string  | 64   | no       |

Indexes: **key** on `documentId`.
**Permissions**: read `Role.users()` · write `team:admins`.

### 4.5 `starred`

| Attribute    | Type    | Size | Required |
|--------------|---------|------|----------|
| `userId`     | string  | 64   | yes      |
| `documentId` | string  | 64   | yes      |

Indexes: **unique** composite index on (`userId`, `documentId`) — prevents
double-star records; **key** on `userId`.
**Permissions**: collection read `Role.users()` · write `Role.users()`, and
enable **document security**. The frontend creates each star document with
owner-only permissions (`read/update/delete: user:<userId>`), so every member
sees and can modify **only their own** stars — enforced server-side.

---

## 5. Create the storage bucket

**Storage → Add bucket**:

- **Bucket ID**: `resources` (or your own — configure it in §6).
- **File security**: **disabled** — the bucket-level permissions apply to every
  file, which keeps uploads simple and safe.
- **Maximum file size**: match your plan (25 MB on Appwrite Cloud free tier;
  raise it if your plan allows, and mirror it in `FOLIO_ADVANCED.maxFileSizeMB`).
- **Allowed file extensions** (this is the server-side validation — the browser
  allowlist in `script.js` mirrors it):
  `pdf, docx, doc, pptx, ppt, xlsx, xls, txt, csv, png, jpg, jpeg, webp, mp4, zip`
- **Permissions**: read `Role.users()` · write `team:admins`.

With this configuration a viewer literally **cannot** upload, replace or delete
a file even by calling the API directly — Appwrite rejects the request.

---

## 6. Configure the frontend

Open `script.js` and edit the configuration section at the top:

```js
const FOLIO_CONFIG = {
  endpoint: "https://sgp.cloud.appwrite.io/v1", // your API endpoint
  projectId: "your-project-id",
  databaseId: "folio",
  documentsCollectionId: "documents",
  subjectsCollectionId: "subjects",
  storageBucketId: "resources"
};
```

Check `FOLIO_ADVANCED` just below it — the defaults match this README
(`profiles`, `document_versions`, `starred`, `admins`, `viewers`, 25 MB limit).

If any required value is still a placeholder, Folio shows a guided configuration
screen instead of a broken app — it never silently fakes a backend.

---

## 7. Provision accounts (administrator only)

A browser cannot securely hold an Appwrite API key, so accounts are created by a
**private script on your machine**. Full instructions: `backend/README.md`.

```bash
cd backend
pip install "appwrite>=6.0.0"     # optional — there is a stdlib REST fallback
cp ../.env.example .env           # then edit .env with endpoint/project/key
python create_user.py             # interactive
```

Create the API key in the console first (**Integrations → API keys**) with the
scopes: `users.read`, `users.write`, `teams.read`, `teams.write`,
`databases.read`, `documents.write`. The script:

1. Ensures the `admins` / `viewers` teams exist.
2. Creates the auth account (email + password).
3. Creates the `profiles` record (document ID = user ID) with correct
   document-level permissions.
4. Adds the user to exactly one role team (**viewer** by default; `--role admin`
   requires typing "I UNDERSTAND").
5. Is idempotent — simply re-running it after a partial failure completes the
   missing steps safely.

Create your administrator first, then viewers. Passwords are entered via
`getpass` (never echoed) or generated to a `0600` file. New users change their
password in **Settings → Change password** after first sign-in.

---

## 8. Launch locally

```bash
# from the extracted Folio folder
python3 -m http.server 8080
# or: npx serve .
```

Open `http://localhost:8080`, sign in with a provisioned account.
(If you used another port, add that host:port as a Web platform in the console.)

## 9. Deploy

The folder is a static site — deploy it anywhere:

- **Netlify / Vercel / Cloudflare Pages**: drag-and-drop or connect the repo;
  no build command, publish directory is the folder root.
- **GitHub Pages**: push the files; hash-based routing means no rewrite rules.
- **Any web server / Nginx / Apache**: serve the folder as static files.

After deploying, add the deployed **domain** as a Web platform in the Appwrite
console, then run the provisioning script from your machine to create accounts.

---

## 10. Security model — and honest limitations

**Enforced by Appwrite (server-side, cannot be bypassed from the browser):**
- Only `admins`-team members hold write permission on the five collections and
  the storage bucket — viewers cannot upload, replace, edit or delete resources
  even by calling the API directly.
- Starred documents carry owner-only document-level permissions.
- Profiles are readable only by their owner and the admins team.
- Administrator UI is gated by `Account.listMemberships("admins")` — a
  **server-verified** team membership check. A viewer supplying the admin's
  email address gains nothing.
- File uploads are validated server-side by the bucket's extension allowlist
  and size limit, and client-side by the same allowlist.
- No API key or secret exists anywhere in the frontend.

**Known limitations (documented, by design):**
- Appwrite Cloud's free tier caps upload size (25 MB) — adjust the bucket and
  `maxFileSizeMB` together if your plan differs.
- `Query.search` is full-text natural-language matching (it ignores stopwords
  and does not do prefix matching).
- Renaming a subject rewrites the denormalised subject labels on documents
  asynchronously; a failure there is non-fatal and labels heal on next edit.
- Preview support is intentionally limited to PDF, images, plain text and MP4 —
  other formats show a download action. Previews run in a sandboxed frame and
  uploaded files are never executed by the application.
- Download/preview fetch the file with the session cookie; if your host is not
  registered as a platform, Appwrite blocks the CORS request — add the platform.
- The optional **design preview** (shown only when configuration is missing)
  runs on simulated in-memory data with uploads disabled, is permanently
  banner-labelled, and is never reachable once a real configuration is present.

---

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Configuration screen keeps appearing | One of the six `FOLIO_CONFIG` values is still a placeholder. |
| “Cannot reach the backend” | Wrong endpoint, server offline, or the host isn't added as a **Web platform** in the console. |
| Sign-in fails with correct credentials | Account not provisioned, or email/password auth disabled. |
| Uploads rejected instantly | Extension not on the bucket allowlist, or file larger than the bucket limit. |
| Search or sorting errors | Missing fulltext/key indexes on `documents` (see §4.3). |
| Viewers see admin sections briefly | They don't — admin nav renders only after the server-verified team check succeeds. |
| Session expired messages | Sessions expire per your console settings; users simply sign in again. |

---

Folio's visual identity is original artwork: glossy cherries on a cream-and-teal
checkerboard, Fraunces display type, and a motion system that respects
`prefers-reduced-motion`. Replace the logo by editing the `#logo-mark` symbol in
`index.html` (it is clearly marked).
