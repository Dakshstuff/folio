#!/usr/bin/env python3
"""Folio — one-command database provisioning for Appwrite Cloud.

This script builds the ENTIRE Folio backend schema so you never have to click
through the Appwrite console:

  1. the two Folio teams (``admins`` / ``viewers``),
  2. the ``folio`` database,
  3. all five collections with their permissions
     (``profiles``, ``subjects``, ``documents``, ``document_versions``,
     ``starred``),
  4. every attribute, waiting until Appwrite reports it ``available``,
  5. every index (full-text search, key, unique),
  6. the ``resources`` storage bucket with the file-extension allowlist,
  7. a best-effort ``localhost`` web platform so the browser is allowed to
     talk to your project (skipped gracefully if the API key lacks scope).

After a successful run it prints a ready-to-paste ``FOLIO_CONFIG`` block for
``script.js``.

+==========================================================================+
|                           SECURITY WARNING                               |
|                                                                          |
|  APPWRITE_API_KEY is a fully privileged server secret. It must never     |
|  leave the administrator's machine: never commit it to git, never embed  |
|  it in the Folio frontend, never paste it into chat or e-mail, and never |
|  pass it as a command-line argument (this script deliberately refuses a  |
|  CLI flag for it, because shell history and process listings record      |
|  arguments). Provide it only via the environment or a local .env file.   |
+==========================================================================+

The script is **idempotent and non-destructive**: every step uses "ensure"
semantics. Re-running it after a partial failure detects what already exists
and continues; it never deletes or overwrites data. If an existing collection
or bucket drifts from the expected definition, the script prints a clear
warning and leaves it untouched.

Python 3.9+, standard library only — no third-party packages required.

Usage:
    python3 setup_database.py               # fully automatic
    python3 setup_database.py --help        # all options

Required API-key scopes (Console → Integrations → API Keys):
    databases.read    databases.write
    collections.read  collections.write
    attributes.read   attributes.write
    indexes.read      indexes.write
    buckets.read      buckets.write
    teams.read        teams.write
    projects.write    (optional — only for the automatic localhost platform)

Recommended on the SAME key (needed later by ``create_user.py`` — grant them
now and you will never have to edit the key again):
    users.read        users.write
    documents.write

If your console groups scopes differently, grant the Databases, Storage,
Teams, Users and Projects read/write scopes. Note that Appwrite reports a
missing scope as HTTP 401 with a "missing scopes (...)" message — that means
the key itself is valid and only its scope list needs editing.

Exit codes: 0 success · 1 configuration error · 2 validation error ·
3 backend/API error · 130 interrupted (Ctrl-C).
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_DATABASE_ID = "folio"
DEFAULT_BUCKET_ID = "resources"
DEFAULT_ADMIN_TEAM_ID = "admins"
DEFAULT_VIEWER_TEAM_ID = "viewers"

ADMIN_TEAM_DISPLAY_NAME = "Folio Administrators"
VIEWER_TEAM_DISPLAY_NAME = "Folio Viewers"
BUCKET_DISPLAY_NAME = "Folio Resources"

DEFAULT_COLLECTION_IDS: Dict[str, str] = {
    "profiles": "profiles",
    "subjects": "subjects",
    "documents": "documents",
    "document_versions": "document_versions",
    "starred": "starred",
}

ALLOWED_EXTENSIONS = [
    "pdf", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "txt", "csv",
    "png", "jpg", "jpeg", "webp", "mp4", "zip",
]
DEFAULT_MAX_FILE_SIZE_MB = 25  # Appwrite Cloud free tier; raise if your plan allows

POLL_INTERVAL_SECONDS = 2.0
ATTRIBUTE_TIMEOUT_SECONDS = 150.0
INDEX_TIMEOUT_SECONDS = 120.0
HTTP_TIMEOUT_SECONDS = 30

ID_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$")

EXIT_OK = 0
EXIT_CONFIG = 1
EXIT_VALIDATION = 2
EXIT_BACKEND = 3
EXIT_INTERRUPTED = 130

READ_USERS = 'read("users")'
WRITE_USERS = 'write("users")'
WRITE_ADMINS = 'write("team:admins")'

# ---------------------------------------------------------------------------
# Schema definition — the single source of truth for this script.
# Mirrors README.md §4-§5 and backend/schema-*.csv exactly.
# ---------------------------------------------------------------------------


class Attr:
    """One collection attribute (string, boolean or integer)."""

    def __init__(
        self,
        key: str,
        kind: str,
        size: Optional[int] = None,
        required: bool = False,
        default: Any = None,
        array: bool = False,
    ) -> None:
        self.key = key
        self.kind = kind          # "string" | "boolean" | "integer"
        self.size = size
        self.required = required
        self.default = default    # only applied when required is False
        self.array = array

    def payload(self) -> Dict[str, Any]:
        p: Dict[str, Any] = {"key": self.key, "required": self.required}
        if self.kind == "string":
            p["size"] = self.size
            p["array"] = self.array
            # Appwrite only honours defaults on non-required attributes.
            if not self.required and self.default is not None:
                p["default"] = self.default
        elif self.kind == "boolean":
            if not self.required and self.default is not None:
                p["default"] = self.default
        elif self.kind == "integer":
            if not self.required and self.default is not None:
                p["default"] = self.default
        return p

    def describe(self) -> str:
        kind = "string[]" if self.array else self.kind
        size = f"({self.size})" if self.size is not None else ""
        req = "required" if self.required else "optional"
        return f"{self.key} {kind}{size} {req}"


class Index:
    """One collection index (key, fulltext or unique)."""

    def __init__(
        self,
        key: str,
        type_: str,
        attributes: Sequence[str],
        orders: Optional[Sequence[str]] = None,
    ) -> None:
        self.key = key
        self.type = type_
        self.attributes = list(attributes)
        self.orders = list(orders or [])

    def payload(self) -> Dict[str, Any]:
        p: Dict[str, Any] = {
            "key": self.key,
            "type": self.type,
            "attributes": self.attributes,
        }
        if self.orders:
            p["orders"] = self.orders
        return p

    def describe(self) -> str:
        attrs = ", ".join(self.attributes)
        return f"{self.key} ({self.type}: {attrs})"


COLLECTION_SPECS: List[Dict[str, Any]] = [
    {
        "logical": "profiles",
        "name": "Profiles",
        "permissions": [],
        "documentSecurity": True,
        "attributes": [
            Attr("email", "string", 256, required=True),
            Attr("displayName", "string", 128),
            Attr("username", "string", 64),
            Attr("role", "string", 32),
        ],
        "indexes": [],
        "note": "Collection-level permissions are intentionally empty: each profile document carries its own permissions and is created only by backend/create_user.py.",
    },
    {
        "logical": "subjects",
        "name": "Subjects",
        "permissions": [READ_USERS, WRITE_ADMINS],
        "documentSecurity": False,
        "attributes": [
            Attr("name", "string", 128, required=True),
            Attr("description", "string", 1024, default=""),
            Attr("archived", "boolean", required=True),
        ],
        "indexes": [
            Index("idx_name", "key", ["name"]),
        ],
        "note": "",
    },
    {
        "logical": "documents",
        "name": "Documents",
        "permissions": [READ_USERS, WRITE_ADMINS],
        "documentSecurity": False,
        "attributes": [
            Attr("title", "string", 256, required=True),
            Attr("description", "string", 2048, default=""),
            Attr("subjectId", "string", 64, required=True),
            Attr("subjectName", "string", 128),
            Attr("fileId", "string", 64, required=True),
            Attr("fileName", "string", 256, required=True),
            Attr("mimeType", "string", 128, required=True),
            Attr("category", "string", 32, required=True),
            Attr("fileSize", "integer", required=True),
            Attr("tags", "string", 64, array=True),
            Attr("uploadedBy", "string", 64, required=True),
            Attr("uploadedByName", "string", 128),
            Attr("version", "integer", required=True),
            Attr("searchText", "string", 2048),
        ],
        "indexes": [
            Index("ft_searchText", "fulltext", ["searchText"]),
            Index("idx_subjectId", "key", ["subjectId"]),
            Index("idx_category", "key", ["category"]),
            Index("idx_title", "key", ["title"]),
            Index("idx_fileSize", "key", ["fileSize"]),
        ],
        "note": "ft_searchText powers in-app search (Query.search) — it is REQUIRED.",
    },
    {
        "logical": "document_versions",
        "name": "Document Versions",
        "permissions": [READ_USERS, WRITE_ADMINS],
        "documentSecurity": False,
        "attributes": [
            Attr("documentId", "string", 64, required=True),
            Attr("fileId", "string", 64, required=True),
            Attr("fileName", "string", 256, required=True),
            Attr("mimeType", "string", 128, required=True),
            Attr("fileSize", "integer", required=True),
            Attr("versionNumber", "integer", required=True),
            Attr("changeNote", "string", 512),
            Attr("createdBy", "string", 64),
        ],
        "indexes": [
            Index("idx_documentId", "key", ["documentId"]),
            Index("idx_doc_version", "key", ["documentId", "versionNumber"], ["ASC", "DESC"]),
        ],
        "note": "",
    },
    {
        "logical": "starred",
        "name": "Starred Documents",
        "permissions": [READ_USERS, WRITE_USERS],
        "documentSecurity": True,
        "attributes": [
            Attr("userId", "string", 64, required=True),
            Attr("documentId", "string", 64, required=True),
        ],
        "indexes": [
            Index("idx_userId", "key", ["userId"]),
            Index("idx_user_document", "unique", ["userId", "documentId"]),
        ],
        "note": "Document security is ON: the frontend gives every star row owner-only permissions, so members can only see their own stars.",
    },
]


# ---------------------------------------------------------------------------
# Exceptions (each maps to a specific exit code)
# ---------------------------------------------------------------------------


class ConfigError(Exception):
    """Missing or invalid configuration (exit code 1)."""


class ValidationError(Exception):
    """Invalid user-supplied data (exit code 2)."""


class BackendError(Exception):
    """Appwrite API error or connectivity problem (exit code 3)."""

    def __init__(self, message: str, code: Optional[int] = None, err_type: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.err_type = err_type


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def mask_secret(secret: str) -> str:
    if not secret:
        return "(empty)"
    if len(secret) <= 8:
        return "****" + secret[-2:]
    return "****" + secret[-4:]


def scrub_secret(text: str, secret: Optional[str]) -> str:
    if secret and secret in text:
        return text.replace(secret, "****")
    return text


def parse_dotenv_text(text: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def load_env_files(candidates: Sequence[Path]) -> List[str]:
    """Load .env files (shell environment always wins). Returns loaded paths."""
    loaded: List[str] = []
    for candidate in candidates:
        try:
            if candidate.is_file():
                for key, value in parse_dotenv_text(candidate.read_text(encoding="utf-8")).items():
                    os.environ.setdefault(key, value)
                loaded.append(str(candidate))
        except OSError:
            continue
    return loaded


# ---------------------------------------------------------------------------
# REST transport (pure standard library)
# ---------------------------------------------------------------------------


class RestBackend:
    def __init__(self, endpoint: str, project_id: str, api_key: str) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.project_id = project_id
        self.api_key = api_key

    def request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = self.endpoint + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "Content-Type": "application/json",
            "X-Appwrite-Project": self.project_id,
            "X-Appwrite-Key": self.api_key,
            "User-Agent": "Folio-Setup/1.0",
        }
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            raw = ""
            try:
                raw = exc.read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001 — best-effort body read
                pass
            message, err_type = raw.strip() or exc.reason, ""
            try:
                parsed = json.loads(raw)
                message = str(parsed.get("message") or message)
                err_type = str(parsed.get("type") or "")
            except (ValueError, TypeError):
                pass
            message = scrub_secret(str(message), self.api_key)
            raise BackendError(f"HTTP {exc.code} — {message}", code=exc.code, err_type=err_type) from exc
        except http.client.HTTPException as exc:
            raise BackendError(
                f"Connection to Appwrite was interrupted ({exc.__class__.__name__}). "
                "Nothing was deleted — re-run this command to resume."
            ) from exc
        except urllib.error.URLError as exc:
            raise BackendError(
                f"Cannot reach Appwrite at {url} — {getattr(exc, 'reason', exc)}. "
                "Check APPWRITE_ENDPOINT (full URL including /v1) and your connection."
            ) from exc

    def get(self, path: str) -> Dict[str, Any]:
        return self.request("GET", path)

    def post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("POST", path, body)


# ---------------------------------------------------------------------------
# Ensure helpers (idempotent)
# ---------------------------------------------------------------------------


def ensure_team(backend: RestBackend, team_id: str, name: str, report: List[str]) -> str:
    try:
        backend.get(f"/teams/{team_id}")
        report.append(f"team {team_id} already exists")
        return "skipped"
    except BackendError as exc:
        if exc.code != 404:
            raise
    try:
        backend.post("/teams", {"teamId": team_id, "name": name})
        report.append(f"team {team_id} created")
        return "created"
    except BackendError as exc:
        if exc.code == 409:  # created concurrently — fine
            report.append(f"team {team_id} already exists")
            return "skipped"
        raise


def ensure_database(backend: RestBackend, database_id: str, report: List[str]) -> str:
    try:
        backend.get(f"/databases/{database_id}")
        report.append(f"database {database_id} already exists")
        return "skipped"
    except BackendError as exc:
        if exc.code != 404:
            raise
    try:
        backend.post("/databases", {"databaseId": database_id, "name": "Folio"})
        report.append(f"database {database_id} created")
        return "created"
    except BackendError as exc:
        if exc.code == 409:
            report.append(f"database {database_id} already exists")
            return "skipped"
        raise


def ensure_collection(backend: RestBackend, database_id: str, spec: Dict[str, Any], collection_id: str) -> Tuple[str, List[str]]:
    warnings: List[str] = []
    try:
        existing = backend.get(f"/databases/{database_id}/collections/{collection_id}")
    except BackendError as exc:
        if exc.code != 404:
            raise
        existing = None

    if existing is None:
        try:
            backend.post(
                f"/databases/{database_id}/collections",
                {
                    "collectionId": collection_id,
                    "name": spec["name"],
                    "permissions": spec["permissions"],
                    "documentSecurity": spec["documentSecurity"],
                },
            )
            return "created", warnings
        except BackendError as exc:
            if exc.code != 409:
                raise
            existing = backend.get(f"/databases/{database_id}/collections/{collection_id}")

    # Verify drift on an existing collection — never modify, only warn.
    expected_perms = sorted(spec["permissions"])
    actual_perms = sorted(existing.get("permissions") or [])
    if expected_perms != actual_perms:
        warnings.append(
            f"collection {collection_id}: permissions differ from the expected "
            f"{expected_perms or '[]'} — found {actual_perms}. Fix in Console → Collections → Permissions."
        )
    if bool(existing.get("documentSecurity")) != bool(spec["documentSecurity"]):
        warnings.append(
            f"collection {collection_id}: document security is "
            f"{'ON' if existing.get('documentSecurity') else 'OFF'} but should be "
            f"{'ON' if spec['documentSecurity'] else 'OFF'}. Fix in Console → Collections → Settings."
        )
    return "skipped", warnings


def ensure_attribute(backend: RestBackend, database_id: str, collection_id: str, attr: Attr, existing: Dict[str, Any]) -> str:
    current = existing.get(attr.key)
    if current is not None:
        current_type = "string[]" if current.get("array") else current.get("type")
        if current_type != attr.kind:
            print(
                f"    ! attribute {attr.key} exists as {current_type}, expected {attr.kind} — "
                "left untouched (attributes cannot be re-typed; migrate manually if needed).",
                flush=True,
            )
            return "skipped"
        if attr.kind == "string" and not attr.array and current.get("size") not in (None, attr.size):
            print(
                f"    ! attribute {attr.key} has size {current.get('size')}, expected {attr.size} — "
                "left untouched. If in-app writes fail with 400 'string length', resize it in the console.",
                flush=True,
            )
            return "skipped"
        return "skipped"

    endpoint_type = {"string": "string", "boolean": "boolean", "integer": "integer"}[attr.kind]
    try:
        backend.post(
            f"/databases/{database_id}/collections/{collection_id}/attributes/{endpoint_type}",
            attr.payload(),
        )
        return "created"
    except BackendError as exc:
        if exc.code == 409:  # attribute already being created in a previous interrupted run
            return "skipped"
        raise


def ensure_index(backend: RestBackend, database_id: str, collection_id: str, index: Index, existing_keys: set) -> str:
    if index.key in existing_keys:
        return "skipped"
    try:
        backend.post(f"/databases/{database_id}/collections/{collection_id}/indexes", index.payload())
        return "created"
    except BackendError as exc:
        if exc.code == 409:
            return "skipped"
        raise


def wait_for_attributes(backend: RestBackend, database_id: str, collection_id: str, keys: Sequence[str]) -> None:
    deadline = time.time() + ATTRIBUTE_TIMEOUT_SECONDS
    while True:
        coll = backend.get(f"/databases/{database_id}/collections/{collection_id}")
        statuses = {a.get("key"): str(a.get("status") or "") for a in coll.get("attributes") or []}
        failed = [k for k in keys if statuses.get(k) in ("failed", "stuck", "invalid")]
        if failed:
            raise BackendError(
                f"attributes {failed} on collection '{collection_id}' failed to build "
                f"(status: {[statuses[k] for k in failed]}). Open the console, delete the failed "
                "attribute(s) and re-run this script."
            )
        pending = [k for k in keys if statuses.get(k) != "available"]
        if not pending:
            return
        if time.time() >= deadline:
            raise BackendError(
                f"timed out waiting for attributes {pending} on '{collection_id}' to become available. "
                "They are usually ready within a minute — re-run this script once the console shows them available."
            )
        time.sleep(POLL_INTERVAL_SECONDS)


def wait_for_indexes(backend: RestBackend, database_id: str, collection_id: str, keys: Sequence[str]) -> None:
    deadline = time.time() + INDEX_TIMEOUT_SECONDS
    while True:
        coll = backend.get(f"/databases/{database_id}/collections/{collection_id}")
        statuses = {i.get("key"): str(i.get("status") or "") for i in coll.get("indexes") or []}
        failed = [k for k in keys if statuses.get(k) in ("failed", "stuck", "invalid")]
        if failed:
            raise BackendError(
                f"indexes {failed} on collection '{collection_id}' failed to build. "
                "Delete the failed index in the console and re-run this script."
            )
        pending = [k for k in keys if statuses.get(k) != "available"]
        if not pending:
            return
        if time.time() >= deadline:
            raise BackendError(
                f"timed out waiting for indexes {pending} on '{collection_id}'. "
                "Re-run this script once the console shows them available."
            )
        time.sleep(POLL_INTERVAL_SECONDS)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class Config:
    def __init__(self, args: argparse.Namespace) -> None:
        self.endpoint = (args.endpoint or os.environ.get("APPWRITE_ENDPOINT") or "").strip()
        self.project_id = (args.project_id or os.environ.get("APPWRITE_PROJECT_ID") or "").strip()
        self.api_key = (os.environ.get("APPWRITE_API_KEY") or "").strip()
        self.database_id = (args.database_id or os.environ.get("APPWRITE_DATABASE_ID") or DEFAULT_DATABASE_ID).strip()
        self.bucket_id = (args.bucket_id or os.environ.get("APPWRITE_BUCKET_ID") or DEFAULT_BUCKET_ID).strip()
        self.admin_team_id = (args.admin_team_id or os.environ.get("APPWRITE_ADMIN_TEAM_ID") or DEFAULT_ADMIN_TEAM_ID).strip()
        self.viewer_team_id = (args.viewer_team_id or os.environ.get("APPWRITE_VIEWER_TEAM_ID") or DEFAULT_VIEWER_TEAM_ID).strip()
        self.max_file_size_mb = args.max_file_size_mb or _int_from_env("APPWRITE_MAX_FILE_SIZE_MB", DEFAULT_MAX_FILE_SIZE_MB)

        self.collection_ids = {
            "profiles": (args.profiles_collection_id or os.environ.get("APPWRITE_PROFILES_COLLECTION_ID") or DEFAULT_COLLECTION_IDS["profiles"]).strip(),
            "subjects": (args.subjects_collection_id or os.environ.get("APPWRITE_SUBJECTS_COLLECTION_ID") or DEFAULT_COLLECTION_IDS["subjects"]).strip(),
            "documents": (args.documents_collection_id or os.environ.get("APPWRITE_DOCUMENTS_COLLECTION_ID") or DEFAULT_COLLECTION_IDS["documents"]).strip(),
            "document_versions": (args.versions_collection_id or os.environ.get("APPWRITE_VERSIONS_COLLECTION_ID") or DEFAULT_COLLECTION_IDS["document_versions"]).strip(),
            "starred": (args.starred_collection_id or os.environ.get("APPWRITE_STARRED_COLLECTION_ID") or DEFAULT_COLLECTION_IDS["starred"]).strip(),
        }
        self.skip_platform = bool(args.skip_platform)

    def masked_summary(self) -> str:
        return (
            f"Endpoint     : {self.endpoint}\n"
            f"Project ID   : {self.project_id}\n"
            f"API key      : {mask_secret(self.api_key)}\n"
            f"Database ID  : {self.database_id}\n"
            f"Bucket ID    : {self.bucket_id} (max {self.max_file_size_mb} MB)\n"
            f"Teams        : {self.admin_team_id} / {self.viewer_team_id}"
        )

    def validate(self) -> List[str]:
        problems: List[str] = []
        if not self.endpoint:
            problems.append("APPWRITE_ENDPOINT is missing (e.g. https://sgp.cloud.appwrite.io/v1).")
        elif not self.endpoint.startswith(("http://", "https://")):
            problems.append("APPWRITE_ENDPOINT must start with http:// or https:// and include /v1.")
        if not self.project_id:
            problems.append("APPWRITE_PROJECT_ID is missing.")
        elif self.project_id.strip().lower() in ("your-project-id", "your_project_id"):
            problems.append(
                'APPWRITE_PROJECT_ID is still the placeholder "your-project-id" from .env.example.\n'
                "  Copy your real Project ID from the Appwrite Console → your project → Overview."
            )
        if not self.api_key:
            problems.append(
                "APPWRITE_API_KEY is missing.\n"
                "  Create an API key in Console → Integrations → API Keys with scopes:\n"
                "    databases.read databases.write collections.read collections.write\n"
                "    attributes.read attributes.write indexes.read indexes.write\n"
                "    buckets.read buckets.write teams.read teams.write projects.write\n"
                "    users.read users.write documents.write  (used later by create_user.py)\n"
                "  Then put it in a local .env file (chmod 600) — never in the frontend."
            )
        elif "replace-me" in self.api_key.lower():
            problems.append(
                "APPWRITE_API_KEY is still the placeholder from .env.example.\n"
                "  Create a real API key in Console → Integrations → API Keys (scopes listed above),\n"
                "  copy the secret once, and paste it into .env."
            )
        for label, value in [("database id", self.database_id), ("bucket id", self.bucket_id)] + [
            (f"collection id ({logical})", value) for logical, value in self.collection_ids.items()
        ] + [("team id", self.admin_team_id), ("team id", self.viewer_team_id)]:
            if not ID_PATTERN.match(value or ""):
                problems.append(f'{label} "{value}" is invalid (max 36 chars; letters, digits, dot, underscore, hyphen).')
        if not (1 <= int(self.max_file_size_mb) <= 10000):
            problems.append(f"max file size {self.max_file_size_mb} MB is out of range (1-10000).")
        return problems


def _int_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValidationError(f"{name} must be an integer, got {raw!r}.") from None


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def step(index: int, total: int, label: str) -> None:
    print(f"\n[{index}/{total}] {label}", flush=True)


def ok(message: str) -> None:
    print(f"  ✓ {message}", flush=True)


def warn(message: str) -> None:
    print(f"  ! {message}", flush=True)


def fail(message: str) -> None:
    print(f"  ✗ {message}", flush=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="setup_database.py",
        description="Create the complete Folio schema on Appwrite Cloud (teams, database, collections, attributes, indexes, storage bucket).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--endpoint", help="Appwrite endpoint, e.g. https://sgp.cloud.appwrite.io/v1 (env: APPWRITE_ENDPOINT)")
    parser.add_argument("--project-id", help="Appwrite project ID (env: APPWRITE_PROJECT_ID)")
    parser.add_argument("--database-id", help=f"Database ID (env: APPWRITE_DATABASE_ID, default {DEFAULT_DATABASE_ID})")
    parser.add_argument("--bucket-id", help=f"Storage bucket ID (env: APPWRITE_BUCKET_ID, default {DEFAULT_BUCKET_ID})")
    parser.add_argument("--max-file-size-mb", type=int, help=f"Bucket maximum file size in MB (env: APPWRITE_MAX_FILE_SIZE_MB, default {DEFAULT_MAX_FILE_SIZE_MB})")
    parser.add_argument("--profiles-collection-id", help="Override profiles collection ID")
    parser.add_argument("--subjects-collection-id", help="Override subjects collection ID")
    parser.add_argument("--documents-collection-id", help="Override documents collection ID")
    parser.add_argument("--versions-collection-id", help="Override document_versions collection ID")
    parser.add_argument("--starred-collection-id", help="Override starred collection ID")
    parser.add_argument("--admin-team-id", help=f"Admin team ID (env: APPWRITE_ADMIN_TEAM_ID, default {DEFAULT_ADMIN_TEAM_ID})")
    parser.add_argument("--viewer-team-id", help=f"Viewer team ID (env: APPWRITE_VIEWER_TEAM_ID, default {DEFAULT_VIEWER_TEAM_ID})")
    parser.add_argument("--skip-platform", action="store_true", help="Do not attempt to register the localhost web platform")
    return parser


def print_config_block(config: Config) -> None:
    c = config.collection_ids
    advanced_lines = []
    if (c["profiles"], c["document_versions"], c["starred"], config.admin_team_id, config.viewer_team_id) != (
        DEFAULT_COLLECTION_IDS["profiles"], DEFAULT_COLLECTION_IDS["document_versions"],
        DEFAULT_COLLECTION_IDS["starred"], DEFAULT_ADMIN_TEAM_ID, DEFAULT_VIEWER_TEAM_ID,
    ):
        advanced_lines = [
            "",
            "const FOLIO_ADVANCED = {",
            f'  profilesCollectionId: "{c["profiles"]}",',
            f'  versionsCollectionId: "{c["document_versions"]}",',
            f'  starredCollectionId: "{c["starred"]}",',
            f'  adminTeamId: "{config.admin_team_id}",',
            f'  viewerTeamId: "{config.viewer_team_id}",',
            f"  maxFileSizeMB: {config.max_file_size_mb} // must match your bucket maximum",
            "};",
        ]
    print(
        "\n"
        + "-" * 76
        + "\nPASTE THIS INTO script.js (replace the FOLIO_CONFIG block near the top):\n"
        + "-" * 76
        + "\n\n"
        "const FOLIO_CONFIG = {\n"
        f'  endpoint: "{config.endpoint}",\n'
        f'  projectId: "{config.project_id}",\n'
        f'  databaseId: "{config.database_id}",\n'
        f'  documentsCollectionId: "{c["documents"]}",\n'
        f'  subjectsCollectionId: "{c["subjects"]}",\n'
        f'  storageBucketId: "{config.bucket_id}"\n'
        "};\n"
        + "\n".join(advanced_lines)
    )


def run(config: Config) -> int:
    backend = RestBackend(config.endpoint, config.project_id, config.api_key)

    # -- 1. Connectivity -----------------------------------------------------
    step(1, 8, "Connectivity")
    try:
        health = backend.get("/health")
        ok(f"Appwrite reachable — status {health.get('status', 'ok')}")
    except BackendError as exc:
        if exc.code == 404:
            warn("health endpoint not found — continuing anyway (endpoint may still be valid).")
        else:
            raise

    # -- 2. Teams ------------------------------------------------------------
    step(2, 8, "Teams (server-enforced roles)")
    ensure_team(backend, config.admin_team_id, ADMIN_TEAM_DISPLAY_NAME, [])
    ok(f"{config.admin_team_id} — {ADMIN_TEAM_DISPLAY_NAME}")
    ensure_team(backend, config.viewer_team_id, VIEWER_TEAM_DISPLAY_NAME, [])
    ok(f"{config.viewer_team_id} — {VIEWER_TEAM_DISPLAY_NAME}")

    # -- 3. Database ----------------------------------------------------------
    step(3, 8, "Database")
    ensure_database(backend, config.database_id, [])
    ok(config.database_id)

    # -- 4. Collections --------------------------------------------------------
    step(4, 8, "Collections")
    warnings: List[str] = []
    for spec in COLLECTION_SPECS:
        collection_id = config.collection_ids[spec["logical"]]
        status, warns = ensure_collection(backend, config.database_id, spec, collection_id)
        ok(f"{collection_id} ({spec['name']}) — {status}")
        warnings.extend(warns)
        if spec["note"]:
            print(f"      · {spec['note']}", flush=True)

    # -- 5. Attributes ----------------------------------------------------------
    step(5, 8, "Attributes (waiting for Appwrite to build them)")
    total_attrs = 0
    for spec in COLLECTION_SPECS:
        collection_id = config.collection_ids[spec["logical"]]
        coll = backend.get(f"/databases/{config.database_id}/collections/{collection_id}")
        existing = {a.get("key"): a for a in coll.get("attributes") or []}
        created = 0
        for attr in spec["attributes"]:
            outcome = ensure_attribute(backend, config.database_id, collection_id, attr, existing)
            if outcome == "created":
                created += 1
        keys = [a.key for a in spec["attributes"]]
        wait_for_attributes(backend, config.database_id, collection_id, keys)
        total_attrs += len(keys)
        ok(f"{collection_id}: {len(keys)} attributes available ({created} newly created)")

    # -- 6. Indexes --------------------------------------------------------------
    step(6, 8, "Indexes")
    total_idx = 0
    for spec in COLLECTION_SPECS:
        collection_id = config.collection_ids[spec["logical"]]
        if not spec["indexes"]:
            continue
        coll = backend.get(f"/databases/{config.database_id}/collections/{collection_id}")
        existing_keys = {i.get("key") for i in coll.get("indexes") or []}
        created = 0
        for index in spec["indexes"]:
            if ensure_index(backend, config.database_id, collection_id, index, existing_keys) == "created":
                created += 1
        keys = [i.key for i in spec["indexes"]]
        wait_for_indexes(backend, config.database_id, collection_id, keys)
        total_idx += len(keys)
        ok(f"{collection_id}: {len(keys)} indexes available ({created} newly created)")

    # -- 7. Storage bucket ---------------------------------------------------------
    step(7, 8, "Storage bucket")
    maximum_bytes = int(config.max_file_size_mb) * 1024 * 1024
    try:
        bucket = backend.get(f"/storage/buckets/{config.bucket_id}")
        ok(f"{config.bucket_id} already exists")
        missing = [e for e in ALLOWED_EXTENSIONS if e not in (bucket.get("allowedExtensions") or [])]
        if missing:
            warn(f"bucket allowlist is missing extensions: {', '.join(missing)} — add them in Console → Storage.")
        if bucket.get("maximumFileSize") and bucket["maximumFileSize"] < maximum_bytes:
            warn(f"bucket maximum is {bucket['maximumFileSize'] // (1024 * 1024)} MB, below the configured {config.max_file_size_mb} MB.")
    except BackendError as exc:
        if exc.code != 404:
            raise
        try:
            backend.post(
                "/storage/buckets",
                {
                    "bucketId": config.bucket_id,
                    "name": BUCKET_DISPLAY_NAME,
                    "permissions": [READ_USERS, WRITE_ADMINS],
                    "fileSecurity": False,
                    "maximumFileSize": maximum_bytes,
                    "allowedExtensions": ALLOWED_EXTENSIONS,
                    "encryption": True,
                    "antivirus": False,
                },
            )
            ok(f"{config.bucket_id} created — read users · write team:admins · allowlist of {len(ALLOWED_EXTENSIONS)} extensions · max {config.max_file_size_mb} MB")
        except BackendError as exc2:
            if exc2.code == 409:
                ok(f"{config.bucket_id} already exists")
            else:
                raise

    # -- 8. Web platform (best effort) ----------------------------------------------
    step(8, 8, "Web platform (browser CORS allowlist)")
    if config.skip_platform:
        warn("skipped by --skip-platform")
    else:
        try:
            backend.post(
                f"/projects/{config.project_id}/platforms",
                {"type": "web", "name": "Folio (localhost)", "hostname": "localhost"},
            )
            ok("localhost registered — the browser may talk to your project")
        except BackendError as exc:
            if exc.code == 409:
                ok("localhost platform already registered")
            else:
                warn(
                    "could not add the platform automatically (API key may lack the projects.write scope).\n"
                    "        Add it manually: Console → Overview → Integrations → Platforms → Add platform → Web app → hostname localhost."
                )

    for w in warnings:
        warn(w)

    print("\n" + "=" * 76)
    ok("Schema is ready.")
    print_config_block(config)
    print(
        "-" * 76
        + "\nNEXT STEPS\n"
        + "-" * 76
        + "\n  1. Paste the FOLIO_CONFIG block above into script.js.\n"
        + "  2. Create the first administrator:\n"
        + "         python3 backend/create_user.py\n"
        + "  3. Serve the Folio folder (do NOT open index.html via file://):\n"
        + "         python3 -m http.server 8000\n"
        + "  4. Open http://localhost:8000 and sign in.\n"
    )
    return EXIT_OK


def main(argv: Optional[Sequence[str]] = None) -> int:
    here = Path(__file__).resolve().parent
    candidates = [
        Path.cwd() / ".env",
        here / ".env",
        here.parent / ".env",
    ]
    # Resolve to canonical absolute paths before deduplicating: on Windows the
    # same file can be reached via different spellings (drive-letter case,
    # short 8.3 names, ...), which used to print the same .env twice.
    resolved: List[Path] = []
    for candidate in candidates:
        try:
            candidate = candidate.resolve()
        except OSError:  # pragma: no cover — cwd deleted, exotic filesystems
            pass
        if candidate not in resolved:
            resolved.append(candidate)
    loaded = load_env_files(resolved)
    if loaded:
        print(f"Loaded environment from: {', '.join(dict.fromkeys(loaded))}")

    args = build_parser().parse_args(argv)
    try:
        config = Config(args)
        problems = config.validate()
        if problems:
            for problem in problems:
                fail(problem)
            return EXIT_CONFIG
    except ValidationError as exc:
        fail(str(exc))
        return EXIT_VALIDATION

    print("Folio database setup")
    print(config.masked_summary())

    try:
        return run(config)
    except BackendError as exc:
        fail(f"Appwrite error: {exc}")
        text = str(exc).lower()
        if "missing scope" in text:
            # Appwrite reports insufficient permissions as HTTP 401 with a
            # "missing scopes (...)" message: the key is VALID, its scope
            # list is not. Give a targeted, console-first fix.
            print("  Your API key is valid but lacks the required permission scopes.")
            print("  Fix: Appwrite Console → your project → Integrations → API Keys →")
            print("  open your key and enable every scope listed in this script's")
            print("  header (the error above names the first missing one). Updating")
            print("  the existing key keeps its secret; if you create a NEW key")
            print("  instead, also replace APPWRITE_API_KEY in your .env, then re-run.")
        elif exc.code == 401:
            print("  The API key was rejected — check APPWRITE_API_KEY (see the scope list in the script header).")
        elif exc.code == 403 and (
            "maximum number" in text or "upgrade" in text or "selected plan" in text
        ):
            # Plan-limit refusals arrive as 403 with an "Upgrade …" message.
            # They are NOT key problems — give the plan-specific options.
            if "database" in text:
                print("  This is a PLAN LIMIT, not a key problem: your plan allows only a limited")
                print("  number of databases and your project already has one. Folio uses exactly")
                print("  ONE database (all five collections live inside it), so no upgrade is needed:")
                print("    a) Reuse it: Console → Databases → copy the existing database's ID, then")
                print("       set APPWRITE_DATABASE_ID=<that-id> in backend\\.env and re-run.")
                print("    b) Free the slot: if that database is an empty leftover, delete it in the")
                print("       console (Databases → database → Settings → Delete) and re-run.")
            elif "bucket" in text:
                print("  This is a PLAN LIMIT, not a key problem: your plan's storage-bucket limit")
                print("  is reached. Pick either fix and re-run:")
                print("    a) Reuse an existing bucket: set APPWRITE_BUCKET_ID=<its-id> in backend\\.env, or")
                print("    b) delete an unused bucket in Console → Storage, then re-run.")
            else:
                print("  This is a plan limit, not a key problem — upgrade the plan, or free the")
                print("  slot by deleting resources you no longer need, then re-run.")
        elif exc.code == 403:
            print("  Appwrite refused the operation (403). The message above is authoritative; if it")
            print("  mentions scopes, re-create the key with the scope list in this script's header.")
        return EXIT_BACKEND
    except KeyboardInterrupt:
        print("\nInterrupted — nothing was deleted; simply re-run the command to resume.")
        return EXIT_INTERRUPTED


if __name__ == "__main__":
    sys.exit(main())
