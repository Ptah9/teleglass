# Teleglass

Telegram on Even G2 glasses: new message → context → reply options from an LLM →
pick with a gesture → confirm → send. One WebView serves both surfaces: the
phone (login and settings) and the glasses (a render target driven by Even Hub
containers).

**v0.6.0 — replies go out, read marks stick.** The phone signs in to Telegram
through the backend (MTProto, no Bot API stand-in), the glasses list is the
account's unread dialogs with their real messages, opening a message fetches a
real summary and three reply options, and the chosen reply is sent to Telegram
from the glasses: `SENT` is Telegram's own message id and time, `SKIP?` marks up
to that message read, and viewing a chat marks nothing. Still mock: the demo set
used before a link exists (`src/api/demo.ts`).

What is real in this version:

- the glasses list is live: unread dialogs from Telegram with their real texts
  and times, `1/N` pages through the unread messages of a chat, and the list
  refreshes on start and when the WebView comes back to the foreground;
- phone sign-in (number + code + 2FA), disconnect and delete-all run against
  the backend; the session and the keys stay there, the WebView holds only a
  bearer token;
- the backend speaks MTProto through `teleproto`: `GET /chats`,
  `GET /chats/:id/messages`, `POST /chats/:id/send`, `POST /chats/:id/read`,
  sessions in SQLite under `backend/data/`;
- a reply picked on the glasses is sent for real: `SENT` carries Telegram's
  message id and time, a retry reuses `random_id` so it cannot become a second
  message, and a refusal is an honest `OFFLINE` with a retry, never a fake
  receipt;
- read marks are server-side too: a reply or `SKIP?` marks up to that message in
  Telegram, a `QUICK REPLY` marks the whole chat, and opening a chat marks
  nothing; a failed mark comes back on the glasses instead of hiding an unread;
- the LLM speaks an OpenAI-compatible API configured by `.env`: three reply
  options and a summary for the message being answered, in the language of that
  message, with the tone from T3, cached for 24 hours; a failure is an honest
  `NO REPLIES`, never invented text;
- the full glasses UI from v0.1 (20 screens, gestures, native scrolling,
  microphone level) and its measured 27/40 px geometry;
- one state for both surfaces: `Save` in `Chats` filters the glasses list, the
  quick reply and the language reach the glasses immediately, a disconnect
  sends the glasses back to `Connect Telegram on your phone.`;
- persistence in `localStorage` (survives the Android WebView being killed);
  the API facade switches to the real backend as soon as it answers, and a
  saved link keeps the real API even when the backend is down.

## Run

```bash
npm install
npm run dev            # phone WebView (393 px mockup, fills the viewport)
npm run dev            # + ?dev=1: glasses preview and gesture buttons
npm run build          # dictionaries + types + bundle
npm run simulate       # Even Hub simulator with automation API on :9898
                       # (the dev server must already run on :5173)
npm run qr             # QR for the phone app (Local Testing on hardware)
npm run pack           # .ehpk with the SDK floor pinned (--sdk-ver)
```

On hardware the phone cannot reach `localhost`, so pin the HMR host to the
laptop's LAN address (docs `03-test/03-local-testing.md`):

```bash
HMR_HOST=192.168.1.10 npm run dev
```

Inside Even App the phone shows `PhoneApp`; the glasses show the containers. The
`?dev=1` page is the browser remote: the same buttons drive the same logic as the
gestures on the temple, plus the 576×288 preview.

## Architecture

```text
src/state/   pure glasses logic: types, reducer, mock data, text layout
src/view/    pure screen assembly: (state, dictionary) → containers
src/even/    bridge: adapter (glasses SDK or browser) + page (orchestrator)
src/api/     backend contract: client (HTTP) + demo, one facade with a health probe
src/store/   phone settings, persisted in localStorage
src/phone/   React phone surface: auth, chats, agent, settings, shared controls
src/dev/     the ?dev=1 glasses panel
src/i18n/    en/ru dictionary on i18next + react-i18next
```

- The logic knows nothing about the SDK: `reduce(state, event) → state`,
  `buildView(state, t) → containers`. Both are pure and testable without hardware.
- The same set of containers → `textContainerUpgrade` (no flicker);
  layout or list changes → `rebuildPageContainer`. `menuObject` is passed on
  every rebuild.
- Exactly one container with `isEventCapture: 1` per screen.
- A double tap on the root page calls `shutDownPageContainer(1)` —
  the system exit dialog (an Even Hub QA requirement).
- Every page is checked with the SDK's own `validateEvenHubPageContainer` before
  it is sent; menu items go through `isValidMenuItemID` / `isMenuNameWithinLimit`.
- If `createStartUpPageContainer` reports `invalid` (a page from a previous
  WebView session is still on the host), the same payload is sent as
  `rebuildPageContainer`.
- Line breaks and truncation use `@evenrealities/pretext` — the official pixel
  measurement of the firmware font. There is no character counting: 50 wide
  glyphs are 800 px, not 536.
- UI strings live in the dictionary only, and the dictionary runs on i18next:
  React screens read it through `useT()` (`react-i18next`), the glasses page
  through `makeT(lang)` (`getFixedT`, so a redraw cannot pick a language the
  phone has not applied). `{name}` is an argument, `{count}` drives the plural
  forms stored as `key_one` / `key_few` / `key_many` / `key_other`. en/ru base-key
  parity, plural categories per language, argument parity and per-key pixel
  budgets are checked by `scripts/check-i18n.mjs` (also with `pretext`) and by
  the library itself, wired into `npm run build`. Phone labels have their own
  rule: the glasses font metrics do not describe FK Grotesk Neue (its files are
  not in the repository), so a phone button is limited to 24 characters and long
  sentences are allowed to wrap.
- The glasses language is stored with `setLocalStorage` / `getLocalStorage`;
  phone settings live in `localStorage`. They are reconciled on boot, and the
  phone copy is the user's choice.

## Phone screens

`ux-webview.md` is the spec, `POLISH.md` lists what was already wrong in the
mockup. The implementation follows the spec, except where `POLISH.md` says the
mockup is a defect: the code step has a heading, the landing is one centred block
instead of a button near the top, and selected chat rows have a gap between them.

| Screen | States |
| --- | --- |
| A1 sign-in | landing, number (masked), code + resend countdown, 2FA password, link waiting + 30 s countdown, link expired, busy/connecting, five errors |
| T1 Chats | loading skeletons, empty, error + Retry, none selected, N selected, search, “select all unread” |
| T2 Agent | honest empty state, no input and no date promises |
| T3 Settings | quick reply (120 chars), tone, language, LLM (API key sent to the backend, model picker), status with words next to the dots, disconnect and delete-all sheets |

## Backend API

The WebView never talks to Telegram. The backend owns MTProto (GramJS), the
Telegram session and the LLM keys. The contract is `src/api/types.ts`; the HTTP
implementation is `src/api/client.ts`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | `{ backend, llm, checkedAt }`; also the probe that decides demo mode |
| `GET` | `/api/auth` | current step: idle / code / password / link / connected |
| `POST` | `/api/auth/phone` | `{ phone }` → code step, sets `resendAt` |
| `POST` | `/api/auth/code` | `{ phone, code }` → password or connected |
| `POST` | `/api/auth/password` | `{ password }` → connected |
| `POST` | `/api/auth/link` | fresh one-time link `{ step, url, expiresAt }` |
| `GET` | `/api/auth/link` | `pending` / `connected` / `expired` |
| `POST` | `/api/auth/logout` | drop the Telegram session |
| `DELETE` | `/api/data` | remove the session and stored data |
| `GET` | `/api/chats` | `[{ id, title, preview, unread }]` for T1 and the glasses feed |
| `GET` | `/api/chats/:id/messages` | last messages of one dialog, oldest first: `[{ id, at, text, out, media? }]` |
| `POST` | `/api/chats/:id/send` | `{ messageId, text }` → `{ id, at }`; `random_id` comes from the pair, so a retry does not duplicate; a refusal is 502 `{ error: "send" }` |
| `POST` | `/api/chats/:id/read` | `{ messageId }` marks one message (and older) read, `{}` marks the chat; both 204 and idempotent |
| `PUT` | `/api/settings` | mirror `{ lang, quickReply, tone, selectedChats, llmModel }` for the LLM |
| `POST` | `/api/llm/key` | `{ apiKey }` — the backend stores the key; the WebView never keeps it |
| `POST` | `/api/llm/replies` | `{ chatId, messageId }` → `{ summary, replies }`; a failure is 502 `{ error: "llm" }`, one request in flight per chat and 20 a minute per session is 429 `{ error: "llm" }` |
| `GET` | `/api/llm/models` | `{ models: [{ id, label }], current }` for the T3 picker |

The session token comes back as `token` and is kept in `localStorage` under
`teleglass.token`; it goes to our backend only, never to Telegram. Errors are
`{ "error": "wrongCode" | "expiredCode" | "tooMany" | "wrongPassword" | "send" | ... }`.

The LLM API key is one-way: it goes to the backend through `/api/llm/key`, the
field is cleared immediately, and nothing about the key lands in `localStorage`.
The backend keeps it AES-256-GCM-encrypted (the same key as the Telegram
session) and never returns it. A key saved from T3 wins over `LLM_API_KEY` in
`app/.env`; without either, `/api/health` says `llm: "off"` and no request is
made. Provider, model and the model list are `.env` only:

```
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=...
LLM_MODEL=deepseek-flash
LLM_MODELS=deepseek-flash,deepseek-v4-pro
```

The base URL is `VITE_API_BASE` (default: same-origin `/api`). A remote backend
needs two things: CORS headers for the WebView origin and its domain in
`app.json` → `network` (the whitelist is an Even permission check, not a CORS
bypass).

## Demo mode

On the first API call the app probes `/api/health`. If the backend does not
answer (or answers non-JSON), it switches to the labelled demo: screens work,
nothing leaves the phone, and the sign-in code is printed on screen.

- demo phone number: any 10–15 digits; code `123456`; `000000` shows the
  expired-code error; three wrong codes show "too many attempts"; any non-empty
  password passes;
- the link expires in 30 s and never fakes a confirmation. `?demo=link-connected`
  simulates the confirmation after 2 s for a screenshot;
- QA flags (never rendered in the product): `?demo=chats-empty`,
  `?demo=chats-error`, `?demo=chats-loading`, `?demo=network`,
  `?demo=status-error`, `?demo=link-connected`, `?demo=connected` (opens the
  tabs without the fake sign-in, for screenshots and quick checks);
- `?demo` (bare) forces demo mode even when a backend answers.

## Context menu (glasses demo levers)

A long press of the glasses' system menu opens the v0.1 levers — they are
mirrored by buttons on the `?dev=1` panel: language, backend down, microphone
source, Telegram connected, "phone read the chat". All of them are demo-only and
are removed before release, together with the `demo.*` keys.

## Voice: real microphone, mock transcript

`LISTENING` opens the microphone with the official `audioControl` and draws the
level of the incoming PCM chunks (16 kHz, signed 16-bit LE, mono) as the
official block ramp `▁▂▃▄▅▆▇█`; it closes the microphone on exit. The transcript
is still a mock constant: no audio leaves the glasses.

The hackathon rules say "Bring your own speech-to-text — the SDK gives you raw
microphone audio: send it to your own server (e.g. Whisper)", so recognition
will run on our backend with Whisper.

## What's next

- backend: MTProto (GramJS), LLM summary and three options, STT; then replace
  `src/api/demo.ts` with the real API, no screen changes;
- hardware checks: Cyrillic, line height, borders, the divider, the keyboard over
  the sign-in form, WebView suspension during link login;
- remove the demo levers and the `demo.*` keys before submission.

The spec and the screen map live in the team repository's `specs/` folder
(`ux-flow.md` for the glasses, `ux-webview.md` for the phone).
