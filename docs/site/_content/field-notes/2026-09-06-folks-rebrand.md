---
title: Folks — a marketing name over slaude, and the character that carries it
description: Why the product got a second name, why the code did not, and how the Folk mark, the persona system, and the three particle scenes were designed.
---

# Folks — a marketing name over slaude

**Date:** 2026-09-06
**Status:** shipped as a static surface under `docs/site/folks/`

## Decision

slaude grew from "one container, one persona" into a gateway-and-node fleet
that runs several personas in one workspace. The name `slaude` is a portmanteau
that explains the engine (Slack × Claude) and nothing about the product a team
sees. **Folks** does: it is what you call the people you work with, and it is
plural.

The rename is marketing-only. `slaude` stays the package name, the CLI, every
`SLAUDE_*` variable, the schema, and the documentation. Two reasons:

1. **Renames leak.** Env var names are in operators' secret stores and compose
   files. A code rename is a breaking change for every deploy for no runtime
   benefit.
2. **Two names, two audiences.** Folks is for the page someone reads before
   they decide. slaude is for the terminal after. The footer of the landing
   page says exactly that, so nobody is surprised when `slaude init` is the
   first command.

## The character

The brief was "a character logo like Grok, but think differently". Grok's mark
is a single stark stroke: solitary and cerebral. The opposite claim is what
Folks is: several teammates, each with a face, in the place where the team
already talks.

So a **Folk** is a thread-bubble head. A rounded square with a tail at the
lower left, and two eyes. **No mouth: the tail is the mouth.** A folk only ever
speaks by replying in a thread, which is also the runtime's actual rule (no raw
streaming; every reply goes through the Slack MCP tool).

One path in a 64×64 frame is the whole identity. Personas share the head and
differ only in eyes and colour: Ops (plum, bars), Docs (marigold, dots), Data
(blue, dashes), Security (coral, inward arrows). Plum is kept from the
existing slaude palette so the two names read as one product. A persona is a
role, never a person.

## Motion

Two references were used and deliberately crossed. One is a warm, paper-white,
illustration-first system with round character marks in thin circles and
springy 200ms motion. The other is a pure-black system whose only image is a
constellation of thousands of tiny outlined triangles forming a shape.

Folks takes the canvas, cards, and character discipline from the first and the
particle idea from the second, then puts the triangles on paper in the persona
colours. Three scenes, one engine:

- **Assembly**: the hero folk forms from ~1100 triangles that fly in and settle.
  Outline particles are over-weighted so the silhouette is crisp.
- **Roll-call**: the same field bursts and re-forms as the next persona, eyes
  swap. The "one runtime, many folks" pitch, shown instead of stated.
- **Fleet**: packets travel Slack → gateway → node → back along wires measured
  from the DOM, and the receiving node lights up. Gateway and node mode in one
  glance.

The login page reuses Assembly on black and adds an orbit mode for the
redirect wait, since the panel is an OIDC relying party and the page has one
button.

## What was not done

- No change under `src/`, no env rename, no CLI alias. Adding a `folks` alias
  to the CLI is cheap and reversible; it is left for a separate decision.
- The login page is a design prototype at `docs/site/folks/login.html`. The
  live panel still redirects straight to the provider from `/panel/auth/login`.
  Wiring the prototype in means serving it before that redirect and removing
  the `data-demo` attribute.
- Docs nav and README still lead with slaude. Whether the docs landing page
  should carry the Folks lockup is a follow-up.
