#!/usr/bin/env python3
"""Folio - private administrator utility for provisioning library users.

This script creates, on Appwrite Cloud:

  1. the two Folio teams (``admins`` / ``viewers``, IDs configurable),
  2. an email/password auth account for one user,
  3. the user's ``profiles`` document (document $id == user ID),
  4. the user's membership in exactly one role team.

It is the ONLY supported way to create Folio accounts: the Appwrite project
runs with public signup disabled, so every user must be enrolled here by an
administrator. Team membership is the server-enforced role: write access to
the database collections and the storage bucket is granted to the ``admins``
team only, while every authenticated user can read.

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

The script is idempotent: every step uses "ensure" semantics. If a run fails
halfway (for example the account exists but the profile document does not),
simply re-run the same command - existing objects are detected and reused
instead of failing.

Python 3.9+, standard library only. If the official Appwrite SDK is
installed (``pip install "appwrite>=6.0.0"``) it is used as the transport;
otherwise the script transparently falls back to a pure-stdlib REST client.
"""

from __future__ import annotations

import argparse
import getpass
import inspect
import json
import os
import re
import secrets
import string
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_DATABASE_ID = "folio"
DEFAULT_PROFILES_COLLECTION_ID = "profiles"
DEFAULT_ADMIN_TEAM_ID = "admins"
DEFAULT_VIEWER_TEAM_ID = "viewers"

ADMIN_TEAM_DISPLAY_NAME = "Folio Administrators"
VIEWER_TEAM_DISPLAY_NAME = "Folio Viewers"

USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9._-]{3,36}$")
EMAIL_PATTERN = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

USER_ID_MAX_LEN = 36
MIN_PASSWORD_LENGTH = 8
GENERATED_PASSWORD_LENGTH = 20
PASSWORD_SYMBOLS = "!@#$%^&*()-_=+[]{}<>?"
PASSWORD_FILE_PREFIX = "generated-password"
ADMIN_CONFIRMATION_PHRASE = "I UNDERSTAND"

EMAIL_PAGE_SIZE = 100  # page size for the duplicate-email scan fallback
EMAIL_SCAN_CAP = 1000  # hard cap so a huge directory cannot stall the script
HTTP_TIMEOUT_SECONDS = 30

EXIT_OK = 0
EXIT_CONFIG = 1
EXIT_VALIDATION = 2
EXIT_BACKEND = 3
EXIT_INTERRUPTED = 130  # conventional 128 + SIGINT


# ---------------------------------------------------------------------------
# Exceptions (each maps to a specific exit code)
# ---------------------------------------------------------------------------


class ConfigError(Exception):
    """Missing or invalid configuration (exit code 1)."""


class ValidationError(Exception):
    """Invalid user-supplied data or a failed confirmation (exit code 2)."""


class BackendError(Exception):
    """Appwrite API / transport failure (exit code 3).

    ``code`` is the HTTP status when known and ``type`` the Appwrite error
    type (for example ``user_email_already_exists``). Messages are scrubbed
    of secrets by the transports before the exception is built.
    """

    def __init__(self, message: str, code: Optional[int] = None, err_type: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.type = err_type


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def scrub_secret(text: str, secret: Optional[str]) -> str:
    """Best-effort removal of the API key from any upstream text."""
    if not text:
        return ""
    if secret and secret in text:
        return text.replace(secret, "********")
    return text


def mask_secret(secret: str) -> str:
    """Display form of a secret: only the last four characters, if any."""
    if not secret:
        return "(not set)"
    if len(secret) <= 4:
        return "****"
    return "****" + secret[-4:]


def as_mapping(result: Any) -> Dict[str, Any]:
    """Normalize an SDK/REST response object to a plain dict."""
    if isinstance(result, dict):
        return result
    for attr in ("to_map", "toMap", "to_dict"):
        converter = getattr(result, attr, None)
        if callable(converter):
            try:
                converted = converter()
            except Exception:  # noqa: BLE001 - probing unknown SDK shapes
                continue
            if isinstance(converted, dict):
                return converted
    if isinstance(result, Mapping):
        return dict(result)
    return {}


def appwrite_query(method: str, attribute: Optional[str] = None, values: Sequence[Any] = ()) -> str:
    """Build one Appwrite query string in the JSON form the API expects.

    Appwrite's REST API expects each ``queries`` entry to be a JSON object
    such as ``{"method": "equal", "attribute": "email",
    "values": ["a@b.c"]}`` (exactly what the SDK's ``Query`` helpers
    produce). The legacy ``equal("email", "a@b.c")`` filter text was removed
    server-side and is rejected with "Invalid query: Syntax error".
    """
    query: Dict[str, Any] = {"method": method}
    if attribute is not None:
        query["attribute"] = attribute
    query["values"] = list(values)
    return json.dumps(query, separators=(",", ":"))


def _try_call(fn: Callable[..., Any], *args_orders: Tuple[Any, ...], **kwargs_orders: Any) -> Any:
    """Call ``fn`` defensively across SDK versions with differing signatures.

    Each item in ``args_orders`` is a tuple of positional arguments; each
    value in ``kwargs_orders`` is a dict of keyword arguments (the keyword
    name is only a readability label). Candidates are bind-tested against the
    real signature first (side-effect free); the first candidate that binds
    is executed. A ``TypeError`` raised during execution also moves on to the
    next candidate. If no candidate works, the last ``TypeError`` is raised.
    """
    if not args_orders and not kwargs_orders:
        raise TypeError("_try_call needs at least one candidate signature")
    candidates: List[Tuple[Tuple[Any, ...], Dict[str, Any]]] = [
        (tuple(order), {}) for order in args_orders
    ]
    candidates += [((), dict(order)) for order in kwargs_orders.values()]
    fallback = TypeError(f"no candidate signature matched for {getattr(fn, '__qualname__', fn)!r}")
    last_type_error: Optional[TypeError] = None
    for args, kwargs in candidates:
        try:
            inspect.signature(fn).bind(*args, **kwargs)
        except ValueError:
            pass  # cannot introspect this callable - attempt the call as-is
        except TypeError:
            continue  # signature mismatch - try the next candidate
        try:
            return fn(*args, **kwargs)
        except TypeError as exc:  # bound but still a calling-convention issue
            last_type_error = exc
    if last_type_error is None:
        raise fallback
    raise last_type_error


def backend_error_from_response(status: int, raw_body: str, secret: str) -> BackendError:
    """Convert an Appwrite HTTP error response into a friendly BackendError.

    Parses the JSON body (``{"type": ..., "code": ..., "message": ...}``);
    the resulting message never contains the API key.
    """
    message = ""
    err_type = ""
    try:
        parsed = json.loads(raw_body)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        message = str(parsed.get("message") or "")
        err_type = str(parsed.get("type") or "")

    if status == 401:
        friendly = "Appwrite rejected the API key (HTTP 401): the key is missing, invalid or expired."
    elif status == 403:
        friendly = (
            "Appwrite denied the request (HTTP 403): the API key is missing a required scope. "
            "Needed scopes: users.read, users.write, teams.read, teams.write, databases.read, "
            "documents.write."
        )
    else:
        friendly = f"Appwrite API error (HTTP {status})."
    if message:
        friendly += f" Details: {scrub_secret(message, secret)}"
    elif raw_body:
        friendly += f" Raw response: {scrub_secret(raw_body[:200], secret)}"
    return BackendError(friendly, code=status, err_type=err_type)


# ---------------------------------------------------------------------------
# .env loading (python-dotenv optional, tiny built-in fallback parser)
# ---------------------------------------------------------------------------


def _parse_dotenv_text(text: str) -> Dict[str, str]:
    """Minimal .env parser used when python-dotenv is not installed.

    Understands ``KEY=value``, an optional ``export `` prefix, blank lines,
    ``#`` comments and simple surrounding quotes. Values are never expanded
    or interpreted beyond unquoting.
    """
    values: Dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def load_env_files(candidates: Sequence[Path]) -> None:
    """Load ``.env`` files (working directory first, then the script directory).

    Uses python-dotenv when available; otherwise falls back to the minimal
    built-in parser. Variables already present in the real environment are
    never overridden.
    """
    try:
        from dotenv import load_dotenv  # type: ignore
    except ImportError:
        load_dotenv = None  # type: ignore[assignment]

    for path in candidates:
        if not path.is_file():
            continue
        if load_dotenv is not None:
            load_dotenv(dotenv_path=str(path), override=False)
        else:
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                print(f"note: could not read {path}: {exc}", file=sys.stderr)
                continue
            for key, value in _parse_dotenv_text(text).items():
                os.environ.setdefault(key, value)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass
class Config:
    """Resolved script configuration (contains secrets - never printed raw)."""

    endpoint: str
    project_id: str
    api_key: str
    database_id: str
    profiles_collection_id: str
    admin_team_id: str
    viewer_team_id: str

    def masked_summary(self) -> str:
        """Human-readable configuration block with the API key masked."""
        return "\n".join(
            [
                "Configuration (API key masked):",
                f"  endpoint             : {self.endpoint}",
                f"  project ID           : {self.project_id}",
                f"  API key              : {mask_secret(self.api_key)}",
                f"  database ID          : {self.database_id}",
                f"  profiles collection  : {self.profiles_collection_id}",
                f"  admin team ID        : {self.admin_team_id}",
                f"  viewer team ID       : {self.viewer_team_id}",
            ]
        )


def load_config(args: argparse.Namespace) -> Config:
    """Resolve CLI flags > environment/.env > defaults, then validate."""
    script_dir = Path(__file__).resolve().parent
    load_env_files([Path.cwd() / ".env", script_dir / ".env"])

    endpoint = (args.endpoint or os.environ.get("APPWRITE_ENDPOINT") or "").strip().rstrip("/")
    project_id = (args.project_id or os.environ.get("APPWRITE_PROJECT_ID") or "").strip()
    api_key = (os.environ.get("APPWRITE_API_KEY") or "").strip()

    if not endpoint:
        raise ConfigError(
            "APPWRITE_ENDPOINT is not set. Export it (for example "
            "https://sgp.cloud.appwrite.io/v1), put it in a local .env file, "
            "or pass --endpoint."
        )
    if not re.match(r"^https?://", endpoint):
        raise ConfigError(
            "APPWRITE_ENDPOINT must be a full http(s) URL such as "
            f"https://sgp.cloud.appwrite.io/v1 (got: {endpoint})."
        )
    if not project_id:
        raise ConfigError(
            "APPWRITE_PROJECT_ID is not set. Export it, put it in a local "
            ".env file, or pass --project-id."
        )
    if not api_key:
        raise ConfigError(
            "APPWRITE_API_KEY is not set. This script intentionally does NOT "
            "accept the API key as a CLI flag: shell arguments are stored in "
            "shell history and visible in process listings. Put the key in "
            "your environment or in a local .env file with permissions 0600."
        )

    admin_team_id = (os.environ.get("APPWRITE_ADMIN_TEAM_ID") or DEFAULT_ADMIN_TEAM_ID).strip()
    viewer_team_id = (os.environ.get("APPWRITE_VIEWER_TEAM_ID") or DEFAULT_VIEWER_TEAM_ID).strip()
    if admin_team_id == viewer_team_id:
        raise ConfigError(
            "APPWRITE_ADMIN_TEAM_ID and APPWRITE_VIEWER_TEAM_ID must differ "
            f"(both are '{admin_team_id}')."
        )

    return Config(
        endpoint=endpoint,
        project_id=project_id,
        api_key=api_key,
        database_id=(
            args.database_id
            or os.environ.get("APPWRITE_DATABASE_ID")
            or DEFAULT_DATABASE_ID
        ).strip(),
        profiles_collection_id=(
            os.environ.get("APPWRITE_PROFILES_COLLECTION_ID") or DEFAULT_PROFILES_COLLECTION_ID
        ).strip(),
        admin_team_id=admin_team_id,
        viewer_team_id=viewer_team_id,
    )


# ---------------------------------------------------------------------------
# Transport: official Appwrite SDK (preferred)
# ---------------------------------------------------------------------------


class SdkBackend:
    """Appwrite transport built on the official Python SDK.

    SDK method signatures vary between releases, so every call goes through
    :func:`_try_call` with the documented kwargs plus alternate/positional
    forms as fallbacks.
    """

    def __init__(self, config: Config) -> None:
        # Lazy imports: the SDK is an optional dependency. An ImportError
        # from here is caught by build_backend(), which falls back to REST.
        from appwrite.client import Client
        from appwrite.id import ID
        from appwrite.permission import Permission
        from appwrite.role import Role
        from appwrite.services.databases import Databases
        from appwrite.services.teams import Teams
        from appwrite.services.users import Users

        try:
            from appwrite.query import Query
        except ImportError:  # pragma: no cover - Query ships with every SDK build
            Query = None  # type: ignore[assignment,misc]

        self._config = config
        self._id = ID
        self._permission = Permission
        self._role = Role
        self._query = Query

        client = Client()
        client.set_endpoint(config.endpoint)
        client.set_project(config.project_id)
        client.set_key(config.api_key)
        self._users = Users(client)
        self._teams = Teams(client)
        self._databases = Databases(client)

    # -- infrastructure ------------------------------------------------------

    def _wrap(self, exc: Exception) -> BackendError:
        """Convert an SDK exception into a scrubbed, friendly BackendError."""
        code = getattr(exc, "code", None)
        if isinstance(code, bool) or not isinstance(code, int):
            code = None
        err_type = str(getattr(exc, "type", "") or "")
        message = str(getattr(exc, "message", "") or exc)
        return BackendError(
            scrub_secret(message, self._config.api_key), code=code, err_type=err_type
        )

    def _call(self, fn: Callable[..., Any], *args_orders: Tuple[Any, ...], **kwargs_orders: Any) -> Any:
        """Run one SDK call via _try_call; translate all failures."""
        try:
            return _try_call(fn, *args_orders, **kwargs_orders)
        except TypeError as exc:
            raise BackendError(
                "The installed Appwrite SDK does not match any known calling "
                f"convention for this operation ({exc}). Install a current "
                'SDK: pip install "appwrite>=6.0.0".'
            ) from None
        except Exception as exc:
            raise self._wrap(exc) from None

    # -- users ---------------------------------------------------------------

    def create_user(self, user_id: str, email: str, password: str, name: str) -> Dict[str, Any]:
        """POST /users - create an auth account via the administrative API."""
        return as_mapping(
            self._call(
                self._users.create,
                snake={"user_id": user_id, "email": email, "phone": "", "password": password, "name": name},
                snake_compact={"user_id": user_id, "email": email, "password": password, "name": name},
                camel={"userId": user_id, "email": email, "password": password, "name": name},
                positional_current=(user_id, email, "", password, name),
                positional_legacy=(user_id, email, password, name),
            )
        )

    def list_users(
        self,
        queries: Optional[List[str]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /users - list accounts, optionally filtered or paged."""
        query_strings = list(queries or [])
        if limit is not None:
            query_strings = query_strings + [self._limit_query(limit), self._offset_query(offset)]
        return as_mapping(
            self._call(
                self._users.list,
                snake={"queries": query_strings},
                positional=(query_strings,),
            )
        )

    def _limit_query(self, limit: int) -> str:
        if self._query is not None:
            try:
                return str(self._query.limit(limit))
            except Exception:  # noqa: BLE001 - any helper failure falls back to raw text
                pass
        return appwrite_query("limit", values=[limit])

    def _offset_query(self, offset: int) -> str:
        if self._query is not None:
            try:
                return str(self._query.offset(offset))
            except Exception:  # noqa: BLE001
                pass
        return appwrite_query("offset", values=[offset])

    @property
    def supports_email_query(self) -> bool:
        """True when the SDK's Query helper is available for direct lookups."""
        return self._query is not None

    def email_query(self, email: str) -> str:
        """Build the Appwrite query string for an exact email match."""
        if self._query is None:  # pragma: no cover - guarded by supports_email_query
            raise BackendError("SDK Query helper is unavailable.")
        return str(self._query.equal("email", email))

    # -- teams ---------------------------------------------------------------

    def create_team(self, team_id: str, name: str) -> Dict[str, Any]:
        """POST /teams - create a team (409 is tolerated by the caller)."""
        return as_mapping(
            self._call(
                self._teams.create,
                snake={"team_id": team_id, "name": name},
                camel={"teamId": team_id, "name": name},
                positional=(team_id, name),
            )
        )

    def create_membership(self, team_id: str, user_id: str, role: str) -> Dict[str, Any]:
        """POST /teams/{teamId}/memberships - add a user with one role."""
        return as_mapping(
            self._call(
                self._teams.create_membership,
                snake={"team_id": team_id, "roles": [role], "user_id": user_id},
                snake_legacy_url={
                    "team_id": team_id,
                    "roles": [role],
                    "url": None,
                    "email": None,
                    "user_id": user_id,
                },
                camel={"teamId": team_id, "roles": [role], "userId": user_id},
                positional=(team_id, [role], None, user_id),
            )
        )

    # -- documents -----------------------------------------------------------

    def get_document(self, database_id: str, collection_id: str, document_id: str) -> Dict[str, Any]:
        """GET /databases/{db}/collections/{col}/documents/{doc}."""
        return as_mapping(
            self._call(
                self._databases.get_document,
                snake={
                    "database_id": database_id,
                    "collection_id": collection_id,
                    "document_id": document_id,
                },
                camel={
                    "databaseId": database_id,
                    "collectionId": collection_id,
                    "documentId": document_id,
                },
                positional=(database_id, collection_id, document_id),
            )
        )

    def create_document(
        self,
        database_id: str,
        collection_id: str,
        document_id: str,
        data: Dict[str, Any],
        permissions: List[str],
    ) -> Dict[str, Any]:
        """POST /databases/{db}/collections/{col}/documents."""
        document_ref = self._id.custom(document_id)
        return as_mapping(
            self._call(
                self._databases.create_document,
                snake={
                    "database_id": database_id,
                    "collection_id": collection_id,
                    "document_id": document_ref,
                    "data": data,
                    "permissions": permissions,
                },
                camel={
                    "databaseId": database_id,
                    "collectionId": collection_id,
                    "documentId": document_ref,
                    "data": data,
                    "permissions": permissions,
                },
                positional=(database_id, collection_id, document_ref, data, permissions),
            )
        )

    def update_document(
        self, database_id: str, collection_id: str, document_id: str, data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """PATCH /databases/{db}/collections/{col}/documents/{doc}."""
        return as_mapping(
            self._call(
                self._databases.update_document,
                snake={
                    "database_id": database_id,
                    "collection_id": collection_id,
                    "document_id": document_id,
                    "data": data,
                },
                camel={
                    "databaseId": database_id,
                    "collectionId": collection_id,
                    "documentId": document_id,
                    "data": data,
                },
                positional=(database_id, collection_id, document_id, data),
            )
        )

    def profile_permissions(self, user_id: str) -> List[str]:
        """Profile doc permissions: read for the user and for the admins team."""
        return [
            str(self._permission.read(self._role.user(user_id))),
            str(self._permission.read(self._role.team(self._config.admin_team_id))),
        ]


# ---------------------------------------------------------------------------
# Transport: pure standard-library REST fallback
# ---------------------------------------------------------------------------


class RestBackend:
    """Pure standard-library Appwrite transport (no third-party packages).

    Talks to the documented REST endpoints with ``urllib.request`` and the
    ``X-Appwrite-Project`` / ``X-Appwrite-Key`` headers.
    """

    def __init__(self, config: Config) -> None:
        self._endpoint = config.endpoint.rstrip("/")
        self._project_id = config.project_id
        self._api_key = config.api_key
        self._admin_team_id = config.admin_team_id

    # -- low level -------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        query_pairs: Optional[Sequence[Tuple[str, str]]] = None,
    ) -> Dict[str, Any]:
        url = self._endpoint + path
        if query_pairs:
            url += "?" + urllib.parse.urlencode(list(query_pairs), doseq=True)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "X-Appwrite-Project": self._project_id,
                "X-Appwrite-Key": self._api_key,
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            try:
                raw_body = exc.read().decode("utf-8", "replace")
            except OSError:
                raw_body = ""
            raise backend_error_from_response(exc.code, raw_body, self._api_key) from None
        except urllib.error.URLError as exc:
            reason = scrub_secret(str(getattr(exc, "reason", "") or exc), self._api_key)
            raise BackendError(f"Network error while contacting {self._endpoint}: {reason}") from None
        except OSError as exc:
            raise BackendError(
                f"Network error while contacting {self._endpoint}: "
                f"{scrub_secret(str(exc), self._api_key)}"
            ) from None
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            raise BackendError("Appwrite returned a non-JSON response (proxy or outage?).") from None
        if not isinstance(parsed, dict):
            raise BackendError("Appwrite returned an unexpected response shape.")
        return parsed

    # -- users -------------------------------------------------------------------

    def create_user(self, user_id: str, email: str, password: str, name: str) -> Dict[str, Any]:
        """POST /users - create an auth account via the administrative API."""
        return self._request(
            "POST",
            "/users",
            body={"userId": user_id, "email": email, "password": password, "name": name},
        )

    @property
    def supports_email_query(self) -> bool:
        """The REST transport builds Appwrite query strings directly."""
        return True

    def email_query(self, email: str) -> str:
        return appwrite_query("equal", "email", [email])

    def list_users(
        self,
        queries: Optional[List[str]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /users - list accounts, optionally filtered or paged."""
        query_strings = list(queries or [])
        if limit is not None:
            query_strings = query_strings + [
                appwrite_query("limit", values=[limit]),
                appwrite_query("offset", values=[offset if offset is not None else 0]),
            ]
        if not query_strings:
            return self._request("GET", "/users")
        # Array parameters are accepted either as one JSON-encoded `queries`
        # value (URL-encoded) or as repeated `queries[]` keys; try both on 400.
        encodings: List[Sequence[Tuple[str, str]]] = [
            [("queries", json.dumps(query_strings, separators=(",", ":")))],
            [("queries[]", value) for value in query_strings],
        ]
        last_error: Optional[BackendError] = None
        for pairs in encodings:
            try:
                return self._request("GET", "/users", query_pairs=pairs)
            except BackendError as exc:
                if exc.code != 400:
                    raise
                last_error = exc
        if last_error is not None:
            raise last_error
        raise BackendError("Could not list users.")

    # -- teams ---------------------------------------------------------------

    def create_team(self, team_id: str, name: str) -> Dict[str, Any]:
        """POST /teams - create a team (409 is tolerated by the caller)."""
        return self._request("POST", "/teams", body={"teamId": team_id, "name": name})

    def create_membership(self, team_id: str, user_id: str, role: str) -> Dict[str, Any]:
        """POST /teams/{teamId}/memberships - add a user with one role."""
        path = f"/teams/{urllib.parse.quote(team_id, safe='')}/memberships"
        return self._request("POST", path, body={"roles": [role], "userId": user_id})

    # -- documents -----------------------------------------------------------

    def _collection_path(self, database_id: str, collection_id: str) -> str:
        return (
            f"/databases/{urllib.parse.quote(database_id, safe='')}"
            f"/collections/{urllib.parse.quote(collection_id, safe='')}/documents"
        )

    def get_document(self, database_id: str, collection_id: str, document_id: str) -> Dict[str, Any]:
        path = self._collection_path(database_id, collection_id)
        path += f"/{urllib.parse.quote(document_id, safe='')}"
        return self._request("GET", path)

    def create_document(
        self,
        database_id: str,
        collection_id: str,
        document_id: str,
        data: Dict[str, Any],
        permissions: List[str],
    ) -> Dict[str, Any]:
        body = {"documentId": document_id, "data": data, "permissions": permissions}
        return self._request("POST", self._collection_path(database_id, collection_id), body=body)

    def update_document(
        self, database_id: str, collection_id: str, document_id: str, data: Dict[str, Any]
    ) -> Dict[str, Any]:
        path = self._collection_path(database_id, collection_id)
        path += f"/{urllib.parse.quote(document_id, safe='')}"
        return self._request("PATCH", path, body={"data": data})

    def profile_permissions(self, user_id: str) -> List[str]:
        """Profile doc permissions, built manually as permission strings."""
        return [
            f'read("user:{user_id}")',
            f'read("team:{self._admin_team_id}")',
        ]


# ---------------------------------------------------------------------------
# Idempotent ensure-steps and the duplicate-email lookup
# ---------------------------------------------------------------------------


def ensure_team(backend: Any, team_id: str, display_name: str) -> str:
    """Create a team unless it already exists. Returns a status label."""
    try:
        backend.create_team(team_id, display_name)
        return "created"
    except BackendError as exc:
        if exc.code == 409 or "already_exists" in (exc.type or ""):
            return "already exists"
        raise


def ensure_membership(backend: Any, team_id: str, user_id: str, role: str) -> str:
    """Add a user to a team unless already a member. Returns a status label."""
    try:
        backend.create_membership(team_id, user_id, role)
        return "created"
    except BackendError as exc:
        if exc.code == 409 or (exc.type or "") in ("membership_already_exists", "user_already_member"):
            return "already exists"
        raise


def ensure_profile_document(
    backend: Any,
    config: Config,
    user_id: str,
    data: Dict[str, Any],
) -> Tuple[str, Dict[str, Any], Optional[Dict[str, Any]]]:
    """Create the profile document, or reconcile role/displayName on conflict.

    The document $id equals the Appwrite user ID and its permissions grant
    read access to that user and to the admins team. Returns
    ``(status, updated_fields, existing_document)`` where status is one of
    ``created`` / ``updated`` / ``unchanged``.
    """
    permissions = backend.profile_permissions(user_id)
    try:
        backend.create_document(
            config.database_id, config.profiles_collection_id, user_id, data, permissions
        )
        return "created", {}, None
    except BackendError as exc:
        if not (exc.code == 409 or "already_exists" in (exc.type or "")):
            raise
    existing = as_mapping(
        backend.get_document(config.database_id, config.profiles_collection_id, user_id)
    )
    diffs = {
        key: value
        for key, value in data.items()
        if key in ("role", "displayName") and existing.get(key) != value
    }
    if diffs:
        backend.update_document(config.database_id, config.profiles_collection_id, user_id, diffs)
        return "updated", diffs, existing
    return "unchanged", {}, existing


def find_user_by_email(backend: Any, email: str) -> Optional[Dict[str, Any]]:
    """Return the existing user with this email, or ``None``.

    Prefers a direct ``equal("email", ...)`` query. When the SDK's Query
    helper is unavailable (or the server rejects the query), falls back to
    scanning pages of 100 users in Python, capped at EMAIL_SCAN_CAP entries.
    This doubles as the duplicate check that makes re-runs idempotent.
    """
    if getattr(backend, "supports_email_query", False):
        try:
            page = as_mapping(backend.list_users(queries=[backend.email_query(email)]))
        except BackendError as exc:
            if exc.code != 400:
                raise
            page = None  # server refused the query - scan pages instead
        if page is not None:
            return _match_email(page.get("users") or [], email)

    scanned = 0
    offset = 0
    while scanned < EMAIL_SCAN_CAP:
        page = as_mapping(backend.list_users(limit=EMAIL_PAGE_SIZE, offset=offset))
        users = page.get("users") or []
        if not users:
            return None
        match = _match_email(users, email)
        if match is not None:
            return match
        scanned += len(users)
        offset += len(users)
        total = page.get("total")
        if isinstance(total, int) and offset >= total:
            return None
    raise BackendError(
        f"Gave up the duplicate-email scan after {EMAIL_SCAN_CAP} users without "
        f"finding '{email}'. Search manually in the Appwrite console."
    )


def _match_email(users: Sequence[Any], email: str) -> Optional[Dict[str, Any]]:
    wanted = email.casefold()
    for user in users:
        record = as_mapping(user)
        if str(record.get("email") or "").casefold() == wanted:
            return record
    return None


# ---------------------------------------------------------------------------
# User IDs, passwords and interactive collection of user details
# ---------------------------------------------------------------------------


def derive_user_id(username: str) -> str:
    """Appwrite user ID derived from the username.

    Lowercased, disallowed characters replaced with ``-``, truncated to
    USER_ID_MAX_LEN characters.
    """
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", username.strip().lower()).strip("-")
    if not cleaned:
        cleaned = "user"
    return cleaned[:USER_ID_MAX_LEN]


def suffixed_user_id(base: str) -> str:
    """A <=36-char variant of ``base`` with a short random suffix."""
    suffix = secrets.token_hex(2)  # 4 hex characters
    return f"{base[:USER_ID_MAX_LEN - 5]}-{suffix}"


def generate_password(length: int = GENERATED_PASSWORD_LENGTH) -> str:
    """Cryptographically random temporary password (>=16 chars) via secrets."""
    groups = (string.ascii_lowercase, string.ascii_uppercase, string.digits, PASSWORD_SYMBOLS)
    rng = secrets.SystemRandom()
    chars = [secrets.choice(group) for group in groups]
    pool = "".join(groups)
    chars.extend(secrets.choice(pool) for _ in range(max(0, length - len(chars))))
    rng.shuffle(chars)
    return "".join(chars)


def write_generated_password(email: str, password: str) -> Path:
    """Persist a generated password to a local 0600 file.

    The password is NEVER echoed or printed - only the file path is shown to
    the administrator. Raises ConfigError (abort) if the file cannot be
    written, so a generated password is never silently lost.
    """
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", email).strip("._-") or "user"
    path = Path.cwd() / f"{PASSWORD_FILE_PREFIX}-{sanitized}.txt"
    content = (
        f"Folio temporary password for: {email}\n"
        f"{password}\n"
        "Delete this file after securely sharing the password.\n"
    )
    try:
        path.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise ConfigError(
            f"Could not write the generated-password file '{path}' ({exc}). "
            "Aborting before account creation so the generated password is "
            "never lost or echoed."
        ) from None
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # best effort (e.g. Windows) - permissions are not enforceable there
    return path


@dataclass
class UserDetails:
    """One user's enrolment data.

    ``password is None`` means: generate one lazily, right before account
    creation, so nothing is generated for already-existing accounts.
    """

    display_name: str
    username: str
    email: str
    role: str
    password: Optional[str]


def _prompt_line(label: str) -> str:
    try:
        return input(f"{label}: ").strip()
    except EOFError:
        raise ValidationError("Input stream closed before all details were provided.") from None


def _prompt_username() -> str:
    while True:
        value = _prompt_line("Username (3-36 chars: letters, digits, '.', '_', '-')")
        if USERNAME_PATTERN.fullmatch(value):
            return value
        print("  invalid username - must be 3-36 characters using only a-z, A-Z, 0-9, '.', '_', '-'")


def _prompt_email() -> str:
    while True:
        value = _prompt_line("Email address")
        if EMAIL_PATTERN.fullmatch(value) and len(value) <= 254:
            return value
        print("  invalid email address - expected something like name@example.com")


def _prompt_role() -> str:
    print("  note: 'viewer' users can read content but cannot manage (create/edit/delete) it.")
    while True:
        value = _prompt_line("Role [viewer]").lower()
        if value in ("", "viewer"):
            return "viewer"
        if value == "admin":
            return "admin"
        print("  please type 'viewer' or 'admin' (empty = viewer)")


def _prompt_password() -> str:
    """Read a password twice via getpass; never echo it, validate length."""
    for _ in range(3):
        try:
            first = getpass.getpass("Initial password (min 8 characters; input hidden): ")
            if len(first) < MIN_PASSWORD_LENGTH:
                print(f"  password too short - at least {MIN_PASSWORD_LENGTH} characters required")
                continue
            second = getpass.getpass("Repeat the password: ")
        except EOFError:
            raise ValidationError("Input stream closed during password entry.") from None
        if first != second:
            print("  the two passwords do not match - try again")
            continue
        return first
    raise ValidationError("Password entry failed after 3 attempts.")


def collect_user_details(args: argparse.Namespace) -> UserDetails:
    """Gather user details from flags, prompting interactively for the rest."""
    interactive = sys.stdin.isatty()
    missing_flags = [
        flag
        for flag, value in (("--name", args.name), ("--username", args.username), ("--email", args.email))
        if not value
    ]
    if missing_flags and not interactive:
        raise ValidationError(
            "Missing "
            + ", ".join(missing_flags)
            + " and no interactive terminal is available. Pass them as flags or run in a terminal."
        )
    if not args.generate_password and not interactive:
        raise ValidationError(
            "A password is required but no interactive terminal is available. "
            "Use --generate-password or run in a terminal."
        )

    if args.username and not USERNAME_PATTERN.fullmatch(args.username):
        raise ValidationError(
            "--username must be 3-36 characters using only letters, digits, '.', '_' and '-'."
        )
    if args.email and not (EMAIL_PATTERN.fullmatch(args.email) and len(args.email) <= 254):
        raise ValidationError("--email is not a valid email address.")

    display_name = args.name or _prompt_line("Display name")
    username = args.username or _prompt_username()
    email = args.email or _prompt_email()
    if args.role:
        role = str(args.role)
    elif interactive:
        role = _prompt_role()
    else:
        role = "viewer"
    password: Optional[str] = None if args.generate_password else _prompt_password()
    return UserDetails(
        display_name=display_name, username=username, email=email, role=role, password=password
    )


# ---------------------------------------------------------------------------
# The provisioning run: four idempotent steps + summary
# ---------------------------------------------------------------------------


class Provisioning:
    """Runs the four provisioning steps with clear, per-step reporting."""

    def __init__(
        self,
        config: Config,
        backend: Any,
        details: UserDetails,
        assume_yes: bool,
        skip_password_hint: bool,
    ) -> None:
        self.config = config
        self.backend = backend
        self.details = details
        self.assume_yes = assume_yes
        self.skip_password_hint = skip_password_hint
        self.user: Dict[str, Any] = {}
        self.account_created = False
        self.password_file: Optional[Path] = None
        self.assigned_team = ""
        self.assigned_team_name = ""
        self.failure_reported = False
        self.state: Dict[str, str] = {
            "teams": "no",
            "user_id": "",
            "profile_doc_id": "",
            "team_id": "",
        }

    # -- driver ----------------------------------------------------------------

    def run(self) -> None:
        steps = [
            ("ensure Appwrite teams exist", self._ensure_teams),
            ("create the auth account", self._ensure_account),
            ("create/ensure the profile document", self._ensure_profile),
            ("assign team membership", self._ensure_membership),
        ]
        for index, (label, step) in enumerate(steps, start=1):
            print(f"\n- Step {index}/{len(steps)}: {label}")
            try:
                step()
            except BackendError as exc:
                self.failure_reported = True
                self._report_failure(label, exc)
                raise
        self._print_summary()

    # -- step a: teams -----------------------------------------------------------

    def _ensure_teams(self) -> None:
        teams: Dict[str, str] = {
            self.config.admin_team_id: ADMIN_TEAM_DISPLAY_NAME,
            self.config.viewer_team_id: VIEWER_TEAM_DISPLAY_NAME,
        }
        for team_id, display_name in teams.items():
            status = ensure_team(self.backend, team_id, display_name)
            print(f"  - team '{team_id}' ({display_name}): {status}")
        self.state["teams"] = "yes"

    # -- step b: account ---------------------------------------------------------

    def _ensure_account(self) -> None:
        details = self.details
        existing = find_user_by_email(self.backend, details.email)
        if existing:
            self._reuse_existing_account(existing, generated_mode=details.password is None)
            return

        password = details.password
        if password is None:
            # --generate-password: create the secret only now, when an account
            # will really be created, and persist it to a 0600 file.
            password = generate_password()
            self.password_file = write_generated_password(details.email, password)
            print(f"  - generated a temporary password and stored it in: {self.password_file}")
            print("    (file permissions 0600 - delete it after securely sharing the password)")

        base_id = derive_user_id(details.username)
        candidate_id = base_id
        for attempt in range(1, 4):
            try:
                created = self.backend.create_user(
                    candidate_id, details.email, password, details.display_name
                )
            except BackendError as exc:
                signature = f"{exc.type or ''} {exc}".lower()
                if "user_email_already_exists" in signature or "email already exists" in signature:
                    # Lost a race: the email was registered between the lookup
                    # and the create. Look it up again and reuse it.
                    existing = find_user_by_email(self.backend, details.email)
                    if existing:
                        self._reuse_existing_account(existing, generated_mode=details.password is None)
                        return
                    raise
                if ("user_already_exists" in signature or "already exists" in signature) and attempt < 3:
                    candidate_id = suffixed_user_id(base_id)
                    print(
                        f"  - user ID conflict - retrying with a random suffix "
                        f"(attempt {attempt + 1}/3): {candidate_id}"
                    )
                    continue
                raise
            self.user = as_mapping(created)
            self.account_created = True
            self.state["user_id"] = str(self.user.get("$id") or candidate_id)
            print(f"  - auth account created - Account ID: {self.state['user_id']}")
            return

    def _reuse_existing_account(self, existing: Dict[str, Any], generated_mode: bool) -> None:
        """Adopt an account that already exists (duplicate email)."""
        self.user = existing
        self.account_created = False
        self.state["user_id"] = str(existing.get("$id") or "")
        print(f"  - account already exists - reusing Account ID: {self.state['user_id']}")
        print("    note: the existing password is unknown to this script. Reset it in the")
        print("    Appwrite console if needed, or re-run with a different email address.")
        if generated_mode:
            print("    note: --generate-password was ignored because no new account was created.")

    # -- step c: profile document --------------------------------------------------

    def _ensure_profile(self) -> None:
        user_id = self.state["user_id"]
        if not user_id:
            raise BackendError("No Account ID is known - cannot continue with the profile step.")
        data = {
            "email": self.details.email,
            "displayName": self.details.display_name,
            "username": self.details.username,
            "role": self.details.role,
        }
        status, diffs, existing = ensure_profile_document(self.backend, self.config, user_id, data)
        self.state["profile_doc_id"] = user_id
        if status == "created":
            print(
                f"  - profile document created (ID: {user_id}) with attributes: "
                "email, displayName, username, role"
            )
        elif status == "updated":
            print(f"  - profile document already exists - updated: {', '.join(sorted(diffs))}")
        else:
            print(f"  - profile document already exists and matches (ID: {user_id}) - no changes")
        if existing and str(existing.get("role") or "") not in ("", self.details.role):
            print(
                f"    note: role changed from '{existing.get('role')}' to "
                f"'{self.details.role}'. The previous team membership (if any) "
                "can be removed in the Appwrite console."
            )

    # -- step d: team membership -----------------------------------------------------

    def _ensure_membership(self) -> None:
        if self.details.role == "admin":
            self._confirm_admin()
            team_id, team_name = self.config.admin_team_id, ADMIN_TEAM_DISPLAY_NAME
        else:
            team_id, team_name = self.config.viewer_team_id, VIEWER_TEAM_DISPLAY_NAME
        status = ensure_membership(self.backend, team_id, self.state["user_id"], self.details.role)
        self.state["team_id"] = team_id
        self.assigned_team = team_id
        self.assigned_team_name = team_name
        print(f"  - membership in team '{team_id}' ({team_name}): {status}")

    def _confirm_admin(self) -> None:
        """Require a typed confirmation before granting administrator rights."""
        if self.assume_yes:
            print("  - --yes given: granting administrator privileges without typed confirmation")
            return
        if not sys.stdin.isatty():
            raise ValidationError(
                "Granting 'admin' requires the typed confirmation 'I UNDERSTAND' on an "
                "interactive terminal; for automation re-run with --yes."
            )
        answer = input(f"Type {ADMIN_CONFIRMATION_PHRASE} to grant administrator privileges: ").strip()
        if answer != ADMIN_CONFIRMATION_PHRASE:
            raise ValidationError(
                "Confirmation not typed - aborting without granting administrator "
                "privileges. Anything already created (account, profile) is reused "
                "if you re-run the same command later."
            )

    # -- failure reporting and summary --------------------------------------------

    def _report_failure(self, label: str, exc: BackendError) -> None:
        state = self.state
        print(f"\n!! Step failed: {label}", file=sys.stderr)
        print(f"   {format_backend_error(exc)}", file=sys.stderr)
        print("   Already completed (this run or earlier runs):", file=sys.stderr)
        print(f"     - teams ensured       : {state['teams']}", file=sys.stderr)
        print(f"     - account (user ID)   : {state['user_id'] or '-'}", file=sys.stderr)
        print(f"     - profile document    : {state['profile_doc_id'] or '-'}", file=sys.stderr)
        print(f"     - team membership     : {state['team_id'] or '-'}", file=sys.stderr)
        if self.password_file and not self.account_created:
            print(
                f"     - note: a generated password file exists ({self.password_file}) "
                "but the account was not created - delete that file.",
                file=sys.stderr,
            )
        print(
            "   Recovery: re-run the exact same command - the script is idempotent and will",
            file=sys.stderr,
        )
        print(
            "   reuse everything that already exists; or complete the missing step in the",
            file=sys.stderr,
        )
        print("   Appwrite console.", file=sys.stderr)

    def _print_summary(self) -> None:
        details = self.details
        rule = "=" * 64
        print("\n" + rule)
        print("  FOLIO USER PROVISIONED SUCCESSFULLY")
        print(rule)
        print(f"  Display name     : {details.display_name}")
        print(f"  Username         : {details.username}")
        print(f"  Email            : {details.email}")
        print(f"  Account ID       : {self.state['user_id']}")
        print(f"  Profile doc ID   : {self.state['profile_doc_id']}")
        print(f"  Team             : {self.assigned_team} ({self.assigned_team_name})")
        print(f"  Role             : {details.role}")
        print(rule)
        print("  Next steps: share the email + initial password privately; the user")
        print("  changes it in Settings -> Change Password after first sign-in.")
        if self.password_file:
            print(f"  Temporary password file: {self.password_file} - delete it after sharing.")
            if not self.skip_password_hint:
                print("  Recommendation: the user should change this temporary password at")
                print("  first sign-in (Settings -> Change Password).")
        print(rule)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def format_backend_error(exc: BackendError) -> str:
    parts: List[str] = []
    if exc.code is not None:
        parts.append(f"HTTP {exc.code}")
    if exc.type:
        parts.append(f"type {exc.type}")
    suffix = f" ({', '.join(parts)})" if parts else ""
    return f"Backend error{suffix}: {exc}"


def build_backend(config: Config) -> Tuple[Any, str]:
    """Prefer the official SDK; fall back to the stdlib REST transport."""
    try:
        backend: Any = SdkBackend(config)
        return backend, "official Appwrite SDK"
    except ImportError:
        print(
            'note: the official Appwrite SDK is not installed (optional: pip install "appwrite>=6.0.0").',
            file=sys.stderr,
        )
        print("      Falling back to the built-in standard-library REST transport.", file=sys.stderr)
        return RestBackend(config), "stdlib REST transport"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="create_user.py",
        description="Folio - provision one library user in Appwrite Cloud (administrator only).",
        epilog=(
            "The API key is read from the environment or a local .env file only - it is "
            "deliberately not accepted on the command line, because shell history would record it."
        ),
    )
    parser.add_argument(
        "--endpoint",
        metavar="URL",
        help="Appwrite endpoint, e.g. https://sgp.cloud.appwrite.io/v1 (overrides APPWRITE_ENDPOINT)",
    )
    parser.add_argument(
        "--project-id", metavar="ID", help="Appwrite project ID (overrides APPWRITE_PROJECT_ID)"
    )
    parser.add_argument(
        "--database-id",
        metavar="ID",
        help=f"Database ID (default: {DEFAULT_DATABASE_ID})",
    )
    parser.add_argument("--name", metavar="NAME", help="Display name (skips that prompt)")
    parser.add_argument(
        "--username",
        metavar="NAME",
        help="Username, 3-36 chars [a-zA-Z0-9._-] (skips that prompt)",
    )
    parser.add_argument("--email", metavar="ADDRESS", help="Email address (skips that prompt)")
    parser.add_argument(
        "--role",
        choices=("viewer", "admin"),
        help="Library role (default: viewer; prompted for when interactive)",
    )
    parser.add_argument(
        "--generate-password",
        action="store_true",
        help="Generate a random temporary password instead of typing one",
    )
    parser.add_argument(
        "--skip-password-change-hint",
        action="store_true",
        help="Do not print the first-login password-change recommendation",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Assume the typed 'I UNDERSTAND' confirmation when granting admin (automation)",
    )
    return parser


def _run(argv: Optional[Sequence[str]]) -> int:
    args = build_parser().parse_args(argv)

    try:
        config = load_config(args)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    print(config.masked_summary())

    try:
        details = collect_user_details(args)
    except ValidationError as exc:
        print(f"Validation error: {exc}", file=sys.stderr)
        return EXIT_VALIDATION

    backend, transport = build_backend(config)
    print(f"Transport: {transport}")

    provisioning = Provisioning(
        config,
        backend,
        details,
        assume_yes=args.yes,
        skip_password_hint=args.skip_password_change_hint,
    )
    try:
        provisioning.run()
        return EXIT_OK
    except ValidationError as exc:
        print(f"\nValidation error: {exc}", file=sys.stderr)
        return EXIT_VALIDATION
    except BackendError as exc:
        # The step-by-step failure report was already printed by Provisioning.
        if not provisioning.failure_reported:
            print(f"\n{format_backend_error(exc)}", file=sys.stderr)
            print(
                "Recovery: re-run the same command (it is idempotent) or complete the",
                file=sys.stderr,
            )
            print("missing step in the Appwrite console.", file=sys.stderr)
        return EXIT_BACKEND
    except ConfigError as exc:
        # e.g. the generated-password file could not be written
        print(f"\nConfiguration error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    except Exception as exc:  # unexpected - last resort, never leak secrets
        message = scrub_secret(str(exc) or exc.__class__.__name__, config.api_key)
        print(f"\nUnexpected error: {message}", file=sys.stderr)
        return EXIT_BACKEND


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        return _run(argv)
    except KeyboardInterrupt:
        print("\nAborted by user.", file=sys.stderr)
        return EXIT_INTERRUPTED


if __name__ == "__main__":
    sys.exit(main())
