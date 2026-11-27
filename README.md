# Teleglass

Telegram on Even G2 glasses: new message → context → reply options from an LLM →
pick with a gesture → confirm → send. One WebView serves both surfaces: the
phone (login and settings) and the glasses (a render target driven by Even Hub
containers).

**v0.7.0 — voice.** The glasses microphone records, whisper.cpp on our backend
turns the recording into text, and the text goes out through `SEND?` like a typed
reply. The same recording can go out as a Telegram voice note (swipe ↑ on
`HEARD`), and an incoming voice message opens as its transcript. Recognition is
local: no audio leaves the machine, and one voice message is recognized once.
The phone microphone is not used at all.

What is real in this version:

- the glasses list is live: unread dialogs from Telegram with their real texts
  and times, `1/N` pages through the unread messages of a chat, and the list
  refreshes on start and when the WebView comes back to the foreground;
- a recording made on the glasses is recognized by whisper.cpp (16 kHz PCM →
  WAV → `/stt`), `HEARD` shows the text, and a tap sends it through `SEND?`;
- an incoming voice message is transcribed on open (Telegram download → ffmpeg →
  whisper) and cached in SQLite by `chatId + messageId`;
- swipe ↑ on `HEARD` uploads the same recording as a voice note: PCM → ffmpeg →
  Ogg Opus 48 kHz mono ~24 kbps → `messages.sendMedia` with the voice attribute;
  the temp file is removed after the upload, and the note has its own stable
  `random_id` — the text one would be deduplicated by Telegram into the text
  message sent from the same pair;
- the reply options screen now ends with three actions: `Say it (text)` (dictate,
  recognize, send through `SEND?`), `Say it (voice message)` (record and send the
  note as is, no recognition) and `Just read` (mark up to the message read and go
  back to the chats). Six rows live in the native 4-row list and scroll;
- phone sign-in (number + code + 2FA), disconnect and delete-all run against
  the backend; the session and the keys stay there, the WebView holds only a
  bearer token;
- the backend speaks MTProto through `teleproto`: `GET /chats`,
  `GET /chats/:id/messages`, `POST /chats/:id/send`, `POST /chats/:id/read`,
  `POST /chats/:id/voice`, sessions in SQLite under `backend/data/`;
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

The WebView never talks to Telegram. The backend owns MTProto (teleproto), the
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
| `GET` | `/api/chats/:id/messages` | last messages of one dialog, oldest first: `[{ id, at, text, out, media?, voice? }]`; `voice: true` marks a voice note to transcribe |
| `POST` | `/api/chats/:id/send` | `{ messageId, text }` → `{ id, at }`; `random_id` comes from the pair, so a retry does not duplicate; a refusal is 502 `{ error: "send" }` |
| `POST` | `/api/chats/:id/voice` | `{ messageId, audio }` (base64 PCM) → `{ id, at }`, a voice note; its own stable `random_id` from the pair (the text one collides); a refusal is 502 `{ error: "send" }` |
| `POST` | `/api/chats/:id/messages/:messageId/transcribe` | transcript of an incoming voice message, cached by chat + message: `{ text }` |
| `POST` | `/api/stt` | `{ audio, format: "pcm" \| "wav" }` → `{ text, durationMs }`; a dead whisper, an empty transcript or no model is 502 `{ error: "stt" }` |
| `POST` | `/api/chats/:id/read` | `{ messageId }` marks one message (and older) read, `{}` marks the chat; both 204 and idempotent |
| `PUT` | `/api/settings` | mirror `{ lang, quickReply, tone, selectedChats, llmModel }` for the LLM |
| `POST` | `/api/llm/key` | `{ apiKey }` — the backend stores the key; the WebView never keeps it |
| `POST` | `/api/llm/replies` | `{ chatId, messageId }` → `{ summary, replies }`; a failure is 502 `{ error: "llm" }`, one request in flight per chat and 20 a minute per session is 429 `{ error: "llm" }` |
| `GET` | `/api/llm/models` | `{ models: [{ id, label }], current }` for the T3 picker |

The session token comes back as `token` and is kept in `localStorage` under
`teleglass.token`; it goes to our backend only, never to Telegram. Errors are
`{ "error": "wrongCode" | "expiredCode" | "tooMany" | "wrongPassword" | "send" | "stt" | ... }`.

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

## Speech to text (whisper.cpp)

Recognition runs locally: the glasses send raw microphone PCM to our backend,
the backend talks to a whisper.cpp server on `127.0.0.1:8081`. No audio leaves
the machine. Binaries and the model live in `backend/vendor/whisper/` and are
**not in git** (`.gitignore`), so a fresh clone has to install them:

1. **Binaries** — an official `whisper.cpp` Windows x64 build
   (`whisper-bin-x64.zip`) from
   <https://github.com/ggml-org/whisper.cpp/releases>. The binaries in `vendor/`
   report `whisper.cpp version: 1.9.6`. Unpack it so that
   `backend/vendor/whisper/Release/whisper-server.exe` and the DLLs next to it
   exist.
2. **Model** — `ggml-small.bin` (465 MB) from
   <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin>
   (the file is in the `ggerganov/whisper.cpp` repository). Put it at
   `backend/vendor/whisper/ggml-small.bin`. `medium` was measured and rejected:
   three times slower on the same phrase, no better text.
3. **ffmpeg** must be in `PATH` (``ffmpeg -version``). It converts Telegram's
   Ogg/Opus into WAV for recognition and the glasses' PCM into an Ogg/Opus voice
   note. Nothing is installed by npm.
4. **Start the server** before the backend (it keeps the model in memory; the
   CLI reloads it on every call and costs 3–4 s per phrase):

   ```bash
   cd backend/vendor/whisper/Release
   ./whisper-server.exe -m ../ggml-small.bin -t 8 --host 127.0.0.1 --port 8081
   ```

5. **Backend settings** (optional, the defaults are the paths above):

   ```
   WHISPER_URL=http://127.0.0.1:8081
   WHISPER_MODEL=./vendor/whisper/ggml-small.bin
   ```

If the model is missing the backend logs `stt.modelMissing` and answers
`502 {"error":"stt"}`; if the server is not running — `stt.unavailable` and the
same `502`. The backend never crashes because of speech, and the glasses show
`HEARD — Didn't catch that.` instead of an empty screen. A transcript is never
logged; the logs carry milliseconds, audio seconds and `cached: true/false`.

Measured on this machine (Core Ultra 7 258V, 8 threads, `ggml-small.bin`):
Russian 12.8 s → 2.61 s, Russian 3.3 s → 2.14 s, English 8.6 s → 2.30 s. On a
loaded desktop the same phrases took 5.2–6.3 s, so the recognition budget scales
with the recording (12–25 s) and the screen waits with `Recognizing…` instead of
pretending to be stuck.

## Context menu (glasses demo levers)

A long press of the glasses' system menu opens the v0.1 levers — they are
mirrored by buttons on the `?dev=1` panel: language, backend down, Telegram
connected, "phone read the chat". All of them are demo-only and are removed
before release, together with the `demo.*` keys.

## Voice

`LISTENING` opens the **glasses** microphone with the official `audioControl`
(only `AudioInputSource.Glasses`: the phone microphone is never requested) and
draws the level of the incoming PCM chunks (16 kHz, signed 16-bit LE, mono) as
the official block ramp `▁▂▃▄▅▆▇█`. The recording stops when the finger is lifted,
after 2 s of silence, or at 45 s for dictation (120 s for a voice note).

- After a dictation the screen stays `LISTENING`: the microphone is closed, the
  frozen wave stays, and the footer says `recognizing…` (2–6 s). A blank screen
  is not an option; no gesture works until the answer arrives. Then `HEARD`
  shows the text: `tap` sends it through `SEND?`; `hold` records again;
  `swipe ↑` sends the same recording as a Telegram voice note. A long transcript
  scrolls with the firmware's own swipe, so there the swipe is a scroll and the
  footer says so.
- `REPLIES` lists the three LLM options, then `Say it (text)`, `Say it (voice
  message)` and `Just read`. The voice entry records and sends the note without
  recognition; a recording under 0.8 s returns to the options. `Just read` marks
  the message read (up to it, as `SKIP?` does) and goes back to the chats.
- `NO REPLIES` keeps the voice reachable: `swipe ↓` starts a dictation without
  asking the model, so a failed LLM or a missing key does not take voice away.
- Didn't catch it: `swipe ↑` still sends the recording as a voice note,
  `hold` records again, `tap` goes back to the replies.
- The 2 s silence stop belongs to dictation only: a pause inside a voice message
  is part of it, so there the recording ends on the tap (or at 120 s).
- An incoming voice message is transcribed in the background as soon as it
  appears in the feed (three at a time), so CHAT already shows the words when the
  message is opened; the header marks the text as a transcript (`· ГС` / `· voice`).
  The second opening is read from the SQLite cache, not recognized again. The
  reply options for a voice message are built from that transcript, never from
  the word `Voice message`, and the LLM is never allowed to fetch or recognize
  audio itself.
- The recording goes out as Ogg Opus (mono 48 kHz, ~24 kbps, voice profile).
  The temporary file lives in the system temp directory and is removed after the
  upload.

## What's next

- hardware checks: Cyrillic, line height, borders, the divider, the keyboard over
  the sign-in form, WebView suspension during link login, the glasses microphone
  level and the 2 s silence stop on real G2;
- remove the demo levers and the `demo.*` keys before submission.

The spec and the screen map live in the team repository's `specs/` folder
(`ux-flow.md` for the glasses, `ux-webview.md` for the phone).
