/* ==========================================================================
   Folio Minigames — Snake · Element Match · Table Pong
   Fully offline: no backend, no Appwrite, no network calls. Best scores live
   in localStorage only. Loaded (defer) before script.js; the router calls
   window.FolioGames.render(sub) for #/games routes and FolioGames.onRoute()
   on every navigation so loops and key listeners stop when you leave.
   ========================================================================== */
(() => {
  "use strict";

  const RM = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const INK = "#56000F", CREAM0 = "#F7F3E2", CREAM2 = "#DED4BC",
    TEAL2 = "#76D7D2", TEAL3 = "#53B8B1", TEAL4 = "#1B8C88",
    CHERRY2 = "#E10823", CHERRY3 = "#9A001A";
  const SERIF = '"Fraunces", "Iowan Old Style", Georgia, "Times New Roman", serif';

  const esc = (v) => String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch { /* private mode — scores just won't persist */ }
    return null;
  }

  function blurPanelFocus() {
    const a = document.activeElement;
    if (a && a.closest && a.closest(".game-panel")) a.blur();
  }

  /* Fullscreen play: one tap fills the screen (button hidden where the API is
     missing, e.g. iPhone Safari — the landscape layout still fits there). */
  const FS_OK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const fsBtnHtml = () => FS_OK ? '<button class="btn btn-sm" type="button" data-fs>⛶ Fullscreen</button>' : "";
  function bindFullscreen(host, panel) {
    const btn = host.querySelector("[data-fs]");
    if (!btn || !panel) return;
    btn.addEventListener("click", () => {
      try {
        const current = document.fullscreenElement || document.webkitFullscreenElement;
        if (current) {
          const exit = document.exitFullscreen || document.webkitExitFullscreen;
          const p = exit && exit.call(document);
          if (p && p.catch) p.catch(() => {});
        } else {
          const req = panel.requestFullscreen || panel.webkitRequestFullscreen;
          const p = req && req.call(panel);
          if (p && p.catch) p.catch(() => {});
        }
      } catch { /* not allowed here — the landscape layout still fits the screen */ }
    });
  }

  /* Reveal-on-entrance, same visual language as the rest of Folio. */

  function reveal(main) {
    main.querySelectorAll("[data-reveal]").forEach((el, i) => {
      if (!el.style.getPropertyValue("--d")) el.style.setProperty("--d", Math.min(i, 9) * 55 + "ms");
      if (RM) { el.classList.add("reveal-in"); return; }
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("reveal-in")));
    });
  }

  const pageHead = (kicker, title, sub) => `
    <div class="page-head" data-reveal>
      <p class="kicker">${kicker}</p>
      <h1 class="page-title">${title}</h1>
      ${sub ? `<p class="page-sub">${sub}</p>` : ""}
    </div>`;

  const GAME_LIST = [
    { id: "snake", name: "Snake", tag: "1 player · keyboard or touch pad",
      desc: "Grow the teal snake and chase the cherry. Walls are solid, tails are bitey, speed is merciless." },
    { id: "memory", name: "Element Match", tag: "1 player · mouse or touch",
      desc: "Sixteen cards, eight elements. Flip two at a time and pair every symbol in as few moves as you can." },
    { id: "pong", name: "Table Pong", tag: "2 players · keyboard or one shared touch screen",
      desc: "Left player W/S, right player ↑/↓ — or drag on your half. Rotate your phone sideways for the whole court. First to seven wins the rivalry." }
  ];

  let teardown = null;
  function stopCurrent() { if (teardown) { try { teardown(); } catch { /* noop */ } teardown = null; } }

  /* ------------------------------------------------------------------ */
  /* Shared canvas helpers                                               */
  /* ------------------------------------------------------------------ */
  function setupCanvas(canvas, w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  function rr(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); return; }
    ctx.fillRect(x, y, w, h);
  }

  /* ================================================================== */
  /* SNAKE                                                               */
  /* ================================================================== */
  function snakeGame(host) {
    document.title = "Folio — Snake";
    const GRID = 21, CELL = 20, SIZE = GRID * CELL;
    host.innerHTML = `
      <div class="game-panel panel" data-reveal>
        <div class="game-toolbar">
          <div>
            <span class="game-score">Score<strong id="sk-score">0</strong></span>
            <span class="game-score">Best<strong id="sk-best">${esc(store("folio.games.snakeBest") || "0")}</strong></span>
          </div>
          <div class="game-actions">
            <button class="btn btn-sm" type="button" id="sk-restart">Restart</button>
            <button class="btn btn-primary btn-sm" type="button" id="sk-toggle">Start</button>
            ${fsBtnHtml()}
          </div>
        </div>
        <div class="game-stage">
          <canvas id="sk-canvas" aria-label="Snake game board" role="img"></canvas>
          <div class="game-overlay" id="sk-overlay">
            <p class="go-title">Snake</p>
            <p class="go-desc">Arrow keys / WASD or the pad below · eat cherries · walls and your own tail end the run.</p>
            <button class="btn btn-primary" type="button" id="sk-start2">Start game</button>
          </div>
        </div>
        <div class="dpad" id="sk-dpad" aria-label="Direction pad">
          <button type="button" class="dpad-spacer" tabindex="-1" aria-hidden="true"></button>
          <button type="button" data-dir="up" aria-label="Move up">↑</button>
          <button type="button" class="dpad-spacer" tabindex="-1" aria-hidden="true"></button>
          <button type="button" data-dir="left" aria-label="Move left">←</button>
          <button type="button" data-dir="down" aria-label="Move down">↓</button>
          <button type="button" data-dir="right" aria-label="Move right">→</button>
        </div>
      </div>`;

    const panel = host.querySelector(".game-panel");
    panel.style.setProperty("--gchrome", "174px");
    panel.style.setProperty("--gchrome-fs", "106px");
    bindFullscreen(host, panel);
    const canvas = host.querySelector("#sk-canvas");
    const ctx = setupCanvas(canvas, SIZE, SIZE);
    canvas.style.aspectRatio = "1 / 1";
    const $ = (sel) => host.querySelector(sel);
    const scoreEl = $("#sk-score"), bestEl = $("#sk-best"), overlay = $("#sk-overlay"), toggleBtn = $("#sk-toggle");

    let snake, dir, queue, food, score, tickMs, alive, running, raf = 0, last = 0, acc = 0;

    function reset() {
      snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
      dir = { x: 1, y: 0 }; queue = [];
      score = 0; tickMs = 140; alive = true; running = false; acc = 0;
      placeFood(); paintStats(); draw();
    }
    function placeFood() {
      do { food = { x: (Math.random() * GRID) | 0, y: (Math.random() * GRID) | 0 }; }
      while (snake.some(s => s.x === food.x && s.y === food.y));
    }
    function paintStats() {
      scoreEl.textContent = String(score);
      bestEl.textContent = String(store("folio.games.snakeBest") || "0");
    }
    function setRunning(v) {
      running = v;
      toggleBtn.textContent = v ? "Pause" : (alive ? (score ? "Resume" : "Start") : "Start");
      overlay.hidden = alive && !(!v && !score);
      if (!alive) {
        overlay.querySelector(".go-title").textContent = "Game over";
        overlay.querySelector(".go-desc").textContent = `You scored ${score}. ${score >= +(store("folio.games.snakeBest") || 0) && score > 0 ? "New personal best!" : "Best: " + (store("folio.games.snakeBest") || 0) + "."}`;
        overlay.querySelector("button").textContent = "Play again";
      }
    }
    function step() {
      if (queue.length) dir = queue.shift();
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID ||
          snake.some((s, i) => i < snake.length - 1 && s.x === head.x && s.y === head.y)) {
        alive = false;
        const best = +(store("folio.games.snakeBest") || 0);
        if (score > best) store("folio.games.snakeBest", String(score));
        setRunning(false); paintStats();
        return;
      }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score++; tickMs = Math.max(72, 140 - score * 5);
        placeFood(); paintStats();
      } else snake.pop();
    }
    function draw() {
      ctx.fillStyle = CREAM0; ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = "rgba(86,0,15,0.07)";
      for (let x = 1; x < GRID; x++) for (let y = 1; y < GRID; y++) ctx.fillRect(x * CELL - 1, y * CELL - 1, 2, 2);
      /* food */
      ctx.fillStyle = CHERRY2;
      ctx.beginPath(); ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL * 0.34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = CREAM0;
      ctx.beginPath(); ctx.arc(food.x * CELL + CELL * 0.38, food.y * CELL + CELL * 0.36, CELL * 0.09, 0, Math.PI * 2); ctx.fill();
      /* snake */
      snake.forEach((s, i) => {
        ctx.fillStyle = i === 0 ? TEAL3 : TEAL4;
        rr(ctx, s.x * CELL + 2, s.y * CELL + 2, CELL - 4, CELL - 4, i === 0 ? 7 : 5);
      });
      if (!alive) { ctx.fillStyle = "rgba(86,0,15,0.10)"; ctx.fillRect(0, 0, SIZE, SIZE); }
    }
    function frame(ts) {
      raf = requestAnimationFrame(frame);
      if (running && alive) {
        if (!last) last = ts;
        acc += ts - last; last = ts;
        while (acc >= tickMs && running && alive) { acc -= tickMs; step(); }
      } else { last = ts; acc = 0; }
      draw();
    }
    function pushDir(name) {
      const D = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[name];
      if (!D) return;
      const ref = queue.length ? queue[queue.length - 1] : dir;
      if (D.x === -ref.x && D.y === -ref.y) return; /* no instant reversal */
      if (queue.length < 2) queue.push(D);
    }
    function startOrRestart() {
      if (!alive) reset();
      setRunning(true);
    }
    const onKey = (e) => {
      const k = e.key;
      const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", W: "up", s: "down", S: "down", a: "left", A: "left", d: "right", D: "right" };
      if (map[k]) { e.preventDefault(); if (running) pushDir(map[k]); }
      else if (k === " ") { e.preventDefault(); blurPanelFocus(); if (!alive) startOrRestart(); else setRunning(!running); }
    };
    const onDpad = (e) => {
      const b = e.target.closest("[data-dir]");
      if (!b) return;
      e.preventDefault();
      if (!running && alive) setRunning(true);
      pushDir(b.dataset.dir);
    };

    reset();
    raf = requestAnimationFrame(frame);
    document.addEventListener("keydown", onKey);
    const dpad = $("#sk-dpad");
    dpad.addEventListener("pointerdown", onDpad);
    dpad.addEventListener("contextmenu", (e) => e.preventDefault());
    toggleBtn.addEventListener("click", () => { if (!alive) startOrRestart(); else setRunning(!running); });
    $("#sk-start2").addEventListener("click", startOrRestart);
    $("#sk-restart").addEventListener("click", () => { reset(); setRunning(true); });

    return () => { cancelAnimationFrame(raf); document.removeEventListener("keydown", onKey); };
  }

  /* ================================================================== */
  /* ELEMENT MATCH (memory)                                              */
  /* ================================================================== */
  function memoryGame(host) {
    document.title = "Folio — Element Match";
    const ELEMENTS = [
      ["H", "Hydrogen"], ["He", "Helium"], ["Li", "Lithium"], ["C", "Carbon"],
      ["N", "Nitrogen"], ["O", "Oxygen"], ["Na", "Sodium"], ["Fe", "Iron"]
    ];
    host.innerHTML = `
      <div class="game-panel panel panel-wide" data-reveal>
        <div class="game-toolbar">
          <div>
            <span class="game-score">Moves<strong id="mm-moves">0</strong></span>
            <span class="game-score">Pairs<strong id="mm-pairs">0/8</strong></span>
            <span class="game-score">Best<strong id="mm-best">${esc(store("folio.games.memoryBest") || "—")}</strong></span>
            <span class="game-score">Time<strong id="mm-time">0s</strong></span>
          </div>
          <div class="game-actions"><button class="btn btn-primary btn-sm" type="button" id="mm-restart">Shuffle &amp; restart</button>${fsBtnHtml()}</div>
        </div>
        <div class="mem-board" id="mm-board" aria-label="Memory board"></div>
        <p class="game-hint" aria-live="polite" id="mm-live"></p>
        <div class="game-overlay" id="mm-overlay" hidden>
          <p class="go-title" id="mm-win-title">All pairs found</p>
          <p class="go-desc" id="mm-win-desc"></p>
          <button class="btn btn-primary" type="button" id="mm-again">Play again</button>
        </div>
      </div>`;

    const $ = (sel) => host.querySelector(sel);
    const board = $("#mm-board");
    let deck = [], first = null, lock = false, moves = 0, matched = 0, started = false, elapsed = 0, timer = 0;

    function shuffle() {
      deck = ELEMENTS.flatMap(([sym, name], i) => [
        { eid: i, sym, name }, { eid: i, sym, name }
      ]);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
    }
    function paintBoard() {
      board.innerHTML = deck.map((c, i) => `
        <button class="mem-card" type="button" data-i="${i}" aria-label="Hidden card">
          <span class="mem-inner">
            <span class="mem-face mem-back" data-pattern="${(i % 6) + 1}">?</span>
            <span class="mem-face mem-front"><span class="mem-symbol">${esc(c.sym)}</span><span class="mem-name">${esc(c.name)}</span></span>
          </span>
        </button>`).join("");
    }
    function paintStats() {
      $("#mm-moves").textContent = String(moves);
      $("#mm-pairs").textContent = `${matched}/8`;
      $("#mm-time").textContent = elapsed + "s";
      $("#mm-best").textContent = store("folio.games.memoryBest") || "—";
    }
    function tick() { elapsed++; paintStats(); }
    function startTimer() { if (!started) { started = true; timer = window.setInterval(tick, 1000); } }
    function stopTimer() { if (timer) { clearInterval(timer); timer = 0; } }

    function win() {
      stopTimer();
      const best = +(store("folio.games.memoryBest") || 0);
      const isBest = !best || moves < best;
      if (isBest) store("folio.games.memoryBest", String(moves));
      paintStats();
      $("#mm-win-title").textContent = isBest ? "New personal best!" : "All pairs found";
      $("#mm-win-desc").textContent = `${moves} moves · ${elapsed}s. ${isBest ? "" : "Best: " + best + " moves."}`;
      $("#mm-overlay").hidden = false;
      $("#mm-live").textContent = "All eight pairs matched.";
    }
    function onCard(e) {
      const btn = e.target.closest(".mem-card");
      if (!btn || lock || btn.classList.contains("matched") || btn.classList.contains("flipped")) return;
      startTimer();
      const i = +btn.dataset.i, card = deck[i];
      btn.classList.add("flipped");
      btn.setAttribute("aria-label", card.name);
      if (!first) { first = { btn, card }; return; }
      moves++; paintStats();
      if (first.card.eid === card.eid) {
        first.btn.classList.add("matched"); btn.classList.add("matched");
        first.btn.classList.remove("flipped"); btn.classList.remove("flipped");
        matched++;
        $("#mm-live").textContent = `Pair found — ${matched} of 8.`;
        first = null;
        if (matched === ELEMENTS.length) setTimeout(win, 350);
      } else {
        lock = true;
        const a = first.btn, b = btn;
        first = null;
        setTimeout(() => {
          a.classList.remove("flipped"); b.classList.remove("flipped");
          a.setAttribute("aria-label", "Hidden card"); b.setAttribute("aria-label", "Hidden card");
          lock = false;
        }, 680);
      }
    }
    function reset() {
      stopTimer();
      first = null; lock = false; moves = 0; matched = 0; started = false; elapsed = 0;
      $("#mm-overlay").hidden = true;
      shuffle(); paintBoard(); paintStats();
      $("#mm-live").textContent = "";
    }

    reset();
    board.addEventListener("click", onCard);
    $("#mm-restart").addEventListener("click", reset);
    $("#mm-again").addEventListener("click", reset);
    bindFullscreen(host, host.querySelector(".game-panel"));

    return () => stopTimer();
  }

  /* ================================================================== */
  /* TABLE PONG (2 players, one keyboard)                                */
  /* ================================================================== */
  function pongGame(host) {
    document.title = "Folio — Table Pong";
    const W = 640, H = 400, PW = 10, PH = 74, PAD = 12, BALL = 9, TARGET = 7;
    host.innerHTML = `
      <div class="game-panel panel" data-reveal>
        <div class="game-toolbar">
          <div>
            <span class="game-score"><span style="color:${TEAL4}">●</span> Player 1<strong id="pg-s1">0</strong></span>
            <span class="game-score">Player 2 <span style="color:${CHERRY2}">●</span><strong id="pg-s2">0</strong></span>
          </div>
          <div class="game-actions"><button class="btn btn-primary btn-sm" type="button" id="pg-toggle">Start</button>${fsBtnHtml()}</div>
        </div>
        <div class="game-stage">
          <canvas id="pg-canvas" aria-label="Pong court — player one on the left, player two on the right" role="img"></canvas>
          <div class="game-overlay" id="pg-overlay">
            <p class="go-title">Table Pong</p>
            <p class="go-desc">First to ${TARGET}. Player 1: <strong>W/S</strong> (or drag the left half) · Player 2: <strong>↑/↓</strong> (or drag the right half) · <strong>Space</strong> pauses.</p>
            <button class="btn btn-primary" type="button" id="pg-start2">Start match</button>
          </div>
        </div>
        <p class="game-hint">The ball speeds up with every return — angles depend on where it meets the paddle.</p>
      </div>`;

    const canvas = host.querySelector("#pg-canvas");
    const ctx = setupCanvas(canvas, W, H);
    canvas.style.aspectRatio = "640 / 400";
    const $ = (sel) => host.querySelector(sel);
    const s1El = $("#pg-s1"), s2El = $("#pg-s2"), overlay = $("#pg-overlay"), toggleBtn = $("#pg-toggle");
    const panel = host.querySelector(".game-panel");
    panel.style.setProperty("--gchrome", "172px");
    panel.style.setProperty("--gchrome-fs", "108px");
    bindFullscreen(host, panel);

    let p1, p2, ball, s1, s2, serving, paused, over, started, raf = 0, last = 0, serveTimer = 0;
    const keys = new Set();

    function resetPositions() {
      p1 = { y: H / 2 - PH / 2 }; p2 = { y: H / 2 - PH / 2 };
      ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    }
    function reset() {
      resetPositions(); s1 = 0; s2 = 0; paused = false; over = false;
      started = false; serving = false;
      clearTimeout(serveTimer);
      paintScore();
      toggleBtn.textContent = "Start";
    }
    /* The rally may only begin when a player actually presses Start. */
    function beginMatch() {
      started = true; paused = false;
      overlay.hidden = true;
      toggleBtn.textContent = "Pause";
      scheduleServe(1);
    }
    function matchAction() {
      blurPanelFocus();
      if (over) { reset(); beginMatch(); }
      else if (!started) beginMatch();
      else setPaused(!paused);
    }
    function scheduleServe(toDir) {
      resetPositions();
      serving = true;
      clearTimeout(serveTimer);
      serveTimer = setTimeout(function launch() {
        if (over || !started) { serving = false; return; }
        if (paused) { serveTimer = setTimeout(launch, 300); return; } /* never serve into a pause */
        const angle = (Math.random() * 0.7 - 0.35);
        const speed = 300;
        ball.vx = Math.cos(angle) * speed * toDir;
        ball.vy = Math.sin(angle) * speed + (Math.random() * 80 - 40);
        serving = false;
      }, 900);
    }
    function paintScore() { s1El.textContent = String(s1); s2El.textContent = String(s2); }
    function setPaused(v) {
      paused = v;
      toggleBtn.textContent = v ? "Resume" : (over ? "Rematch" : (s1 || s2 ? "Pause" : "Start"));
      if (!over) {
        overlay.querySelector(".go-title").textContent = "Paused";
        overlay.querySelector(".go-desc").textContent = "Press Space or Resume to keep the rally going.";
        overlay.querySelector("button").textContent = "Resume";
        overlay.hidden = !v;
      }
    }
    function point(who) {
      if (who === 1) s1++; else s2++;
      paintScore();
      if (s1 >= TARGET || s2 >= TARGET) {
        over = true;
        overlay.querySelector(".go-title").textContent = `Player ${s1 >= TARGET ? 1 : 2} wins`;
        overlay.querySelector(".go-desc").textContent = `Final score ${s1} – ${s2}. Rematch?`;
        overlay.querySelector("button").textContent = "Rematch";
        overlay.hidden = false;
        toggleBtn.textContent = "Rematch";
      } else scheduleServe(who === 1 ? -1 : 1);
    }
    function update(dt) {
      const PS = 360;
      if (keys.has("w")) p1.y -= PS * dt;
      if (keys.has("s")) p1.y += PS * dt;
      if (keys.has("ArrowUp")) p2.y -= PS * dt;
      if (keys.has("ArrowDown")) p2.y += PS * dt;
      p1.y = Math.max(6, Math.min(H - PH - 6, p1.y));
      p2.y = Math.max(6, Math.min(H - PH - 6, p2.y));
      if (!started || serving || paused || over) return;
      ball.x += ball.vx * dt; ball.y += ball.vy * dt;
      if (ball.y < BALL) { ball.y = BALL; ball.vy = Math.abs(ball.vy); }
      if (ball.y > H - BALL) { ball.y = H - BALL; ball.vy = -Math.abs(ball.vy); }
      /* left paddle */
      if (ball.vx < 0 && ball.x - BALL <= PAD + PW && ball.x - BALL >= PAD - 6 &&
          ball.y >= p1.y - 4 && ball.y <= p1.y + PH + 4) {
        const rel = (ball.y - (p1.y + PH / 2)) / (PH / 2);
        const speed = Math.min(560, Math.hypot(ball.vx, ball.vy) * 1.05 + 12);
        ball.vx = Math.abs(Math.cos(rel * 0.9) * speed);
        ball.vy = Math.sin(rel * 0.9) * speed;
        ball.x = PAD + PW + BALL;
      }
      /* right paddle */
      if (ball.vx > 0 && ball.x + BALL >= W - PAD - PW && ball.x + BALL <= W - PAD + 6 &&
          ball.y >= p2.y - 4 && ball.y <= p2.y + PH + 4) {
        const rel = (ball.y - (p2.y + PH / 2)) / (PH / 2);
        const speed = Math.min(560, Math.hypot(ball.vx, ball.vy) * 1.05 + 12);
        ball.vx = -Math.abs(Math.cos(rel * 0.9) * speed);
        ball.vy = Math.sin(rel * 0.9) * speed;
        ball.x = W - PAD - PW - BALL;
      }
      if (ball.x < -BALL * 2) point(2);
      else if (ball.x > W + BALL * 2) point(1);
    }
    function draw() {
      ctx.fillStyle = CREAM0; ctx.fillRect(0, 0, W, H);
      /* net */
      ctx.strokeStyle = "rgba(86,0,15,0.28)"; ctx.lineWidth = 3; ctx.setLineDash([12, 14]);
      ctx.beginPath(); ctx.moveTo(W / 2, 10); ctx.lineTo(W / 2, H - 10); ctx.stroke(); ctx.setLineDash([]);
      /* scores */
      ctx.fillStyle = "rgba(86,0,15,0.85)";
      ctx.font = "600 52px " + SERIF; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(s1), W * 0.25, 46);
      ctx.fillText(String(s2), W * 0.75, 46);
      /* paddles */
      ctx.fillStyle = TEAL4; rr(ctx, PAD, p1.y, PW, PH, 5);
      ctx.fillStyle = CHERRY2; rr(ctx, W - PAD - PW, p2.y, PW, PH, 5);
      /* ball */
      ctx.fillStyle = INK; rr(ctx, ball.x - BALL / 2, ball.y - BALL / 2, BALL, BALL, 2);
      if (serving && !over) {
        ctx.fillStyle = "rgba(86,0,15,0.55)";
        ctx.font = "700 15px " + SERIF;
        ctx.fillText("Serving…", W / 2, H - 26);
      }
    }
    function frame(ts) {
      raf = requestAnimationFrame(frame);
      if (!last) last = ts;
      const dt = Math.min(0.033, (ts - last) / 1000); last = ts;
      update(dt); draw();
    }
    const onKeyDown = (e) => {
      if (["w", "W", "s", "S", "ArrowUp", "ArrowDown"].includes(e.key)) e.preventDefault();
      keys.add(e.key);
      if (e.key === " ") {
        e.preventDefault();
        matchAction();
      }
    };
    const onKeyUp = (e) => keys.delete(e.key);
    const onPointer = (e) => {
      if (e.pointerType === "mouse" && e.buttons === 0 && e.type === "pointermove") return;
      const rect = canvas.getBoundingClientRect();
      const y = (e.clientY - rect.top) * (H / rect.height);
      if (e.clientX - rect.left < rect.width / 2) p1.y = Math.max(6, Math.min(H - PH - 6, y - PH / 2));
      else p2.y = Math.max(6, Math.min(H - PH - 6, y - PH / 2));
    };

    reset();
    overlay.hidden = false;
    raf = requestAnimationFrame(frame);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    canvas.addEventListener("pointerdown", onPointer);
    canvas.addEventListener("pointermove", onPointer);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    toggleBtn.addEventListener("click", matchAction);
    $("#pg-start2").addEventListener("click", matchAction);

    return () => {
      cancelAnimationFrame(raf); clearTimeout(serveTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }

  /* ================================================================== */
  /* Router surface                                                      */
  /* ================================================================== */
  const VIEWS = { snake: snakeGame, memory: memoryGame, pong: pongGame };

  function render(sub) {
    stopCurrent();
    document.body.classList.add("games-view");
    document.body.classList.remove("game-live", "game-snake", "game-memory", "game-pong");
    const main = document.getElementById("main");
    if (!main) return;
    if (sub && VIEWS[sub]) {
      document.body.classList.add("game-live", "game-" + sub);
      const host = wrapHost(main);
      teardown = VIEWS[sub](host);
      reveal(main); /* after the game markup exists, or it stays at opacity 0 */
      return;
    }
    hubView(main);
  }
  /* Wrap dom.main so each game can replace content freely but the hub
     stays one click away. */
  function wrapHost(main) {
    main.innerHTML = `
      ${pageHead("Break time", "Minigames", "Offline classics — nothing here touches the backend or your library.")}
      <p class="games-back" style="margin:-6px 0 14px"><a class="btn btn-sm" href="#/games">‹ All games</a></p>
      <div id="game-host"></div>`;
    return document.getElementById("game-host");
  }
  function hubView(main) {
    document.title = "Folio — Minigames";
    const cards = GAME_LIST.map((g, i) => `
      <button class="game-card" data-game="${g.id}" data-reveal type="button">
        <span class="game-card-band" data-pattern="${(i % 6) + 1}"></span>
        <span class="game-card-body">
          <span class="game-card-kicker">${esc(g.tag)}</span>
          <h3>${esc(g.name)}</h3>
          <p>${esc(g.desc)}</p>
          <span class="game-card-cta">Play →</span>
        </span>
      </button>`).join("");
    main.innerHTML = `
      ${pageHead("Break time", "Minigames", "Three offline classics — no account, no backend, nothing here touches the library.")}
      <div class="games-grid">${cards}</div>`;
    main.querySelectorAll("[data-game]").forEach((b) =>
      b.addEventListener("click", () => { location.hash = "#/games/" + b.dataset.game; }));
    reveal(main);
  }

  window.FolioGames = {
    render,
    onRoute() {
      stopCurrent();
      document.body.classList.remove("games-view", "game-live", "game-snake", "game-memory", "game-pong");
    }
  };
})();