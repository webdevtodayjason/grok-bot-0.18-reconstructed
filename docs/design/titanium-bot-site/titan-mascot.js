/* Titan mascot v1.1 — Titanium Bot. No external dependencies. */
(() => {
  'use strict';
  if (customElements.get('titan-mascot')) return;

  const CHARACTERS = [
  {
    "name": "Titan",
    "description": "The familiar face at the center of your control room.",
    "colors": [
      "#23DCEF",
      "#00C8F0",
      "#00AFE0"
    ],
    "eye": "round",
    "power": 0,
    "phase": 0
  },
  {
    "name": "Scribe",
    "description": "A soft violet silhouette with a thoughtful, half-open eye.",
    "colors": [
      "#D0B5FF",
      "#A88CEB",
      "#8968D2"
    ],
    "eye": "squint",
    "power": 0.35,
    "phase": 0.8
  },
  {
    "name": "Orbit",
    "description": "A bright blue explorer with an eye shaped for curiosity.",
    "colors": [
      "#9CCAFF",
      "#6AABEF",
      "#498BDC"
    ],
    "eye": "almond",
    "power": -0.4,
    "phase": 1.6
  },
  {
    "name": "Flux",
    "description": "A fluid mint companion that never quite sits still.",
    "colors": [
      "#89EBC7",
      "#51CCAB",
      "#2BAB9B"
    ],
    "eye": "tall",
    "power": -0.6,
    "phase": 2.4
  },
  {
    "name": "Nova",
    "description": "A warm coral spark with a wide, welcoming eye.",
    "colors": [
      "#FFB4A6",
      "#F08E87",
      "#D86C7E"
    ],
    "eye": "round",
    "power": 0.65,
    "phase": 3.2
  },
  {
    "name": "Echo",
    "description": "A lilac ripple with a gently tapered eye.",
    "colors": [
      "#E0BAF1",
      "#C59BDC",
      "#A179C6"
    ],
    "eye": "diamond",
    "power": -0.25,
    "phase": 4
  },
  {
    "name": "Pip",
    "description": "A sunny little presence with a tall, attentive eye.",
    "colors": [
      "#FBE19A",
      "#EAC66E",
      "#DCA651"
    ],
    "eye": "tall",
    "power": 0.55,
    "phase": 4.8
  },
  {
    "name": "Ripple",
    "description": "A cool aqua companion with a flowing outline.",
    "colors": [
      "#A0ECE6",
      "#65CCC9",
      "#36B1BC"
    ],
    "eye": "almond",
    "power": -0.75,
    "phase": 5.6
  },
  {
    "name": "Moss",
    "description": "An easygoing green companion with a relaxed gaze.",
    "colors": [
      "#C6DD9B",
      "#A1BF77",
      "#7EA65F"
    ],
    "eye": "squint",
    "power": 0.8,
    "phase": 6.4
  },
  {
    "name": "Comet",
    "description": "An orange glow with a playful, shifting silhouette.",
    "colors": [
      "#FFD199",
      "#F5AD70",
      "#E78B50"
    ],
    "eye": "diamond",
    "power": -0.45,
    "phase": 7.2
  },
  {
    "name": "Wisp",
    "description": "An airy periwinkle shape with a curious little gaze.",
    "colors": [
      "#C8D0FF",
      "#A0AFE7",
      "#8093CD"
    ],
    "eye": "round",
    "power": -0.8,
    "phase": 8
  },
  {
    "name": "Lumen",
    "description": "A clear sky-blue companion with an open, attentive eye.",
    "colors": [
      "#B0ECF4",
      "#86D0E0",
      "#5BB5CB"
    ],
    "eye": "tall",
    "power": 0.3,
    "phase": 8.8
  },
  {
    "name": "Pixel",
    "description": "A pink companion with a softly geometric personality.",
    "colors": [
      "#F6BEDB",
      "#E496BE",
      "#C979A4"
    ],
    "eye": "almond",
    "power": 1.1,
    "phase": 9.6
  }
];
  window.TitanCharacters = Object.freeze(CHARACTERS.map(c => Object.freeze(c)));

  const MOODS = Object.freeze({
    calm: Object.freeze({ speed: .7, strength: .8, bob: 1 }),
    curious: Object.freeze({ speed: .95, strength: 1.3, bob: 1.15 }),
    excited: Object.freeze({ speed: 1.55, strength: 1.65, bob: 2.3 })
  });

  function createMotion(host, canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Titan requires a browser with Canvas 2D support.');
    let character = CHARACTERS[0];
    let cyan = '#00C8F0';
    const navy = '#0C203F', cream = '#FFF9EF';
    let width = 600, height = 408, clock = 1.2, last = 0;
    let pointer = null, eyeX = 0, eyeY = 0;
    let mood = 'calm', paused = false;
    let speed = .7, strength = .8, bobStrength = 1;
    let visible = true, destroyed = false, animationId = null;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const events = new AbortController();
    const on = (target, name, fn) => target.addEventListener(name, fn, { signal: events.signal });

    function ellipse(x,y,rx,ry,fill) {
      ctx.beginPath(); ctx.ellipse(x,y,rx,Math.max(.5,ry),0,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();
    }
    function bodyPath(t, r) {
      const points = [];
      const power = 2.5 + character.power + .65*Math.sin(t*.38);
      const rotation = .13*Math.sin(t*.5);
      for (let i=0;i<120;i++) {
        const a = i/120*Math.PI*2;
        const ca=Math.cos(a), sa=Math.sin(a);
        const squareRadius = 1/Math.pow(Math.pow(Math.abs(ca),power)+Math.pow(Math.abs(sa),power),1/power);
        const waves = strength*(.095*Math.sin(3*a+t*.86+character.phase)+.05*Math.cos(2*a-t*.63+character.phase*.7)+.028*Math.sin(5*a-t*.41+character.phase*.4));
        const swell = .045*strength*Math.cos(a-t*.75);
        const rr = r*(squareRadius+waves+swell);
        const x = Math.cos(a+rotation)*rr*(1+.035*Math.sin(t*.9));
        const y = Math.sin(a+rotation)*rr*(1-.045*Math.sin(t*.9));
        points.push({x,y});
      }
      ctx.beginPath();ctx.moveTo((points[0].x+points[119].x)/2,(points[0].y+points[119].y)/2);
      points.forEach((p,i)=>{ const next=points[(i+1)%points.length];ctx.quadraticCurveTo(p.x,p.y,(p.x+next.x)/2,(p.y+next.y)/2); });
      ctx.closePath();
    }
    function draw() {
      ctx.clearRect(0,0,width,height);
      const t=clock;
      const r=Math.min(width*.275,height*.285);
      const x=width/2+4*Math.sin(t*.37);
      const y=height*.46+Math.sin(t*1.1)*5*bobStrength;
      const shadow=ctx.createRadialGradient(width/2,height*.87,0,width/2,height*.87,r*.88);
      shadow.addColorStop(0,'rgba(0,160,200,0.16)');shadow.addColorStop(1,'rgba(0,160,200,0)');
      ctx.save();ctx.translate(width/2,height*.87);ctx.scale(1,.13);ellipse(0,0,r*.9,r*.9,shadow);ctx.restore();
      ctx.save();ctx.translate(x,y);
      bodyPath(t,r);
      const bodyFill=ctx.createLinearGradient(-r,-r,r,r);
      bodyFill.addColorStop(0,character.colors[0]);bodyFill.addColorStop(.55,cyan);bodyFill.addColorStop(1,character.colors[2]);
      ctx.fillStyle=bodyFill;ctx.fill();
      const driftX = Math.sin(t*.7)*r*.025;
      const driftY = Math.sin(t*.83)*r*.026;
      const ex = -r*.045+driftX, ey = -r*.11+driftY;
      let targetX = Math.sin(t*.57)*r*.105, targetY = Math.cos(t*.49)*r*.06;
      if (pointer) {
        const dx=pointer.x-(x+ex), dy=pointer.y-(y+ey), len=Math.hypot(dx,dy)||1;
        const amount=Math.min(1,len/(r*1.6));targetX=dx/len*r*.155*amount;targetY=dy/len*r*.155*amount;
      }
      eyeX+=(targetX-eyeX)*.1;eyeY+=(targetY-eyeY)*.1;
      const blinkPeriod=5.6;
      const blinkPhase=t%blinkPeriod;
      const blink=blinkPhase<.18 ? Math.max(.04,Math.abs(blinkPhase-.09)/.09) : 1;
      ctx.save();ctx.translate(ex,ey);ctx.rotate(-.07+Math.sin(t*.42)*.04);ctx.scale(1,blink);
      if (character.eye === 'round') {
        ellipse(0,0,r*.405,r*.455,cream);
        ellipse(eyeX,eyeY,r*.178,r*.20,navy);
        ellipse(eyeX-r*.052,eyeY-r*.071,r*.046,r*.046,'#FFFFFF');
      } else {
        ctx.save(); ctx.beginPath();
        if (character.eye === 'almond') {
          ctx.moveTo(-r*.46,0);ctx.bezierCurveTo(-r*.17,-r*.51,r*.25,-r*.47,r*.46,0);
          ctx.bezierCurveTo(r*.18,r*.42,-r*.23,r*.43,-r*.46,0);
        } else if (character.eye === 'diamond') {
          ctx.moveTo(0,-r*.46);ctx.bezierCurveTo(r*.15,-r*.45,r*.43,-r*.12,r*.43,0);
          ctx.bezierCurveTo(r*.43,r*.15,r*.12,r*.44,0,r*.44);
          ctx.bezierCurveTo(-r*.16,r*.44,-r*.43,r*.14,-r*.43,0);
          ctx.bezierCurveTo(-r*.43,-r*.14,-r*.14,-r*.46,0,-r*.46);
        } else if (character.eye === 'squint') {
          ctx.ellipse(0,0,r*.43,r*.29,0,0,Math.PI*2);
        } else {
          ctx.ellipse(0,0,r*.32,r*.48,0,0,Math.PI*2);
        }
        ctx.closePath();ctx.fillStyle=cream;ctx.fill();ctx.clip();
        ellipse(eyeX,eyeY,r*.178,r*.20,navy);
        ellipse(eyeX-r*.052,eyeY-r*.071,r*.046,r*.046,'#FFFFFF');
        ctx.restore();
      }
      ctx.restore();
      ctx.beginPath();
      const mx = r*.32+driftX, my = r*.39+driftY;
      ctx.moveTo(mx-r*.10,my);
      ctx.quadraticCurveTo(mx+r*.015,my+r*.09,mx+r*.105,my-r*.025);
      ctx.lineWidth=r*.048;ctx.lineCap='round';ctx.strokeStyle=navy;ctx.stroke();
      ctx.restore();
    }

    function canAnimate() {
      return !destroyed && !paused && visible && !document.hidden;
    }
    function schedule() {
      if (canAnimate() && animationId === null) animationId = requestAnimationFrame(frame);
      if (!canAnimate() && animationId !== null) {
        cancelAnimationFrame(animationId); animationId = null; last = 0;
      }
    }
    function frame(now) {
      animationId = null;
      if (!canAnimate()) { last = 0; return; }
      const dt = last ? Math.min((now - last) / 1000, .05) : 0;
      last = now;
      const p = MOODS[mood];
      speed += (p.speed - speed) * .035;
      strength += (p.strength - strength) * .035;
      bobStrength += (p.bob - bobStrength) * .035;
      clock += dt * speed;
      draw(); schedule();
    }
    function resize() {
      if (destroyed) return;
      width = Math.max(1, host.getBoundingClientRect().width);
      height = Math.min(430, width * .68);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }
    function refresh() {
      const selected = Number(host.getAttribute('variant') || 0);
      character = CHARACTERS[Number.isInteger(selected) && selected >= 0 && selected < CHARACTERS.length ? selected : 0];
      cyan = character.colors[1];
      mood = Object.hasOwn(MOODS, host.getAttribute('mood')) ? host.getAttribute('mood') : 'calm';
      paused = host.hasAttribute('paused') || (media.matches && host._manualPlay !== true);
      if (host.getAttribute('tracking') === 'off') pointer = null;
      if (paused) {
        const p = MOODS[mood]; speed = p.speed; strength = p.strength; bobStrength = p.bob;
        draw();
      }
      schedule();
      host.dispatchEvent(new CustomEvent('titan-statechange', {
        bubbles: true, composed: true, detail: { mood, paused }
      }));
    }
    on(canvas, 'pointermove', event => {
      if (host.getAttribute('tracking') === 'off') return;
      const bounds = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      if (paused) draw();
    });
    on(canvas, 'pointerleave', () => { pointer = null; if (paused) draw(); });
    on(document, 'visibilitychange', () => { last = 0; schedule(); });
    on(media, 'change', refresh);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    const intersectionObserver = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(entries => {
          visible = entries[0].isIntersecting; last = 0; schedule();
        })
      : null;
    if (intersectionObserver) intersectionObserver.observe(host);
    resize(); refresh();
    return {
      refresh,
      get paused() { return paused; },
      reset() {
        clock = 1.2; last = 0; pointer = null; eyeX = 0; eyeY = 0;
        const p = MOODS[mood]; speed = p.speed; strength = p.strength; bobStrength = p.bob;
        draw();
      },
      snapshot() { return canvas.toDataURL('image/png'); },
      destroy() {
        destroyed = true;
        if (animationId !== null) cancelAnimationFrame(animationId);
        events.abort(); resizeObserver.disconnect();
        if (intersectionObserver) intersectionObserver.disconnect();
      }
    };
  }

  class TitanMascot extends HTMLElement {
    static get observedAttributes() { return ['mood', 'paused', 'tracking', 'variant']; }
    constructor() {
      super();
      this._manualPlay = null;
      this._motion = null;
      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        :host { display: block; width: 100%; contain: content; }
        canvas { display: block; width: 100%; touch-action: pan-y; }
      </style><canvas role="img" aria-label="Titan, a cyan alien with one expressive eye, a small smile, and a gently morphing body."></canvas>`;
    }
    connectedCallback() {
      if (!this._motion) this._motion = createMotion(this, this.shadowRoot.querySelector('canvas'));
    }
    disconnectedCallback() {
      if (this._motion) this._motion.destroy();
      this._motion = null;
    }
    attributeChangedCallback() {
      if (this._motion) this._motion.refresh();
    }
    get mood() { return Object.hasOwn(MOODS, this.getAttribute('mood')) ? this.getAttribute('mood') : 'calm'; }
    set mood(value) {
      if (!Object.hasOwn(MOODS, value)) throw new RangeError('Titan mood must be calm, curious, or excited.');
      this.setAttribute('mood', value);
    }
    get paused() { return this._motion ? this._motion.paused : this.hasAttribute('paused'); }
    setMood(value) { this.mood = value; }
    play() {
      this._manualPlay = true; this.removeAttribute('paused');
      if (this._motion) this._motion.refresh();
    }
    pause() {
      this._manualPlay = false; this.setAttribute('paused', '');
    }
    reset() { if (this._motion) this._motion.reset(); }
    snapshot() {
      if (!this._motion) throw new Error('Connect Titan to the page before taking a snapshot.');
      return this._motion.snapshot();
    }
  }
  customElements.define('titan-mascot', TitanMascot);
})();
