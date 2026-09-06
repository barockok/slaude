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
| `folks.js` | The particle engine (`Constellation`, `Fleet`) and page wiring. No dependencies. |
| `brand/` | The 3D mark (plum and ink finishes), a flat single-colour fallback, persona variants, lockup, favicon, and `gen.py`, which generates all of them from one geometry. |

## The character: a Folk

A Folk is a **thread-bubble head**: a wide rounded square with a heavy comma
tail at the lower left, and two eyes. It has no mouth. The tail is the mouth,
because a folk only ever speaks by replying in a thread.

```
M22 5H42A17 17 0 0 1 59 22V30A17 17 0 0 1 42 47H29C25 52.5 18.5 58.5 10.5 61.5C7.5 62.6 6.6 60.8 8.4 58.6C11.2 55.2 13.8 51 14.8 45.4A17 17 0 0 1 5 30V22A17 17 0 0 1 22 5Z
```

That path, in a 64×64 frame, is the whole identity. It is the same string in
`brand/gen.py` (which writes every SVG), in `folks.js` (particles sample their
targets from it), and in the inline `<symbol>`s on both pages, so the canvas
silhouette and the SVG eye overlay line up exactly.

### The 3D finish

The mark is rendered as a sculpted object, not a flat glyph, so it sits in the
same weight class as the app icons around it. Everything is vector; nothing is
a bitmap. One lighting rig, applied by `gen.py`:

- **Extrusion**: eight stacked copies of the silhouette stepping toward the
  lower right in the finish's side colour, so the body has thickness.
- **Lit face**: a top-to-bottom gradient from the finish's light tint through
  its base to its dark shade, with a radial specular at upper left.
- **Rim light**: a 1px inner stroke, bright at the top edge, fading at the sides.
- **Ambient occlusion**: a dark band along the bottom third of the face where
  the body meets the tail.
- **Recessed eyes**: a socket gradient (dark at top, lifting at the bottom), a
  bevel lip below each socket, an inner top shadow, and a single glint.
- **Ground shadow** on standalone files only; inline symbols omit it.

A finish is a six-colour ramp: light, base, dark, side, eye-top, eye-bottom.
`plum` is the brand mark. `ink` is the monochrome finish for dark-only or
Grok-adjacent contexts. Persona finishes are below. To add one, add a ramp to
`FINISH` and run `python3 brand/gen.py brand brand`; paste the emitted
`_symbols.html` into the hidden `<defs>` of both pages.

Why a bubble and not a Grok-style stroke: Grok's mark is one solitary line,
cold and cerebral. Folks is the opposite claim: several teammates, each with a
face, living where the team already talks. Plural, warm, social. The 3D
treatment borrows only Grok's *weight*: the object feels machined, not drawn.

`folks-mark-flat.svg` is the single-colour fallback for print, embroidery, and
monochrome favicons. It is the only flat rendering; do not flatten the 3D mark
by hand.

### Personas

Same silhouette, different eyes, one colour each. The persona is a *role*,
never a person.

| Persona | Colour | Eyes | File |
|---|---|---|---|
| Ops | plum, base `#7A2E86` | two bars (attentive) | `brand/persona-ops.svg` · symbol `#folk-plum` |
| Docs | marigold, base `#F5B31B` | two dots (curious) | `brand/persona-docs.svg` · `#folk-marigold` |
| Data | signal blue, base `#1B7BE0` | two dashes (reading) | `brand/persona-data.svg` · `#folk-blue` |
| Security | coral, base `#F0553B` | two inward arrows (scrutinising) | `brand/persona-sec.svg` · `#folk-coral` |

Plum is retained from slaude's existing brand so the two names read as one
product. A new persona gets a new eye set and a new colour, never a new head.

### Lockup

`brand/folks-lockup.svg` stacks three 3D folks with a paper-coloured gap between
them, the way Slack stacks thread participants. The gap is paper, so use the
lockup on light grounds; on dark grounds use a single mark plus the wordmark. The wordmark is set in
Bricolage Grotesque 700 with the mark to its left; the rendered form lives in
`.wordmark` in `folks.css` rather than as an SVG so it inherits theme colours.

## Motion

Three animations, all built on the same idea borrowed from constellation-style
particle systems: tiny outlined triangles that carry meaning by where they go.

1. **Assembly** (hero). ~1100 triangles drift in from outside the frame and
   settle into the Folk. 45% of them sit on the outline so the silhouette reads
   crisp. The whole field breathes by about 1%; the pointer repels particles
   and the eyes follow it.
2. **Roll-call** (personas). The same field bursts outward and re-forms in the
   next persona's colours; the SVG eyes swap. One runtime, many folks, shown
   rather than said. Auto-cycles every 4.2s; clicking a row selects.
3. **Fleet** (gateway and node mode). Wires are measured from the DOM so the
   diagram reflows; a marigold packet leaves Slack for the gateway, the gateway
   picks a node, the node lights up and types, a blue reply travels back, and
   it turns coral for the last leg into Slack (the approval card).

The login page reuses Assembly on a dark ground and adds **orbit**: when the
sign-in button is pressed the field collapses into a slowly turning ring for
as long as the identity-provider redirect is in flight.

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
