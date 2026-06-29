# How per-tab Claude status works

The headline feature: each tab's status dot tells you what Claude Code is doing in that session,
so when you run several at once you can see at a glance which one needs you.

| Dot | State | Meaning |
|-----|-------|---------|
| green (glowing) | `input` | Claude is idle at an empty prompt, **waiting for your message** |
| grey | `busy` | Claude is **working** (thinking / generating / running tools) |
| amber (pulsing) | `perms` | Claude is **blocked asking for permission** — go approve it |
| dim grey | `ended` | Claude has exited; the session is back at the shell |

When a non-active tab is in `input` or `perms`, the browser tab title shows an attention counter,
e.g. `(2) GHOST.dev — terminal`.

## The mechanism

The stats backend (`stats/server.js`) polls every few seconds. For each tmux session it:

1. Runs `tmux list-panes` to see if `claude` (or `node`) is the foreground command. If not →
   `ended`.
2. Runs `tmux capture-pane -p` to read the visible screen, strips ANSI escapes, and matches it
   against three regexes:
   - `RE_PERMS` — Claude's permission prompts (`Do you want to proceed…`, `Yes, and don't ask
     again`, numbered `❯ 1. Yes`, …) → `perms`
   - `RE_BUSY` — the working spinner / token meter / `esc to interrupt` → `busy`
   - `RE_READY` — a lone empty `❯` prompt → `input`
3. Anything alive but unmatched defaults to `busy`.

## Tuning the regexes

Claude Code's spinner verbs and prompt wording change between releases, so these are **plain
constants at the top of `stats/server.js`**, easy to find and edit:

```js
const RE_PERMS = /Do you want to (?:proceed|make|create|run|allow|apply|edit|overwrite|delete)|.../i;
const RE_BUSY  = /esc to interrupt|[↓↑]\s*[\d.,]+\s*k?\s*tokens|.../;
const RE_READY = /^\s*❯\s*$/m;
```

If a new Claude version shows a state incorrectly, capture a pane (`tmux capture-pane -p -t
<session>`) during that state and add the missing phrase. It's a heuristic over the terminal
screen — there is no official API for this — so treat it as best-effort.

This also means the feature isn't Claude-specific: point the regexes at any interactive CLI agent
and the dots will track its states.
