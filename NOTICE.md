# NOTICE

Codex GUI for Android
Copyright 2026 7258AL1S (Arisu)

This product is licensed under the Apache License, Version 2.0 (see `LICENSE`).
It also contains or derives from the third-party material listed below; the notices of those
parts are reproduced here because they must be preserved on redistribution.

---

## 1. Codex CLI（Apache-2.0）—— `proto-ts/`

`proto-ts/` contains **TypeScript types generated from the locally installed Codex CLI's
`app-server` type export**. That generated interface surface derives from
[openai/codex](https://github.com/openai/codex), which is licensed under the **Apache License
2.0** and ships a `NOTICE` file. Its contents are reproduced verbatim below, as required by
Apache-2.0 §4(d):

```
OpenAI Codex
Copyright 2025 OpenAI

This project includes code derived from [Ratatui](https://github.com/ratatui/ratatui), licensed under the MIT license.
Copyright (c) 2016-2022 Florian Dehau
Copyright (c) 2023-2025 The Ratatui Developers
```

**This repository does not bundle or redistribute the Codex CLI itself.** It talks to whatever
`codex app-server` you have installed in your own Termux environment; the CLI keeps its own
license, and no part of this project grants rights to it.

## 2. codex-webui（MIT）—— `app/`

`app/`（the bridge, the frontend, and the self-built scheduler）is **derived from codex-webui**,
which is licensed under the MIT License. Its license and third-party notices are kept verbatim:

- `app/LICENSE` — upstream MIT license (Copyright (c) 2026 lezi-fun)
- `app/THIRD_PARTY_NOTICES.md` — icon path data from **Lucide** (as bundled with the local
  Codex.app `lucide-react` build), fonts, and other bundled frontend dependencies

That MIT text applies to the derived portion; it is not replaced by this project's Apache-2.0
license, and it must be kept if you redistribute `app/`.

## 3. 前端依赖（各自许可证）

The frontend loads its dependencies from npm (`app/package.json`): `marked`, `dompurify`,
`katex`, `@xterm/xterm`, `@xterm/addon-fit`, `lottie-web`, `jsdom`, `ws`. They are installed by
`npm install` and keep their own licenses; nothing of theirs is vendored into this repository
except the built bundle `app/public/app.bundle.js`, which is generated from `app/public/*.js`.

## 4. Android / Termux 平台组件

The APK is built against Google's Android platform (`android.jar`) and uses only the public
Android SDK APIs. `android/` is original code; it does not embed AndroidX or any Android
support library (see `docs/VERIFICATION.md` E141 for why that matters here).
