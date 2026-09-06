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
| `brand/` | The mark, persona variants, lockup, favicon. |

## The character: a Folk

A Folk is a **thread-bubble head**: a rounded square with a tail at the lower
left, and two eyes. It has no mouth. The tail is the mouth, because a folk only
ever speaks by replying in a thread.

```
M26 4H38A20 20 0 0 1 58 24V32A20 20 0 0 1 38 52H30L10 62C13 59 15.5 54 16 49.3A20 20 0 0 1 6 32V24A20 20 0 0 1 26 4Z
```

That path, in a 64×64 frame, is the whole identity. It is the same string in
`brand/*.svg`, in `folks.js` (particles sample their targets from it), and in
the inline `<symbol>`s on both pages, so the canvas silhouette and the SVG eye
overlay line up exactly.

Why this and not a Grok-style stroke: Grok's mark is one solitary line, cold
and cerebral. Folks is the opposite claim: several teammates, each with a face,
living where the team already talks. Plural, warm, social.

### Personas

Same silhouette, different eyes, one colour each. The persona is a *role*,
never a person.

| Persona | Colour | Eyes | File |
|---|---|---|---|
| Ops | plum `#7A2E86` | two bars (attentive) | `brand/persona-ops.svg` |
| Docs | marigold `#F5B31B` | two dots (curious) | `brand/persona-docs.svg` |
| Data | signal blue `#1B7BE0` | two dashes (reading) | `brand/persona-data.svg` |
| Security | coral `#F0553B` | two inward arrows (scrutinising) | `brand/persona-sec.svg` |

Plum is retained from slaude's existing brand so the two names read as one
product. A new persona gets a new eye set and a new colour, never a new head.

### Lockup

`brand/folks-lockup.svg` stacks three folks with a paper-coloured gap between
them, the way Slack stacks thread participants. The wordmark is set in
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
