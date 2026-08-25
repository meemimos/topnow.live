# Prototype reference

`../TopNow.html` is the **binding visual and behavioural reference** for the build.
It is a self-contained bundle — open it directly in a browser.

The two files here are extracted from that bundle so they can be read and diffed:

| File                 | What it is                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prototype-dom.html` | The rendered DOM with all inline styles. Every colour, font-size, padding and bevel in the design system is literally in here. This is the ground truth for issue #5 (visual fidelity). |
| `prototype-logic.js` | The prototype's component logic — copy strings, receipt derivation, ledger grouping, chart config, hit-counter markup.                                                                  |

## Important: the prototype's data is fabricated

`prototype-logic.js` builds its market with a seeded LCG (`buildMarket`, `SPECS`, `lcg`)
and hardcodes `LIVE`, `QUEUED` and `ENDED_HANDLES`. That is fine for a mockup and is
**explicitly forbidden in the product** — see "Non-negotiable" in `../docs/build-prompt.md`.

Take from the prototype: layout, type scale, bevels, colour usage, copy voice, interaction model.
Do not take: any number, any handle, any candle.

## Values the prototype uses that are NOT in the build prompt's token table

These appear throughout `prototype-dom.html` and need names in the Tailwind theme
before any screen is built (issue #4):

| Value                 | Occurrences         | Apparent role                                         |
| --------------------- | ------------------- | ----------------------------------------------------- |
| `#808080`             | 48 (as `1px solid`) | hairline rule inside wells and table cells            |
| `#555555`             | 21 (text)           | secondary / helper prose                              |
| `#9c9c9c`             | 6 (text)            | tertiary, disabled                                    |
| `#ededed`             | 8 (bg)              | alternating table row                                 |
| `#b9c8ff`             | 8 (text)            | meta text on navy title bars                          |
| `#7a5400`             | 2                   | dimmed amber (unlit meter segment)                    |
| `#0a0a0a` / `#1c1c1c` | 2                   | meter panel interior, distinct from pure `ink`        |
| `#00003f` / `#5b5bd6` | 5                   | navy bevel pair (in the prompt table, unnamed in use) |

Bevel depth also differs from the prompt: plates in the prototype use **2px** insets
(`inset -2px -2px 0 #7b7b7b, inset 2px 2px 0 #ffffff`, 15 occurrences) while the prompt
table specifies 3px. 3px is used for **buttons and navy controls** (5 + 4 occurrences).
Recommendation: `plate` = 2px, `control` = 3px. Flagged in issue #4.
