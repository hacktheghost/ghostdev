# File explorer

A built-in file manager that slides in as a **side panel** next to your terminal (toggle it with
the folder icon in the top bar). It's there so you can manage files without leaving the browser —
upload a dataset, grab a log, drop in a config, fix a typo in a file.

## What it can do

- **Browse** folders (breadcrumb navigation, click a path segment to jump).
- **Upload** — click *Upload* or drag & drop files onto the panel.
- **Download** a file, or **download from a URL** — paste a link and the server fetches it straight
  into the current folder.
- **New folder**, **rename**, **delete** (files and folders).
- **View / edit** text files in a built-in editor; preview images inline.

## Scope & safety

The explorer is **confined to a single root directory** (`GHOSTDEV_FILES_ROOT`, default = the app
user's home). Every API path is normalized and checked so requests can't traverse outside that root
(`../` is neutralized).

> This does **not** add new privilege: the terminal already gives the same user a full shell, so the
> file manager is a convenience over access you already have. Scope the account accordingly and keep
> the app behind auth (see [SECURITY.md](SECURITY.md)).

| Variable | Default | Effect |
|---|---|---|
| `GHOSTDEV_FILES_ENABLED` | `true` | Set `false` to hide the panel and disable the `/api/fs/*` endpoints entirely |
| `GHOSTDEV_FILES_ROOT` | app user's home | Directory the explorer is confined to |
| `GHOSTDEV_FILES_READONLY` | `false` | `true` allows browse/download but blocks every write (upload, rename, delete, edit, mkdir, URL fetch) |

## API (proxied under `/api/`)

| Endpoint | Method | Body / query |
|---|---|---|
| `/fs/list` | GET | `?path=<rel>` |
| `/fs/read` | GET | `?path=<rel>&dl=1` (force download) |
| `/fs/upload` | POST | `{ path, name, b64 }` |
| `/fs/save` | POST | `{ path, content }` |
| `/fs/mkdir` | POST | `{ path, name }` |
| `/fs/rename` | POST | `{ path, to }` |
| `/fs/delete` | POST | `{ path }` |
| `/fs/fetch-url` | POST | `{ path, url }` — http/https only, follows redirects |

Upload bodies are base64 JSON (binary-safe, no multipart). nginx is configured with
`client_max_body_size 256m` for `/api/`; raise it (and `MAX_UPLOAD` in `stats/server.js`) if you
need bigger uploads. URL downloads stream to disk and aren't bound by that limit.
