# Teleglass

Telegram on Even G2 glasses: new message → context → reply options from an LLM →
pick with a gesture → confirm → send.

**v0.1 — the glasses UI with no connections.** Everything is mock data
(`src/state/data.ts`): six chats, two of them with four messages each, a long
message with a summary, a Russian chat for Cyrillic checks, and a chat with no
reply options (the `NO REPLIES` screen). There is no Telegram and no LLM in this
version. The one real thing is the microphone: the `LISTENING` indicator is fed
by the SDK's own PCM stream, not by an animation.

## Run

```bash
npm install
npm run dev           # debug page: 576×288 preview + gesture buttons
npm run build         # dictionaries + types + bundle
npm run simulate      # Even Hub simulator with automation API on :9898
                      # (the dev server must already run on :5173)
npm run qr            # QR for the phone app (Local Testing on hardware)
npm run pack          # .ehpk with the SDK floor pinned (--sdk-ver)
```

On hardware the phone cannot reach `localhost`, so pin the HMR host to the
laptop's LAN address (docs `03-test/03-local-testing.md`):

```bash
HMR_HOST=192.168.1.10 npm run dev
```

The glasses (or the simulator) show the screens; the browser page is a remote
control: the same buttons drive the same logic as the gestures on the temple.

## Architecture

```text
src/state/   pure logic: types, reducer, mock data, text layout
src/view/    pure screen assembly: (state, dictionary) → containers
src/even/    bridge: adapter (glasses SDK or browser) + page (orchestrator)
src/i18n/    en/ru dictionary + minimal ICU MessageFormat
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
- UI strings live in the dictionary only. en/ru parity, argument parity, brace
  balance and per-key pixel budgets are checked by `scripts/check-i18n.mjs`
  (also with `pretext`), wired into `npm run build`.
- The UI language is stored with `setLocalStorage` / `getLocalStorage`, so it
  survives a WebView restart on Android.

## Context menu (demo levers)

A long press of the glasses' system menu opens three items — they are mirrored
by buttons on the browser panel:

1. **Language** — switch the UI between en and ru (persisted in host storage);
2. **Backend** — "backend is down": sending falls into `OFFLINE`, the quick
   reply ends up "not sent";
3. **Mic** — the source of the `LISTENING` recording: glasses or phone
   (`AudioInputSource`).

These are tools for exercising every state without hardware. They are removed
before release, together with the `demo.*` keys.

## Voice in v0.1: real microphone, mock transcript

`LISTENING` opens the microphone with the official `audioControl` and draws the
level of the incoming PCM chunks (16 kHz, signed 16-bit LE, mono) as the
official block ramp `▁▂▃▄▅▆▇█`; it closes the microphone on exit. The transcript
is still a mock constant: no audio leaves the glasses.

The hackathon rules say "Bring your own speech-to-text — the SDK gives you raw
microphone audio: send it to your own server (e.g. Whisper)", so recognition
will run on our backend with Whisper. Demo rules for the mock transcript: a hold
shorter than 0.8 s → "Didn't catch that.", longer than 4 s → a long transcript
(so the native scrolling of the body can be tried), otherwise — a ready reply.

## What's next

- backend: MTProto (GramJS), LLM summary and three options, STT;
- phone WebView: Telegram login, chat selection, tone, draft text;
- hardware checks: Cyrillic, line height, borders and the divider.

The spec and the screen map live in the team repository's `hack/` folder
(`ux-flow.md` is the source of truth for screens and gestures).
