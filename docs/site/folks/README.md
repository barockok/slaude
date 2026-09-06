# Folks — marketing surface

**Folks** is the marketing name for slaude. The name changes on the door only:
the package, the CLI, every `SLAUDE_*` variable, the DB schema, and the docs
keep the name `slaude`. Nothing under `src/` references Folks.

This directory is static HTML passed through by `docs/site/build.mjs` into
`_site/folks/`. It does not use the docs shell; `folks.css` and `folks.js` are
self-contained.

| File | What it is |
|---|---|
| `index.html` | Landing page: hero, "what a folk is made of", personas roll-call, gateway/node fleet, thread mock, install. |
| `login.html` | Operator-panel sign-in. Design prototype for the OIDC entry point (`GET /panel/auth/login`); the `data-demo="1"` attribute on the button keeps it from navigating so the animation can be previewed. Drop the attribute when wiring it into the panel. |
| `folks.css` | Page styles. Warm paper canvas, hairline borders, 12px cards, one filled button colour. |
| `folks.js` | `FolksMark` (eye tracking), `Constellation` (particles), `Fleet` (wires and packets), and page wiring. No dependencies. |
| `brand/` | The mark in plum, ink, and paper; four persona heads; lockup; favicon; and `gen.py`, which generates all of them from one geometry. |

## The mark: three folks

The Folks mark is **three round heads, one fill, overlapping**: a large one at
the back, a medium one at the left, a small one in front. Each head has its own
eyes, and the eyes are the whole personality:

| Head | Position | Eyes | Temperament |
|---|---|---|---|
| back | large, upper right | two solid triangles pointing at each other | sharp, fierce |
| left | medium, left | two dashes | steady |
| front | small, bottom centre | two dots | curious |

No mouths. Nearer heads are separated from the ones behind by a thin gap of the
ground colour, so the overlap reads as depth without any shading. There is no
gradient anywhere. That is deliberate: the 3D read comes from the silhouette and
the overlap, the way Grok's pebble reads as an object with a single flat fill.

The geometry lives once, in `brand/gen.py`. Heads are circles in a 64-frame:

```
back   c(40,27) r19    left   c(21,33) r14    front  c(31,45) r11
```

Standalone files cut the gaps and eyes with a mask, so the SVG is transparent
there and works on any ground (`folks-mark.svg` plum, `folks-mark-ink.svg`,
`folks-mark-paper.svg` for dark grounds). The inline `<symbol>`s paint gaps and
eyes in the CSS variable `--cut` instead, set to the surface the mark sits on,
so the eyes can be animated. Run `python3 brand/gen.py brand brand` after any
change and paste the emitted `_symbols.html` into both pages' hidden `<defs>`.

### Eyes follow the cursor

On the landing hero and the panel sign-in page the mark is inlined (not a
`<use>`, the eye groups must be reachable) and `FolksMark` in `folks.js`
drives it. Each head aims its eyes at the pointer **from its own eye centre**,
so the three gazes converge on the cursor rather than moving in lockstep. The
offset saturates at about one mark-width away, and each head blinks on its own
clock. Reduced-motion renders the resting state.

### Personas

A persona is one head, centred, with its eye set. Same body, different eyes,
one colour. The persona is a *role*, never a person.

| Persona | Colour | Eyes | File · symbol |
|---|---|---|---|
| Ops | plum `#7A2E86` | two bars | `brand/persona-ops.svg` · `#folk-ops` |
| Docs | marigold `#F5B31B` | two dots | `brand/persona-docs.svg` · `#folk-docs` |
| Data | signal blue `#1B7BE0` | two dashes | `brand/persona-data.svg` · `#folk-data` |
| Security | coral `#F0553B` | two triangles facing each other | `brand/persona-sec.svg` · `#folk-sec` |

The mark carries three of the four eye sets; Ops (bars) is the one it leaves
out. A new persona is a new eye set in `eye_shapes()` and a new colour.

### Lockup and favicon

`brand/folks-lockup.svg` is the mark plus the word set in Bricolage Grotesque
700. `brand/favicon.svg` is the mark on a rounded paper tile.

## Motion

Three animations, all built on the same idea borrowed from constellation-style
particle systems: tiny outlined triangles that carry meaning by where they go.

1. **FolksMark** (hero, sign-in). The three-head mark, inlined; every head's
   eyes follow the cursor from their own socket and blink on their own clock.
2. **Roll-call** (personas). ~1100 outlined triangles form one round head,
   then burst outward and re-form with the next persona's colours and eyes.
   One runtime, many folks, shown rather than said. Auto-cycles every 4.2s;
   clicking a row selects.
3. **Fleet** (gateway and node mode). Wires are measured from the DOM so the
   diagram reflows; a marigold packet leaves Slack for the gateway, the gateway
   picks a node, the node lights up and types, a blue reply travels back, and
   it turns coral for the last leg into Slack (the approval card).

The sign-in page reuses FolksMark on a dark ground in the paper finish.

`prefers-reduced-motion` renders every scene in its settled state and stops the
loops after one frame.

## Type

Display: Bricolage Grotesque (700, width axis at 96). Body: Figtree. Code and
labels: JetBrains Mono. Loaded from Google Fonts with system fallbacks.

## Preview

```sh
bun run docs && python3 -m http.server -d docs/site/_site
# open http://localhost:8000/folks/  and  /folks/login.html
```
