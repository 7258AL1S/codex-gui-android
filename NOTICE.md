# Third-party notices

This project itself is MIT-licensed (see `LICENSE`). The following components/derivations
matter when redistributing:

## codex-webui（MIT）

`app/` is derived from **codex-webui**. Its license and third-party notices are kept verbatim:

- `app/LICENSE` — upstream MIT license
- `app/THIRD_PARTY_NOTICES.md` — icon path data from **Lucide** (as bundled with the local
  Codex.app `lucide-react` build), fonts, and other bundled frontend dependencies

Upstream frontend dependencies (`marked`, `dompurify`, `katex`, `@xterm/xterm`, `lottie-web`,
… see `app/package.json`) keep their own licenses; they are installed from npm, not vendored.

## proto-ts/

TypeScript types generated from the **locally installed Codex CLI's** `app-server`
(its experimental type export). They are included as the protocol baseline that
`docs/FEATURES.md` and `docs/VERIFICATION.md` cite; they are generated output, not hand-written
source, and they are not a copy of any repository's source code.

## Codex CLI

This project does **not** bundle or redistribute the Codex CLI. It talks to whatever
`codex app-server` you have installed in your own Termux environment.
