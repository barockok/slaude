/*
 * Folks — particle scenes.
 *
 * One engine, three uses:
 *   1. Assembly  (hero)     — a thousand outlined triangles drift in and settle
 *                             into the silhouette of a Folk. Pointer repels.
 *   2. Roll-call (personas) — the same field scatters and re-forms as the next
 *                             persona; colour and eyes change, silhouette stays.
 *   3. Fleet     (gateway)  — packets travel Slack → gateway → node along
 *                             wires measured from the DOM; the node that
 *                             receives one lights up and "types".
 *
 * The login page reuses Assembly and adds an orbit mode (the field collapses
 * into a ring while the identity provider redirect is in flight).
 *
 * Everything is plain Canvas 2D + a little SVG. No libraries.
 */

(() => {
  "use strict";

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* The Folk silhouette, in its 64×64 frame. Same path as brand/folks-mark.svg. */
  const FOLK_PATH =
    "M26 4H38A20 20 0 0 1 58 24V32A20 20 0 0 1 38 52H30L10 62C13 59 15.5 54 16 49.3A20 20 0 0 1 6 32V24A20 20 0 0 1 26 4Z";

  /* Eye sets, in the same 64-frame. The sampler cuts these out of the field so the
     eyes read as negative space and the SVG overlay paints them solid. */
  const EYE_SHAPES = {
    bars:   (c) => { c.roundRect(23, 21, 5, 13, 2.5); c.roundRect(36, 21, 5, 13, 2.5); },
    dots:   (c) => { c.moveTo(29, 27); c.arc(25.5, 27, 3.4, 0, Math.PI * 2); c.moveTo(42, 27); c.arc(38.5, 27, 3.4, 0, Math.PI * 2); },
    dash:   (c) => { c.roundRect(21, 25, 9, 4, 2); c.roundRect(34, 25, 9, 4, 2); },
    arrows: (c) => { c.moveTo(21, 23); c.lineTo(29, 27); c.lineTo(21, 31); c.closePath(); c.moveTo(43, 23); c.lineTo(35, 27); c.lineTo(43, 31); c.closePath(); },
  };

  const PALETTES = {
    ops:  ["#7a2e86", "#7a2e86", "#a44db3", "#f5b31b", "#1b7be0", "#17141f"],
    docs: ["#f5b31b", "#f5b31b", "#f7c752", "#f0553b", "#7a2e86", "#17141f"],
    data: ["#1b7be0", "#1b7be0", "#4d9cec", "#f5b31b", "#7a2e86", "#17141f"],
    sec:  ["#f0553b", "#f0553b", "#f47a65", "#f5b31b", "#1b7be0", "#17141f"],
    night:["#b25ec0", "#7a2e86", "#f5b31b", "#1b7be0", "#f0553b", "#f7f5f2"],
  };

  /* ------------------------------------------------------------------ *
   * Constellation
   * ------------------------------------------------------------------ */

  class Constellation {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{count?:number, colors:string[], eyes?:SVGElement, repel?:boolean, dark?:boolean}} opts
     */
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.count = opts.count ?? (innerWidth < 700 ? 620 : 1100);
      this.colors = opts.colors;
      this.eyes = opts.eyes ?? null;
      this.eyeSet = opts.eyeSet ?? "bars";
      this.repel = opts.repel ?? true;
      this.parts = [];
      this.pointer = { x: -1e9, y: -1e9 };
      this.mode = "shape"; // "shape" | "orbit"
      this.t = 0;
      this.stiff = 0; // spring stiffness ramps from 0 → 1 after a (re)target
      this.path = new Path2D(FOLK_PATH);
      this.frame = { s: 1, ox: 0, oy: 0 };
      this.raf = 0;
      this.visible = true;

      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
      this.resize(true);

      if (this.repel) {
        const host = canvas.parentElement;
        host.addEventListener("pointermove", (e) => {
          const r = canvas.getBoundingClientRect();
          this.pointer.x = e.clientX - r.left;
          this.pointer.y = e.clientY - r.top;
          this.look(e.clientX, e.clientY);
        });
        host.addEventListener("pointerleave", () => {
          this.pointer.x = this.pointer.y = -1e9;
          this.look();
        });
      }

      // Don't burn a core for a scene that is scrolled away.
      new IntersectionObserver((es) => {
        this.visible = es[0].isIntersecting;
        if (this.visible && !this.raf) this.loop();
      }).observe(canvas);

      this.loop();
    }

    resize(first = false) {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      this.w = r.width;
      this.h = r.height;
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Fit the 64-frame like SVG `meet`, so the eye overlay lines up exactly.
      const s = Math.min(this.w, this.h) / 64;
      this.frame = { s, ox: (this.w - 64 * s) / 2, oy: (this.h - 64 * s) / 2 };
      this.retarget(first ? "spawn" : "keep");
    }

    /** Sample target points from the silhouette. Edges get extra weight so the outline reads crisp. */
    sample() {
      const { s, ox, oy } = this.frame;
      const off = document.createElement("canvas");
      const G = 128; // sampling grid over the 64-frame
      off.width = off.height = G;
      const c = off.getContext("2d");
      c.setTransform(G / 64, 0, 0, G / 64, 0, 0);
      c.fillStyle = "#000";
      c.fill(this.path);
      // Punch the eyes out, with a little margin so the outline reads.
      const cut = EYE_SHAPES[this.eyeSet];
      if (cut) {
        c.globalCompositeOperation = "destination-out";
        c.lineWidth = 1.6;
        c.beginPath();
        cut(c);
        c.fill();
        c.stroke();
        c.globalCompositeOperation = "source-over";
      }
      const a = c.getImageData(0, 0, G, G).data;
      const inside = (x, y) => x >= 0 && y >= 0 && x < G && y < G && a[(y * G + x) * 4 + 3] > 100;
      const fill = [];
      const edge = [];
      for (let y = 0; y < G; y++) {
        for (let x = 0; x < G; x++) {
          if (!inside(x, y)) continue;
          const onEdge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
          (onEdge ? edge : fill).push([x, y]);
        }
      }
      const toPx = ([x, y]) => ({
        x: ox + ((x + 0.5 + (Math.random() - 0.5) * 0.9) / G) * 64 * s,
        y: oy + ((y + 0.5 + (Math.random() - 0.5) * 0.9) / G) * 64 * s,
      });
      const pts = [];
      // ~45% of the field lives on the outline.
      const nEdge = Math.round(this.count * 0.45);
      for (let i = 0; i < nEdge; i++) pts.push(toPx(edge[(i * 7919) % edge.length]));
      for (let i = pts.length; i < this.count; i++) pts.push(toPx(fill[Math.floor(Math.random() * fill.length)]));
      return pts;
    }

    /**
     * @param {"spawn"|"keep"|"scatter"} how
     *   spawn   — particles are born far out and fly in (first paint)
     *   keep    — positions stay, only targets move (resize)
     *   scatter — burst outward, then re-form (persona change)
     */
    retarget(how) {
      const pts = this.sample();
      const cx = this.w / 2;
      const cy = this.h / 2;
      const R = Math.max(this.w, this.h) * 0.9;
      if (this.parts.length !== pts.length) {
        this.parts = pts.map(() => ({ x: cx, y: cy, vx: 0, vy: 0, tx: 0, ty: 0, r: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.06, sz: 2.2 + Math.random() * 2.8, c: 0, ph: Math.random() * Math.PI * 2 }));
        how = how === "keep" ? "spawn" : how;
      }
      this.parts.forEach((p, i) => {
        p.tx = pts[i].x;
        p.ty = pts[i].y;
        p.c = this.colors[i % this.colors.length];
        if (how === "spawn") {
          const a = Math.random() * Math.PI * 2;
          const d = R * (0.6 + Math.random() * 0.8);
          p.x = cx + Math.cos(a) * d;
          p.y = cy + Math.sin(a) * d;
          if (REDUCED) { p.x = p.tx; p.y = p.ty; }
        } else if (how === "scatter") {
          const a = Math.atan2(p.y - cy, p.x - cx) + (Math.random() - 0.5) * 1.2;
          const k = 6 + Math.random() * 10;
          p.vx += Math.cos(a) * k;
          p.vy += Math.sin(a) * k;
        }
      });
      this.stiff = how === "keep" ? 1 : 0;
      this.mode = "shape";
    }

    setPalette(colors) {
      this.colors = colors;
      this.parts.forEach((p, i) => (p.c = colors[i % colors.length]));
    }

    /** Persona switch: burst, then re-form in the new colours. */
    morph(colors, eyeSet) {
      this.colors = colors;
      if (eyeSet) this.eyeSet = eyeSet;
      this.retarget(REDUCED ? "keep" : "scatter");
    }

    /** Collapse the field into a slowly turning ring (login redirect in flight). */
    orbit() {
      this.mode = "orbit";
      this.stiff = 0;
    }

    /** Eyes follow the pointer, a couple of frame units at most. */
    look(cx, cy) {
      if (!this.eyes) return;
      if (cx == null) { this.eyes.style.setProperty("--lx", "0px"); this.eyes.style.setProperty("--ly", "0px"); return; }
      const r = this.canvas.getBoundingClientRect();
      const dx = (cx - (r.left + r.width / 2)) / r.width;
      const dy = (cy - (r.top + r.height / 2)) / r.height;
      const m = Math.max(2, r.width * 0.02);
      this.eyes.style.setProperty("--lx", `${Math.max(-1, Math.min(1, dx * 2)) * m}px`);
      this.eyes.style.setProperty("--ly", `${Math.max(-1, Math.min(1, dy * 2)) * m}px`);
    }

    step() {
      const { ctx, w, h } = this;
      this.t += 1 / 60;
      this.stiff = Math.min(1, this.stiff + 1 / 90);
      const k = 0.012 + 0.03 * this.stiff;
      const damp = 0.88;
      const px = this.pointer.x;
      const py = this.pointer.y;
      const rr = Math.min(w, h) * 0.13;
      const cx = w / 2;
      const cy = h / 2;
      const ringR = Math.min(w, h) * 0.3;

      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      for (const p of this.parts) {
        let tx = p.tx;
        let ty = p.ty;
        if (this.mode === "orbit") {
          const a = p.ph + this.t * 0.9;
          const r = ringR + Math.sin(p.ph * 3 + this.t * 2) * ringR * 0.06;
          tx = cx + Math.cos(a) * r;
          ty = cy + Math.sin(a) * r;
        } else {
          // Breathe: the whole silhouette swells by ~1% on a slow cycle.
          const b = 1 + Math.sin(this.t * 1.1 + p.ph * 0.2) * 0.008;
          tx = cx + (p.tx - cx) * b;
          ty = cy + (p.ty - cy) * b;
        }
        p.vx = (p.vx + (tx - p.x) * k) * damp;
        p.vy = (p.vy + (ty - p.y) * k) * damp;
        if (this.repel) {
          const dx = p.x - px;
          const dy = p.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 1;
            const f = (1 - d / rr) * 2.2;
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
          }
        }
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.spin + (Math.abs(p.vx) + Math.abs(p.vy)) * 0.02;

        // Outlined triangle, the Dala particle, but drawn in the persona's colours.
        const s = p.sz;
        const cos = Math.cos(p.r);
        const sin = Math.sin(p.r);
        ctx.strokeStyle = p.c;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = (i * 2 * Math.PI) / 3;
          const vx = Math.cos(a) * s;
          const vy = Math.sin(a) * s;
          const X = p.x + vx * cos - vy * sin;
          const Y = p.y + vx * sin + vy * cos;
          i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

    loop() {
      if (!this.visible) { this.raf = 0; return; }
      this.step();
      if (REDUCED && this.stiff >= 1 && this.mode === "shape") { this.raf = 0; return; } // one settled frame is enough
      this.raf = requestAnimationFrame(() => this.loop());
    }
  }

  /* ------------------------------------------------------------------ *
   * Fleet: wires + packets over DOM nodes
   * ------------------------------------------------------------------ */

  class Fleet {
    /** @param {HTMLElement} stage */
    constructor(stage) {
      this.stage = stage;
      this.svg = stage.querySelector("svg.wires");
      this.src = stage.querySelector(".src");
      this.hub = stage.querySelector(".hub");
      this.nodes = [...stage.querySelectorAll(".node")];
      this.packets = [];
      this.t = 0;
      this.next = 0.4;
      this.layout();
      new ResizeObserver(() => this.layout()).observe(stage);
      this.visible = true;
      new IntersectionObserver((es) => {
        this.visible = es[0].isIntersecting;
        if (this.visible && !this.raf) this.loop();
      }).observe(stage);
      if (REDUCED) { this.drawStatic(); return; }
      this.loop();
    }

    center(el) {
      const r = el.getBoundingClientRect();
      const s = this.stage.getBoundingClientRect();
      return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2, w: r.width, h: r.height };
    }

    layout() {
      const W = this.stage.clientWidth;
      const H = this.stage.clientHeight;
      const narrow = W < 640;
      const place = (el, x, y) => { el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.transform = "translate(-50%, -50%)"; };
      if (narrow) {
        place(this.src, W / 2, 40);
        place(this.hub, W / 2, H * 0.36);
        this.nodes.forEach((n, i) => place(n, W / 2, H * 0.6 + i * 80));
      } else {
        place(this.src, W * 0.12, H / 2);
        place(this.hub, W * 0.45, H / 2);
        const n = this.nodes.length;
        this.nodes.forEach((el, i) => place(el, W * 0.82, H / 2 + (i - (n - 1) / 2) * 110));
      }
      this.wires();
    }

    /** Each wire is a cubic from A to B; we keep the control points to walk packets along it. */
    wires() {
      const S = this.center(this.src);
      const Hb = this.center(this.hub);
      const narrow = this.stage.clientWidth < 640;
      const curve = (A, B) => {
        const ax = narrow ? A.x : A.x + A.w / 2;
        const ay = narrow ? A.y + A.h / 2 : A.y;
        const bx = narrow ? B.x : B.x - B.w / 2;
        const by = narrow ? B.y - B.h / 2 : B.y;
        const c1 = narrow ? { x: ax, y: ay + (by - ay) * 0.5 } : { x: ax + (bx - ax) * 0.5, y: ay };
        const c2 = narrow ? { x: bx, y: ay + (by - ay) * 0.5 } : { x: ax + (bx - ax) * 0.5, y: by };
        return { a: { x: ax, y: ay }, c1, c2, b: { x: bx, y: by } };
      };
      this.in = curve(S, Hb);
      this.out = this.nodes.map((n) => curve(Hb, this.center(n)));
      const d = (c) => `M${c.a.x} ${c.a.y}C${c.c1.x} ${c.c1.y} ${c.c2.x} ${c.c2.y} ${c.b.x} ${c.b.y}`;
      this.svg.innerHTML =
        `<path class="wire" d="${d(this.in)}"/>` +
        this.out.map((c) => `<path class="wire" d="${d(c)}"/>`).join("") +
        `<g class="pk"></g>`;
      this.pk = this.svg.querySelector(".pk");
    }

    static bez(c, t) {
      const u = 1 - t;
      return {
        x: u * u * u * c.a.x + 3 * u * u * t * c.c1.x + 3 * u * t * t * c.c2.x + t * t * t * c.b.x,
        y: u * u * u * c.a.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.b.y,
      };
    }

    spawn() {
      const node = Math.floor(Math.random() * this.nodes.length);
      // in → hub, then hub → node, then a reply back node → hub → slack.
      this.packets.push({ leg: 0, t: 0, node, color: "#f5b31b", speed: 0.011 });
    }

    drawStatic() {
      this.pk.innerHTML = "";
      this.nodes[0].classList.add("lit");
    }

    loop() {
      if (!this.visible) { this.raf = 0; return; }
      this.t += 1 / 60;
      if (this.t > this.next) { this.spawn(); this.next = this.t + 1.6 + Math.random() * 1.4; }
      let html = "";
      for (const p of this.packets) {
        p.t += p.speed;
        let c;
        let t = p.t;
        if (p.leg === 0) c = this.in;
        else if (p.leg === 1) c = this.out[p.node];
        else if (p.leg === 2) { c = this.out[p.node]; t = 1 - p.t; }
        else { c = this.in; t = 1 - p.t; }
        const q = Fleet.bez(c, Math.min(1, t < 0 ? 0 : t));
        const tri = (x, y, s, col) => `<path fill="${col}" transform="translate(${x} ${y}) rotate(${(p.t * 720) % 360})" d="M0 ${-s}L${s * 0.87} ${s * 0.5}L${-s * 0.87} ${s * 0.5}Z"/>`;
        html += tri(q.x, q.y, 5, p.color);
        if (p.t >= 1) {
          p.t = 0;
          p.leg++;
          if (p.leg === 2) {
            // node received work: light up, "type", then answer in blue
            const el = this.nodes[p.node];
            el.classList.add("lit");
            p.speed = 0; // dwell
            p.color = "#1b7be0";
            setTimeout(() => { el.classList.remove("lit"); p.speed = 0.014; }, 900 + Math.random() * 600);
          }
          if (p.leg === 3) p.color = "#f0553b"; // approval-shaped reply heading back into Slack
          if (p.leg > 3) p.done = true;
        }
      }
      this.packets = this.packets.filter((p) => !p.done);
      this.pk.innerHTML = html;
      this.raf = requestAnimationFrame(() => this.loop());
    }
  }

  /* ------------------------------------------------------------------ *
   * Wire-up
   * ------------------------------------------------------------------ */

  const EYES = { ops: "bars", docs: "dots", data: "dash", sec: "arrows" };

  function heroScene(el, paletteName = "ops") {
    const canvas = el.querySelector("canvas");
    const eyes = el.querySelector(".eyes");
    el.dataset.eyes = EYES[paletteName] || "bars";
    return new Constellation(canvas, { colors: PALETTES[paletteName], eyes, eyeSet: EYES[paletteName] || "bars" });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const hero = document.querySelector("[data-scene='hero']");
    if (hero) heroScene(hero, hero.dataset.palette || "ops");

    const roll = document.querySelector("[data-scene='roll']");
    if (roll) {
      const scene = heroScene(roll, "ops");
      const rows = [...document.querySelectorAll(".persona-row")];
      let idx = 0;
      let timer = 0;
      const select = (i, user) => {
        idx = i;
        rows.forEach((r, j) => r.setAttribute("aria-selected", String(j === i)));
        const name = rows[i].dataset.persona;
        roll.dataset.eyes = EYES[name];
        roll.querySelector(".caption").textContent = rows[i].dataset.soul;
        scene.morph(PALETTES[name], EYES[name]);
        if (user) { clearInterval(timer); timer = setInterval(() => select((idx + 1) % rows.length), 5200); }
      };
      rows.forEach((r, i) => r.addEventListener("click", () => select(i, true)));
      rows[0].setAttribute("aria-selected", "true");
      if (!REDUCED) timer = setInterval(() => select((idx + 1) % rows.length), 4200);
    }

    const fleet = document.querySelector(".fleet-stage");
    if (fleet) new Fleet(fleet);

    const login = document.querySelector("[data-scene='login']");
    if (login) {
      const scene = heroScene(login, "night");
      // The eyes follow the cursor anywhere on the page, and glance at the form on focus.
      document.addEventListener("pointermove", (e) => scene.look(e.clientX, e.clientY));
      const btn = document.querySelector(".sso .btn");
      const form = document.querySelector(".login-form");
      form?.addEventListener("focusin", () => { const r = form.getBoundingClientRect(); scene.look(r.left + r.width / 2, r.top + r.height / 2); });
      btn?.addEventListener("click", (e) => {
        if (btn.dataset.demo === "1") e.preventDefault();
        btn.classList.add("busy");
        btn.querySelector(".label").textContent = "Redirecting to your identity provider";
        scene.orbit();
        if (btn.dataset.demo === "1") setTimeout(() => { btn.classList.remove("busy"); btn.querySelector(".label").textContent = "Continue with single sign-on"; scene.retarget("scatter"); }, 3200);
      });
    }
  });

  window.Folks = { Constellation, Fleet, PALETTES, FOLK_PATH };
})();
