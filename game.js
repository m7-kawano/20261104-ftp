(() => {
  'use strict';

  // ============================================================
  //  基本設定
  // ============================================================
  const W = 540, H = 720, TAU = Math.PI * 2;
  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const canvas = $('#game');
  const ctx = canvas.getContext('2d');

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  const easeOut = (k) => 1 - Math.pow(1 - k, 3);
  const easeIn = (k) => k * k * k;
  const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

  const DEFAULT_ACCENT = '#7a7cff';

  // 難易度：弾速・密度・発射頻度・難化速度・ライフ・スコア倍率
  const DIFFS = {
    easy:   { key: 'easy',   label: '簡単',   en: 'EASY',   color: '#5df2b0', speed: 0.72, density: 0.62, rate: 0.72, growth: 0.65, lives: 3, mult: 1, maxEm: 3 },
    normal: { key: 'normal', label: '普通',   en: 'NORMAL', color: '#5fb8ff', speed: 1.0,  density: 1.0,  rate: 1.0,  growth: 1.0,  lives: 2, mult: 2, maxEm: 4 },
    hard:   { key: 'hard',   label: '難しい', en: 'HARD',   color: '#ff5d7a', speed: 1.22, density: 1.35, rate: 1.3,  growth: 1.45, lives: 1, mult: 4, maxEm: 5 },
  };
  const DIFF_ORDER = ['easy', 'normal', 'hard'];

  let scale = 1, dpr = 1;
  function resize() {
    scale = Math.min(innerWidth / W, innerHeight / H) * 0.98;
    stage.style.setProperty('--s', scale);
    dpr = Math.min(2.5, (window.devicePixelRatio || 1) * scale);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  addEventListener('resize', resize);
  resize();

  // ============================================================
  //  ベストスコア保存
  // ============================================================
  const STORE_KEY = 'stardust-dodge-best';
  const store = {
    load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } },
    save(o) { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (e) { /* 保存不可でも続行 */ } },
  };
  const best = store.load();

  // ============================================================
  //  効果音（WebAudio で簡易合成）
  // ============================================================
  const audio = (() => {
    let ac = null, master = null, muted = false;
    function unlock() {
      if (!ac) {
        try {
          ac = new (window.AudioContext || window.webkitAudioContext)();
          master = ac.createGain();
          master.gain.value = 0.16;
          master.connect(ac.destination);
        } catch (e) { ac = null; }
      } else if (ac.state === 'suspended') ac.resume();
    }
    function tone(f, d = 0.1, type = 'square', v = 0.5, slide = 0, delay = 0) {
      if (!ac || muted) return;
      const t = ac.currentTime + delay;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, f * slide), t + d);
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + d + 0.03);
    }
    function noise(d = 0.4, v = 0.5) {
      if (!ac || muted) return;
      const len = Math.floor(ac.sampleRate * d);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      const src = ac.createBufferSource(), g = ac.createGain();
      src.buffer = buf;
      g.gain.value = v;
      src.connect(g).connect(master);
      src.start();
    }
    return {
      unlock, tone, noise,
      toggle() { muted = !muted; return muted; },
    };
  })();
  const sfx = {
    move: () => audio.tone(620, 0.05, 'square', 0.22),
    ok: () => { audio.tone(880, 0.07, 'square', 0.28); audio.tone(1320, 0.14, 'square', 0.22, 0, 0.06); },
    back: () => audio.tone(440, 0.1, 'triangle', 0.35, 0.6),
    count: () => audio.tone(660, 0.12, 'triangle', 0.4),
    go: () => { audio.tone(990, 0.1, 'square', 0.3); audio.tone(1480, 0.25, 'square', 0.25, 0, 0.08); },
    graze: () => audio.tone(1900 + Math.random() * 300, 0.03, 'sine', 0.12),
    hit: () => { audio.noise(0.35, 0.6); audio.tone(300, 0.35, 'sawtooth', 0.35, 0.3); },
    death: () => { audio.noise(0.9, 0.8); audio.tone(220, 0.9, 'sawtooth', 0.4, 0.15); },
    pause: () => audio.tone(520, 0.08, 'triangle', 0.35),
    rank: () => { audio.tone(523, 0.1, 'square', 0.25); audio.tone(784, 0.1, 'square', 0.25, 0, 0.09); audio.tone(1046, 0.3, 'square', 0.25, 0, 0.18); },
  };

  // ============================================================
  //  弾の発光スプライト（キャッシュ）
  // ============================================================
  const spriteCache = new Map();
  function glowSprite(color, r) {
    const key = color + '|' + r;
    let c = spriteCache.get(key);
    if (c) return c;
    const size = r * 5;
    const px = Math.ceil(size * 2);
    c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    const h = px / 2;
    const [cr, cg, cb] = hexToRgb(color);
    const gr = g.createRadialGradient(h, h, 0, h, h, h);
    gr.addColorStop(0, '#fff');
    gr.addColorStop(0.15, '#fff');
    gr.addColorStop(0.24, `rgb(${cr},${cg},${cb})`);
    gr.addColorStop(0.36, `rgba(${cr},${cg},${cb},.55)`);
    gr.addColorStop(0.6, `rgba(${cr},${cg},${cb},.12)`);
    gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, px, px);
    c.size = size;
    spriteCache.set(key, c);
    return c;
  }

  // ============================================================
  //  ゲーム状態
  // ============================================================
  const G = {
    state: 'title',
    t: 0, real: 0,
    score: 0, survScore: 0, grazeScore: 0, graze: 0,
    lives: 0,
    diff: DIFFS.normal,
    bullets: [], emitters: [], particles: [],
    player: { x: W / 2, y: H - 110, tilt: 0, inv: 0, alive: false, focus: false },
    timeScale: 1,
    flash: 0, shake: 0,
    spawnT: 0,
    cdT: 0, cdStep: '',
    dyingT: 0, resultShown: false,
    demo: { cd: 0, rot: 0 }, demoDelay: 0,
    bgSpeed: 40,
    tint: hexToRgb(DEFAULT_ACCENT), tintTarget: hexToRgb(DEFAULT_ACCENT),
    accent: DEFAULT_ACCENT,
    lastGraze: 0,
  };

  const stars = [];
  for (let i = 0; i < 140; i++) stars.push({ x: rand(0, W), y: rand(0, H), z: rand(0.15, 1) });

  function setAccent(hex) {
    G.accent = hex;
    G.tintTarget = hexToRgb(hex);
    stage.style.setProperty('--accent', hex);
  }

  const intensity = () => 1 + G.t * 0.013 * G.diff.growth;

  // ============================================================
  //  弾・パーティクル
  // ============================================================
  function fire(x, y, ang, sp, r, color, opt) {
    if (G.bullets.length > 2600) return null;
    const b = { x, y, ang, sp, r, color, av: 0, acc: 0, max: 0, age: 0, grazed: false, demo: false };
    if (opt) Object.assign(b, opt);
    G.bullets.push(b);
    return b;
  }

  function particle(o) {
    G.particles.push(Object.assign({ x: 0, y: 0, vx: 0, vy: 0, life: 0.6, max: 0.6, size: 3, color: '#ffffff', type: 'dot', drag: 2.2 }, o));
  }
  function burst(x, y, color, n, sp) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), s = rand(0.2, 1) * sp, l = rand(0.4, 1.1);
      particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: l, max: l, size: Math.random() < 0.5 ? 2 : 3, color });
    }
  }
  function ring(x, y, color, maxR = 120, life = 0.7) {
    particle({ x, y, type: 'ring', life, max: life, size: maxR, color });
  }

  // 弾を光の粒に変えて消す（画面切替時のシームレスな消去）
  function dissolveBullets() {
    for (const b of G.bullets) {
      const l = rand(0.35, 0.8);
      particle({
        x: b.x, y: b.y,
        vx: Math.cos(b.ang) * b.sp * 0.25 + rand(-30, 30),
        vy: Math.sin(b.ang) * b.sp * 0.25 + rand(-40, 10),
        life: l, max: l, size: 2, color: b.color, drag: 3,
      });
    }
    G.bullets.length = 0;
  }
  function dissolveAll() {
    dissolveBullets();
    for (const e of G.emitters) {
      if (e.hidden) continue;
      burst(e.x, e.y, e.color, 18, 160);
      ring(e.x, e.y, e.color, 50, 0.5);
    }
    G.emitters.length = 0;
  }

  // ============================================================
  //  弾幕パターン
  // ============================================================
  const PATTERN_COLORS = {
    ring: '#ff5d7a', spiral: '#c38bff', aimed: '#ffb84d',
    flower: '#ff7bd5', burst: '#5fb8ff', rain: '#5df2b0',
  };

  const PATTERNS = {
    // 全方位リング
    ring(e, dt, D, I) {
      e.cd -= dt;
      if (e.cd > 0) return;
      e.cd = 1.05 / (D.rate * Math.sqrt(I));
      const n = Math.round(12 * D.density * (0.8 + I * 0.25));
      e.rot += 0.17;
      for (let i = 0; i < n; i++) fire(e.x, e.y, e.rot + (i / n) * TAU, 115 * D.speed, 6, e.color);
    },
    // 回転スパイラル
    spiral(e, dt, D, I) {
      e.cd -= dt;
      const arms = D.key === 'easy' ? 2 : D.key === 'normal' ? 3 : 4;
      const iv = 0.08 / (D.rate * Math.min(1.8, 0.8 + I * 0.2));
      while (e.cd <= 0) {
        e.cd += iv;
        e.rot += 0.21 * e.dir;
        for (let k = 0; k < arms; k++) fire(e.x, e.y, e.rot + (k * TAU) / arms, 135 * D.speed, 5, e.color);
      }
    },
    // 自機狙いの扇状連射
    aimed(e, dt, D, I) {
      const P = G.player;
      e.cd -= dt;
      if (e.cd <= 0) {
        e.cd = 1.7 / (D.rate * Math.sqrt(I));
        e.burst = D.key === 'hard' ? 4 : 3;
        e.bcd = 0;
        e.aim = Math.atan2(P.y - e.y, P.x - e.x);
      }
      if (e.burst > 0) {
        e.bcd -= dt;
        if (e.bcd <= 0) {
          e.bcd = 0.11;
          e.burst--;
          const n = Math.max(3, Math.round(4 * D.density + I * 1.2)) | 1;
          for (let i = 0; i < n; i++) {
            fire(e.x, e.y, e.aim + (i - (n - 1) / 2) * 0.13, (185 + (3 - e.burst) * 14) * D.speed, 5, e.color);
          }
        }
      }
    },
    // 曲がる花弁
    flower(e, dt, D, I) {
      e.cd -= dt;
      if (e.cd > 0) return;
      e.cd = 1.5 / (D.rate * Math.sqrt(I));
      const n = Math.round(14 * D.density * (0.85 + I * 0.2));
      e.rot += 0.3;
      for (let i = 0; i < n; i++) {
        const a = e.rot + (i / n) * TAU;
        fire(e.x, e.y, a, 100 * D.speed, 5, e.color, { av: 0.75 });
        fire(e.x, e.y, a, 100 * D.speed, 5, '#ffb84d', { av: -0.75 });
      }
    },
    // 一度溜めてから加速するリング
    burst(e, dt, D, I) {
      e.cd -= dt;
      if (e.cd > 0) return;
      e.cd = 1.35 / (D.rate * Math.sqrt(I));
      const n = Math.round(20 * D.density * (0.85 + I * 0.2));
      const off = rand(0, TAU);
      for (let i = 0; i < n; i++) {
        fire(e.x, e.y, off + (i / n) * TAU, 25, 7, e.color, { acc: 150 * D.speed, max: 250 * D.speed });
      }
    },
    // 画面上部から降り注ぐ雨
    rain(e, dt, D, I) {
      e.cd -= dt;
      const iv = 0.1 / (D.rate * D.density * Math.min(2, I));
      while (e.cd <= 0) {
        e.cd += iv;
        fire(rand(10, W - 10), -10, Math.PI / 2 + rand(-0.22, 0.22), rand(90, 150) * D.speed, 4, e.color);
      }
    },
  };

  function pickPattern() {
    const t = G.t * G.diff.growth;
    const pool = ['ring', 'aimed', 'spiral'];
    if (t > 12) pool.push('flower', 'burst');
    if (t > 28) pool.push('rain', 'spiral', 'aimed');
    if (t > 50) pool.push('flower', 'burst', 'rain');
    let p = pool[Math.floor(Math.random() * pool.length)];
    if (p === 'rain' && G.emitters.some((e) => e.pattern === 'rain')) p = 'ring';
    return p;
  }

  function spawnEmitter() {
    const pattern = pickPattern();
    const tx = rand(80, W - 80);
    const e = {
      pattern, color: PATTERN_COLORS[pattern],
      tx, x: tx, sy: -50, y: -50, ty: rand(90, 250),
      age: 0, dur: rand(7, 10.5),
      cd: 0.3, rot: rand(0, TAU), dir: Math.random() < 0.5 ? -1 : 1,
      wa: rand(20, 60), wf: rand(0.4, 0.9),
      burst: 0, bcd: 0, aim: 0, hidden: false,
    };
    if (pattern === 'rain') { e.hidden = true; e.sy = e.ty = -40; e.wa = 0; e.dur = rand(6, 8); }
    G.emitters.push(e);
  }

  function director(dt) {
    const D = G.diff, I = intensity();
    G.spawnT -= dt;
    const maxEm = Math.min(D.maxEm, 1 + Math.floor((G.t * D.growth) / 14));
    const active = G.emitters.reduce((n, e) => n + (e.age < e.dur ? 1 : 0), 0);
    if (G.spawnT <= 0 && active < maxEm) {
      spawnEmitter();
      G.spawnT = rand(2.2, 3.6) / Math.sqrt(I) / D.rate;
    }
  }

  // ============================================================
  //  更新処理
  // ============================================================
  const keys = new Set();
  const held = (...codes) => (codes.some((c) => keys.has(c)) ? 1 : 0);
  const touch = { dx: 0, dy: 0 };

  function updatePlayer(dt) {
    const p = G.player;
    let dx = held('ArrowRight', 'KeyD') - held('ArrowLeft', 'KeyA');
    let dy = held('ArrowDown', 'KeyS') - held('ArrowUp', 'KeyW');
    if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
    p.focus = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const sp = p.focus ? 135 : 290;
    p.x = clamp(p.x + dx * sp * dt + touch.dx, 12, W - 12);
    p.y = clamp(p.y + dy * sp * dt + touch.dy, 16, H - 16);
    touch.dx = touch.dy = 0;
    p.tilt = lerp(p.tilt, dx, Math.min(1, dt * 10));
    if (p.inv > 0) p.inv -= dt;
    engineTrail(p);
  }
  function engineTrail(p) {
    if (Math.random() < 0.8) {
      particle({ x: p.x + rand(-2.5, 2.5), y: p.y + 12, vx: rand(-15, 15), vy: rand(130, 210), life: 0.25, max: 0.25, size: 2, color: G.diff.color, drag: 1 });
    }
  }

  function updateEmitters(dt, firing) {
    const I = intensity();
    for (let i = G.emitters.length - 1; i >= 0; i--) {
      const e = G.emitters[i];
      e.age += dt;
      if (e.age < e.dur) {
        e.y = lerp(e.sy, e.ty, easeOut(clamp(e.age / 1.3, 0, 1)));
      } else {
        const k = clamp((e.age - e.dur) / 1.4, 0, 1);
        e.y = lerp(e.ty, e.sy, easeIn(k));
        if (k >= 1) { G.emitters.splice(i, 1); continue; }
      }
      e.x = e.tx + Math.sin(e.age * e.wf) * e.wa;
      if (firing && e.age > 1.0 && e.age < e.dur) PATTERNS[e.pattern](e, dt, G.diff, I);
    }
  }

  function updateBullets(dt) {
    const bs = G.bullets;
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i];
      b.age += dt;
      if (b.av) b.ang += b.av * dt;
      if (b.acc) { b.sp += b.acc * dt; if (b.sp > b.max) b.sp = b.max; }
      b.x += Math.cos(b.ang) * b.sp * dt;
      b.y += Math.sin(b.ang) * b.sp * dt;
      if (b.x < -40 || b.x > W + 40 || b.y < -60 || b.y > H + 40) {
        bs[i] = bs[bs.length - 1];
        bs.pop();
      }
    }
  }

  function updateParticles(dt) {
    const ps = G.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }

  function updateDemo(dt) {
    if (G.demoDelay > 0) { G.demoDelay -= dt; return; }
    const d = G.demo;
    d.cd -= dt;
    while (d.cd <= 0) {
      d.cd += 0.17;
      d.rot += 0.37;
      for (let k = 0; k < 3; k++) {
        fire(W / 2, H * 0.36, d.rot + (k * TAU) / 3, 55, 5, k === 1 ? '#c38bff' : G.accent, { demo: true, av: 0.12 });
      }
    }
  }

  function collide() {
    const p = G.player;
    if (!p.alive) return;
    const mult = G.diff.mult;
    for (const b of G.bullets) {
      if (b.demo) continue;
      const dx = b.x - p.x, dy = b.y - p.y, d2 = dx * dx + dy * dy;
      if (p.inv > 0) continue;
      const hr = b.r * 0.72 + 2.2;
      if (d2 < hr * hr) { hit(); return; }
      if (!b.grazed) {
        const gr = b.r + 17;
        if (d2 < gr * gr) {
          b.grazed = true;
          G.graze++;
          G.grazeScore += 10 * mult;
          particle({ x: (b.x + p.x) / 2, y: (b.y + p.y) / 2, vx: -dx * 4, vy: -dy * 4, life: 0.3, max: 0.3, size: 2, color: '#ffffff' });
          if (G.real - G.lastGraze > 0.05) { sfx.graze(); G.lastGraze = G.real; }
        }
      }
    }
  }

  function hit() {
    const p = G.player;
    G.lives--;
    renderLives();
    G.shake = 10;
    G.flash = 0.55;
    burst(p.x, p.y, '#ffffff', 40, 260);
    ring(p.x, p.y, '#ffffff', 140, 0.7);
    if (G.lives > 0) {
      sfx.hit();
      p.inv = 2.4;
      dissolveBullets();
    } else {
      die();
    }
  }

  function die() {
    const p = G.player;
    G.state = 'dying';
    G.dyingT = 0;
    p.alive = false;
    sfx.death();
    burst(p.x, p.y, '#ffffff', 80, 380);
    burst(p.x, p.y, G.diff.color, 70, 300);
    ring(p.x, p.y, G.diff.color, 220, 1.1);
    ring(p.x, p.y, '#ffffff', 120, 0.8);
    G.flash = 1;
    G.shake = 18;
    hide('hud');
  }

  function update(rdt) {
    G.real += rdt;
    const s = G.state;

    // スローモーション（被弾時）と通常時の時間スケールを補間
    const tsTarget = s === 'dying' ? 0.22 : 1;
    G.timeScale = lerp(G.timeScale, tsTarget, Math.min(1, rdt * (s === 'dying' ? 5 : 3)));
    const dt = s === 'paused' ? 0 : rdt * G.timeScale;

    // 背景色・星の速度もなめらかに遷移
    for (let i = 0; i < 3; i++) G.tint[i] = lerp(G.tint[i], G.tintTarget[i], Math.min(1, rdt * 2.5));
    const bgTarget = s === 'play' ? 140 + G.t * 0.8 : s === 'countdown' ? 110 : s === 'paused' ? 0 : 40;
    G.bgSpeed = lerp(G.bgSpeed, Math.min(bgTarget, 260), Math.min(1, rdt * 2));
    for (const st of stars) {
      st.y += G.bgSpeed * st.z * rdt;
      if (st.y > H + 4) { st.y = -4; st.x = rand(0, W); }
    }

    if (s === 'countdown') updateCountdown(rdt);
    if (s === 'play') {
      G.t += dt;
      G.survScore += 100 * G.diff.mult * (1 + G.t / 60) * dt;
      G.score = G.survScore + G.grazeScore;
      director(dt);
      updatePlayer(dt);
    }
    if (s !== 'paused') {
      updateEmitters(dt, s === 'play');
      if (s === 'title' || s === 'select' || s === 'result') updateDemo(dt);
      updateBullets(dt);
      if (s === 'play') collide();
      updateParticles(dt);
    }

    G.flash = Math.max(0, G.flash - rdt * 1.8);
    G.shake = Math.max(0, G.shake - rdt * 30);

    if (G.state === 'dying') {
      G.dyingT += rdt;
      if (G.dyingT > 1.7 && !G.resultShown) showResult();
    }
    updateHud();
  }

  function updateCountdown(rdt) {
    G.cdT += rdt;
    const t = G.cdT, p = G.player;
    if (t < 1.1) {
      p.y = lerp(H + 40, H - 110, easeOut(t / 1.1));
      engineTrail(p);
    } else {
      updatePlayer(rdt);
    }
    const step = t < 0.75 ? '3' : t < 1.5 ? '2' : t < 2.25 ? '1' : 'START';
    if (step !== G.cdStep) {
      G.cdStep = step;
      setCount(step);
      if (step === 'START') { sfx.go(); G.state = 'play'; G.spawnT = 0.6; }
      else sfx.count();
    }
  }

  // ============================================================
  //  描画
  // ============================================================
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#04050d';
    ctx.fillRect(0, 0, W, H);

    const [r, g, b] = G.tint.map(Math.round);
    const neb = ctx.createRadialGradient(W * 0.5, H * 0.2, 10, W * 0.5, H * 0.2, H * 0.9);
    neb.addColorStop(0, `rgba(${r},${g},${b},.22)`);
    neb.addColorStop(0.5, `rgba(${r},${g},${b},.06)`);
    neb.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, W, H);

    for (const st of stars) {
      ctx.globalAlpha = st.z * 0.85;
      ctx.fillStyle = st.z > 0.75 ? '#ffffff' : `rgb(${r},${g},${b})`;
      const sz = st.z * 1.8;
      ctx.fillRect(st.x, st.y, sz, sz + G.bgSpeed * st.z * 0.03);
    }
    ctx.globalAlpha = 1;

    ctx.save();
    if (G.shake > 0) ctx.translate(rand(-1, 1) * G.shake, rand(-1, 1) * G.shake);

    ctx.globalCompositeOperation = 'lighter';
    drawEmitters();
    drawBullets();
    drawParticles();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    drawPlayer();
    ctx.restore();

    if (G.flash > 0) {
      ctx.globalAlpha = Math.min(1, G.flash);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function drawBullets() {
    for (const b of G.bullets) {
      const spr = glowSprite(b.color, b.r);
      let sz = spr.size;
      if (b.age < 0.15) sz *= 0.3 + 0.7 * (b.age / 0.15);
      ctx.globalAlpha = b.demo ? 0.38 : 1;
      ctx.drawImage(spr, b.x - sz / 2, b.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  function drawEmitters() {
    for (const e of G.emitters) {
      if (e.hidden) continue;
      const spr = glowSprite(e.color, 10);
      const pulse = 1 + Math.sin(e.age * 8) * 0.08;
      const sz = spr.size * 1.6 * pulse;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(spr, e.x - sz / 2, e.y - sz / 2, sz, sz);
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.age * 1.6 * e.dir);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 1;
      ctx.strokeRect(-13, -13, 26, 26);
      ctx.rotate(Math.PI / 4);
      ctx.globalAlpha = 0.6;
      ctx.strokeRect(-9, -9, 18, 18);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles() {
    for (const p of G.particles) {
      const k = p.life / p.max;
      if (p.type === 'ring') {
        ctx.globalAlpha = k;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1 + 3 * k;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * easeOut(1 - k), 0, TAU);
        ctx.stroke();
      } else {
        const spr = glowSprite(p.color, p.size);
        const sz = spr.size * (0.5 + 0.5 * k);
        ctx.globalAlpha = k;
        ctx.drawImage(spr, p.x - sz / 2, p.y - sz / 2, sz, sz);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayer() {
    const p = G.player;
    if (!p.alive) return;
    const blink = p.inv > 0 && Math.floor(p.inv * 14) % 2 === 0;
    const col = G.diff.color;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = blink ? 0.3 : 1;

    // 発光
    ctx.globalCompositeOperation = 'lighter';
    const glow = glowSprite(col, 9);
    ctx.drawImage(glow, -glow.size, -glow.size, glow.size * 2, glow.size * 2);
    ctx.globalCompositeOperation = 'source-over';

    // 機体
    ctx.save();
    ctx.scale(1 - Math.abs(p.tilt) * 0.3, 1);
    const grd = ctx.createLinearGradient(0, -16, 0, 12);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(1, col);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.lineTo(11, 11);
    ctx.lineTo(0, 5);
    ctx.lineTo(-11, 11);
    ctx.closePath();
    ctx.fill();
    // 炎
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha *= 0.8;
    ctx.beginPath();
    ctx.moveTo(-3, 8);
    ctx.lineTo(0, 14 + Math.random() * 6);
    ctx.lineTo(3, 8);
    ctx.fill();
    ctx.restore();

    // 低速移動中はグレイズ範囲と当たり判定を表示
    if (p.focus) {
      ctx.globalAlpha = blink ? 0.3 : 0.7;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 5]);
      ctx.lineDashOffset = -G.real * 20;
      ctx.beginPath();
      ctx.arc(0, 0, 20, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = blink ? 0.4 : 1;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ff3c64';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ============================================================
  //  UI / 画面遷移
  // ============================================================
  const screens = {
    title: $('#scr-title'), select: $('#scr-select'), hud: $('#scr-hud'),
    pause: $('#scr-pause'), result: $('#scr-result'),
  };
  const show = (n) => screens[n].classList.add('active');
  const hide = (n) => screens[n].classList.remove('active');
  const hideAll = () => Object.keys(screens).forEach(hide);

  let lockUntil = 0;
  const lock = (ms = 500) => { lockUntil = performance.now() + ms; };
  const locked = () => performance.now() < lockUntil;

  // キーボード/マウス共通のメニュー
  let menu = null;
  function setMenu(name, idx = 0) {
    const items = [...screens[name].querySelectorAll('[data-act]')];
    menu = { name, items, idx: clamp(idx, 0, items.length - 1) };
    highlight();
  }
  function highlight() {
    if (!menu) return;
    menu.items.forEach((b, i) => b.classList.toggle('sel', i === menu.idx));
    if (menu.name === 'select') {
      const d = DIFFS[menu.items[menu.idx].dataset.diff];
      setAccent(d.color);
      $('#sel-best').textContent = best[d.key] ? best[d.key].toLocaleString() : '—';
    }
  }
  function moveMenu(dir) {
    if (!menu) return;
    const n = menu.items.length;
    menu.idx = (menu.idx + dir + n) % n;
    sfx.move();
    highlight();
  }

  for (const name of Object.keys(screens)) {
    screens[name].querySelectorAll('[data-act]').forEach((btn, i) => {
      btn.addEventListener('pointerenter', () => {
        if (menu && menu.name === name && menu.idx !== i) { menu.idx = i; sfx.move(); highlight(); }
      });
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        audio.unlock();
        if (locked() || !menu || menu.name !== name) return;
        menu.idx = i;
        highlight();
        act(btn);
      });
    });
  }
  screens.title.addEventListener('click', () => {
    audio.unlock();
    if (G.state === 'title' && !locked()) goSelect(true);
  });

  function act(btn) {
    switch (btn.dataset.act) {
      case 'diff': sfx.ok(); startGame(btn.dataset.diff); break;
      case 'resume': resume(); break;
      case 'retry': sfx.ok(); startGame(G.diff.key); break;
      case 'select': sfx.ok(); goSelect(false); break;
      case 'title': sfx.back(); goTitle(); break;
    }
  }

  function goTitle() {
    if (G.player.alive) burst(G.player.x, G.player.y, G.diff.color, 30, 160);
    G.player.alive = false;
    dissolveAll();
    hideAll();
    show('title');
    G.state = 'title';
    G.demoDelay = 0.6;
    menu = null;
    setAccent(DEFAULT_ACCENT);
    lock(600);
  }

  function goSelect(fromTitle) {
    if (fromTitle) sfx.ok();
    hideAll();
    show('select');
    G.state = 'select';
    setMenu('select', DIFF_ORDER.indexOf(G.diff.key));
    lock(450);
  }

  function startGame(key) {
    const D = DIFFS[key];
    dissolveAll();
    hideAll();
    G.diff = D;
    setAccent(D.color);
    Object.assign(G, {
      t: 0, score: 0, survScore: 0, grazeScore: 0, graze: 0,
      lives: D.lives, spawnT: 0, cdT: 0, cdStep: '',
      dyingT: 0, resultShown: false, timeScale: 1,
    });
    Object.assign(G.player, { x: W / 2, y: H + 40, tilt: 0, inv: 0, alive: true, focus: false });
    buildLives();
    $('#hud-diff').textContent = `${D.en} ×${D.mult}`;
    updateHud(true);
    show('hud');
    menu = null;
    G.state = 'countdown';
    lock(400);
  }

  function pause() {
    if (G.state !== 'play') return;
    G.state = 'paused';
    sfx.pause();
    show('pause');
    setMenu('pause', 0);
    lock(300);
  }
  function resume() {
    if (G.state !== 'paused') return;
    sfx.pause();
    hide('pause');
    menu = null;
    G.state = 'play';
    lock(250);
  }

  // ---- カウントダウン ----
  const countEl = $('#count');
  function setCount(txt) {
    countEl.textContent = txt;
    countEl.classList.remove('pop', 'go');
    void countEl.offsetWidth; // アニメーション再始動
    countEl.classList.add(txt === 'START' ? 'go' : 'pop');
  }

  // ---- HUD ----
  const hudScore = $('#hud-score'), hudTime = $('#hud-time'), hudGraze = $('#hud-graze'), hudLives = $('#hud-lives');
  const hudCache = { score: -1, time: '', graze: -1 };
  function formatTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t * 100) % 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  }
  function updateHud(force) {
    const sc = Math.floor(G.score);
    if (force || sc !== hudCache.score) { hudCache.score = sc; hudScore.textContent = sc.toLocaleString(); }
    const tm = formatTime(G.t);
    if (force || tm !== hudCache.time) { hudCache.time = tm; hudTime.textContent = tm; }
    if (force || G.graze !== hudCache.graze) { hudCache.graze = G.graze; hudGraze.textContent = G.graze; }
  }
  function buildLives() {
    hudLives.innerHTML = '';
    for (let i = 0; i < G.diff.lives; i++) {
      const d = document.createElement('div');
      d.className = 'life';
      hudLives.appendChild(d);
    }
  }
  function renderLives() {
    [...hudLives.children].forEach((el, i) => el.classList.toggle('lost', i >= G.lives));
  }

  // ---- リザルト ----
  let resultToken = 0;
  function rankOf(t) {
    if (t >= 150) return 'S';
    if (t >= 90) return 'A';
    if (t >= 50) return 'B';
    if (t >= 25) return 'C';
    return 'D';
  }
  function countUp(el, to, dur, delay, fmt, tok, done) {
    const start = performance.now() + delay;
    el.textContent = fmt(0);
    function step(now) {
      if (tok !== resultToken) return;
      const k = clamp((now - start) / dur, 0, 1);
      el.textContent = fmt(to * easeOut(k));
      if (k < 1) requestAnimationFrame(step);
      else if (done) done();
    }
    requestAnimationFrame(step);
  }

  function showResult() {
    G.resultShown = true;
    dissolveAll();
    G.demoDelay = 1.0;
    const D = G.diff;
    const score = Math.floor(G.score);
    const prev = best[D.key] || 0;
    const isNew = score > prev;
    if (isNew) { best[D.key] = score; store.save(best); }

    $('#res-diff').textContent = `${D.label}  ${D.en}`;
    $('#res-mult').textContent = `×${D.mult}`;
    $('#res-best').textContent = Math.max(score, prev).toLocaleString();
    const newEl = $('#res-new'), rankEl = $('#res-rank');
    newEl.classList.remove('show');
    rankEl.classList.remove('show');
    $('#res-rank-letter').textContent = rankOf(G.t);

    show('result');
    G.state = 'result';
    setMenu('result', 0);
    lock(700);

    const tok = ++resultToken;
    const int = (v) => Math.floor(v).toLocaleString();
    countUp($('#res-time'), G.t, 900, 300, formatTime, tok);
    countUp($('#res-surv'), G.survScore, 900, 380, int, tok);
    countUp($('#res-graze'), G.graze, 900, 460, (v) => Math.floor(v).toString(), tok);
    countUp($('#res-score'), score, 1300, 600, int, tok, () => {
      $('#res-score').textContent = score.toLocaleString();
      if (isNew && score > 0) newEl.classList.add('show');
      rankEl.classList.add('show');
      sfx.rank();
    });
  }

  // ============================================================
  //  入力
  // ============================================================
  const CONFIRM = ['Enter', 'NumpadEnter', 'Space', 'KeyZ'];
  const BACK = ['Escape', 'KeyX', 'Backspace'];

  addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    audio.unlock();
    keys.add(e.code);
    if (e.repeat && !e.code.startsWith('Arrow') && !['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) return;

    if (e.code === 'KeyM') {
      const m = audio.toggle();
      const el = $('#sound');
      el.textContent = m ? 'SOUND OFF' : 'SOUND ON';
      el.classList.add('show');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove('show'), 1200);
      return;
    }
    if (locked()) return;

    const up = e.code === 'ArrowUp' || e.code === 'KeyW';
    const down = e.code === 'ArrowDown' || e.code === 'KeyS';
    const left = e.code === 'ArrowLeft' || e.code === 'KeyA';
    const right = e.code === 'ArrowRight' || e.code === 'KeyD';
    const confirm = CONFIRM.includes(e.code);
    const back = BACK.includes(e.code);

    switch (G.state) {
      case 'title':
        if (confirm) goSelect(true);
        break;
      case 'select':
        if (up) moveMenu(-1);
        else if (down) moveMenu(1);
        else if (confirm) act(menu.items[menu.idx]);
        else if (back) { sfx.back(); goTitle(); }
        break;
      case 'play':
        if (e.code === 'Escape' || e.code === 'KeyP') pause();
        break;
      case 'paused':
        if (up) moveMenu(-1);
        else if (down) moveMenu(1);
        else if (confirm) act(menu.items[menu.idx]);
        else if (e.code === 'Escape' || e.code === 'KeyP') resume();
        break;
      case 'result':
        if (left || up) moveMenu(-1);
        else if (right || down) moveMenu(1);
        else if (confirm) act(menu.items[menu.idx]);
        else if (e.code === 'KeyR') { sfx.ok(); startGame(G.diff.key); }
        else if (back) { sfx.back(); goSelect(false); }
        break;
    }
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => { keys.clear(); pause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  // タッチ/ドラッグ操作（おまけ）：ドラッグ量に合わせて自機を相対移動
  let tp = null;
  stage.addEventListener('pointerdown', (e) => {
    if (G.state === 'play' || G.state === 'countdown') tp = { x: e.clientX, y: e.clientY };
  });
  addEventListener('pointermove', (e) => {
    if (!tp) return;
    touch.dx += ((e.clientX - tp.x) / scale) * 1.2;
    touch.dy += ((e.clientY - tp.y) / scale) * 1.2;
    tp = { x: e.clientX, y: e.clientY };
  });
  addEventListener('pointerup', () => { tp = null; });
  addEventListener('pointercancel', () => { tp = null; });

  // ============================================================
  //  メインループ
  // ============================================================
  let last = performance.now();
  function frame(now) {
    const rdt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    update(rdt);
    render();
    requestAnimationFrame(frame);
  }

  setAccent(DEFAULT_ACCENT);
  // 初回表示もフェードインさせる
  requestAnimationFrame(() => requestAnimationFrame(() => show('title')));
  lock(500);
  requestAnimationFrame(frame);
})();
