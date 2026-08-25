# Silkscreen

Self-hosted rather than loaded from Google Fonts: a third-party font host is a
request every visitor makes to someone else, and a layout shift when it is slow.
An e2e test asserts every font request is same-origin.

Four faces, 23KB total — 400 and 700, each split latin / latin-ext, with the
`unicode-range` declarations in `src/app/globals.css` so the extended subset is
only fetched when a page actually needs it.

Extracted from the `TopNow.html` prototype bundle, which sourced them from
Google Fonts.

## Licence

Silkscreen by Jason Kottke, licensed under the SIL Open Font License 1.1.
https://fonts.google.com/specimen/Silkscreen — https://openfontlicense.org/

The OFL permits redistribution and self-hosting. The font is not sold on its
own and is not bundled into a product whose primary purpose is the font.
