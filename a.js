import { generatePatternCells } from "./common.js";

const channel = new BroadcastChannel("dual-screen-patterns");

new p5((p) => {
  let inputEl;
  let inputShellEl;
  let previewTrackEl;
  let ghostTextEl;
  let statusBarEl;
  let caretEl;

  let currentHash = "";
  let glitchLines = [];
  let bgParticles = [];
  let scanlineOffset = 0;

  let currentTrackShift = 0;
  let previewPatternCache = {};
  let lastSentAt = 0;

  const GLITCH_DEATH_FRAMES = 45;
  const SLICE_COUNT = 6;
  let dyingGlyphs = [];

  const SEND_COOLDOWN_MS = 500;
  const MAX_GLYPHS = 27;
  const BG = [2, 3, 5];

  const GLYPH_PX    = () => window.innerWidth <= 900 ? 24 : 28;
  const GLYPH_GAP   = () => window.innerWidth <= 900 ? 7 : 8;
  const CELL_STEP   = () => window.innerWidth <= 900 ? 3.4 : 4;
  const PREVIEW_PAD_X = () => window.innerWidth <= 900 ? 22 : 28;
  const ADVANCE     = () => GLYPH_PX() + GLYPH_GAP();

  class BgParticle {
    constructor() { this.reset(true); }
    reset(init = false) {
      this.x    = p.random(p.width);
      this.y    = init ? p.random(p.height) : p.height + 12;
      this.char = p.random(["0","1","a","b","c","d","e","f"]);
      this.alpha = p.random(3, 10);
      this.size  = p.random(8, 11);
      this.vy   = p.random(-0.18, -0.42);
      this.vx   = p.random(-0.06, 0.06);
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      if (this.y < -20 || this.x < -10 || this.x > p.width + 10) this.reset();
    }
    draw() {
      p.fill(0, 210, 230, this.alpha);
      p.noStroke();
      p.textFont("monospace");
      p.textSize(this.size);
      p.textAlign(p.CENTER, p.CENTER);
      p.text(this.char, this.x, this.y);
    }
  }

  function drawRadialGradient() {
    const ctx = p.drawingContext;
    const cx = p.width / 2;
    const cy = p.height * 0.62;
    const g1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(p.width, p.height) * 0.55);
    g1.addColorStop(0,    "rgba(0,32,40,0.34)");
    g1.addColorStop(0.45, "rgba(0,14,20,0.18)");
    g1.addColorStop(1,    "rgba(2,3,5,0)");
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, p.width, p.height);
    const glow = ctx.createLinearGradient(0, p.height * 0.78, 0, p.height);
    glow.addColorStop(0, "rgba(0,120,150,0)");
    glow.addColorStop(1, "rgba(0,120,150,0.08)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, p.width, p.height);
  }

  function drawHorizonLine() {
    const y = p.height * 0.83;
    const ctx = p.drawingContext;
    const grad = ctx.createLinearGradient(0, y, p.width, y);
    grad.addColorStop(0,    "rgba(0,210,230,0)");
    grad.addColorStop(0.18, "rgba(0,210,230,0.07)");
    grad.addColorStop(0.5,  "rgba(0,210,230,0.12)");
    grad.addColorStop(0.82, "rgba(0,210,230,0.07)");
    grad.addColorStop(1,    "rgba(0,210,230,0)");
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, p.width, 1.5);
    ctx.restore();
  }

  function drawGrainAndScanlines() {
    const ctx = p.drawingContext;
    ctx.save();
    for (let i = 0; i < 180; i++) {
      const gx = Math.random() * p.width;
      const gy = Math.random() * p.height;
      const br = Math.random() * 22;
      ctx.fillStyle = `rgba(${br},${br},${br},${Math.random() * 0.06})`;
      ctx.fillRect(gx, gy, 1, 1);
    }
    ctx.restore();
    p.noStroke();
    for (let y = 0; y < p.height; y += 4) {
      p.fill(0, 0, 0, 7);
      p.rect(0, y, p.width, 1);
    }
    scanlineOffset = (scanlineOffset + 0.35) % p.height;
    p.fill(0, 210, 230, 2.5);
    p.rect(0, scanlineOffset, p.width, 2);
  }

  function spawnGlitchLines(count = 3) {
    for (let i = 0; i < count; i++) {
      glitchLines.push({
        y: p.random(p.height * 0.3, p.height * 0.9),
        life: 1,
        decay: p.random(0.08, 0.16),
        w: p.random(p.width * 0.15, p.width * 0.5),
        x: p.random(p.width * 0.1, p.width * 0.75),
        isRed: Math.random() > 0.7,
      });
    }
  }

  function drawGlitchLines() {
    glitchLines = glitchLines.filter((gl) => {
      gl.life -= gl.decay;
      if (gl.life <= 0) return false;
      p.noStroke();
      p.fill(
        gl.isRed ? 255 : 0,
        gl.isRed ? 50  : 210,
        gl.isRed ? 70  : 230,
        gl.life * (gl.isRed ? 95 : 55)
      );
      p.rect(gl.x, gl.y, gl.w, 1);
      return true;
    });
  }

  function drawDyingGlyphs() {
    const shellRect = inputShellEl?.getBoundingClientRect();
    if (!shellRect) return;

    const ctx = p.drawingContext;

    dyingGlyphs = dyingGlyphs.filter((dg) => {
      const elapsed    = p.frameCount - dg.deathFrame;
      const deathRatio = p.constrain(elapsed / GLITCH_DEATH_FRAMES, 0, 1);
      if (deathRatio >= 1) return false;

      const eased  = Math.pow(deathRatio, 2);
      const alpha  = p.lerp(dg.startAlpha, 0, deathRatio);
      const step   = dg.cellStep;
      const sliceH = dg.glyphPx;

      ctx.save();
      ctx.beginPath();
      ctx.rect(
        shellRect.left,
        shellRect.top,
        shellRect.width,
        shellRect.height
      );
      ctx.clip();

      p.push();
      p.noStroke();

      for (let s = 0; s < SLICE_COUNT; s++) {
        const yBandStart = (s / SLICE_COUNT) * sliceH;
        const yBandEnd   = ((s + 1) / SLICE_COUNT) * sliceH;
        const slideOffX  = dg.sliceOffsets[s] * eased;
        const slideOffY  = s % 2 === 0 ? eased * 5 : eased * -5;

        for (const cell of dg.cells) {
          const cy = cell.i * step;
          if (cy < yBandStart || cy >= yBandEnd) continue;
          const cx = cell.j * step;
          const isRed = dg.redCells.has(`${cell.i},${cell.j}`);
          if (isRed) {
            p.fill(145, 40, 44, alpha * (1 - deathRatio * 0.5));
          } else {
            p.fill(196, 202, 204, alpha * (1 - deathRatio * 0.5));
          }
          p.rect(
            dg.x + cx + slideOffX,
            dg.y + cy + slideOffY,
            step - 1, step - 1
          );
        }
      }

      p.pop();
      ctx.restore();

      return true;
    });
  }

  function capturePreviewAsDying() {
    const shellRect = inputShellEl?.getBoundingClientRect();
    if (!shellRect) return;

    const text = inputEl.value;
    if (!text) return;

    const step    = CELL_STEP();
    const gPx     = GLYPH_PX();
    const padX    = PREVIEW_PAD_X();
    const centerY = shellRect.top + shellRect.height / 2 - gPx / 2;

    [...text].forEach((ch, index) => {
      if (!previewPatternCache[ch]) {
        previewPatternCache[ch] = generatePatternCells(ch, p);
      }
      const cells = previewPatternCache[ch];
      if (!cells || cells.length === 0) return;

      const x = shellRect.left + padX + index * ADVANCE();

      const redCells = new Set();
      cells.forEach(cell => {
        if (Math.random() > 0.78) redCells.add(`${cell.i},${cell.j}`);
      });

      const sliceOffsets = Array.from({ length: SLICE_COUNT }, () =>
        (Math.random() - 0.5) * 28
      );

      dyingGlyphs.push({
        cells,
        x,
        y: centerY,
        glyphPx: gPx,
        cellStep: step,
        sliceOffsets,
        redCells,
        deathFrame: p.frameCount,
        startAlpha: 200,
      });
    });
  }

  async function updateHash(text) {
    if (!text) { currentHash = ""; return; }
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    currentHash = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .substring(0, 64);
  }

  function setStatus(text) {
    if (statusBarEl) statusBarEl.textContent = text;
  }

  function getSelectionIndex() {
    return inputEl?.selectionStart ?? 0;
  }

  function clampSelectionIndex(index) {
    return Math.max(0, Math.min(index, inputEl.value.length));
  }

  function updateCaretPosition() {
    if (!caretEl || !inputShellEl || !inputEl) return;
    const isFocused = document.activeElement === inputEl;
    caretEl.classList.toggle("hidden", !isFocused);
    const idx = getSelectionIndex();
    const x = PREVIEW_PAD_X() + idx * ADVANCE() - currentTrackShift;
    caretEl.style.left = `${x}px`;
    if (isFocused) caretEl.classList.add("blink");
    else caretEl.classList.remove("blink");
  }

  function setCaretIndex(index) {
    const safeIndex = clampSelectionIndex(index);
    inputEl.focus();
    inputEl.setSelectionRange(safeIndex, safeIndex);
    updateCaretPosition();
  }

  function getIndexFromPointer(clientX) {
    const rect   = inputShellEl.getBoundingClientRect();
    const localX = clientX - rect.left - PREVIEW_PAD_X() + currentTrackShift;
    const idx    = Math.round(localX / ADVANCE());
    return clampSelectionIndex(idx);
  }

  function buildMiniPreview(text) {
    previewTrackEl.innerHTML = "";
    if (!text) {
      ghostTextEl.style.opacity = "1";
      updateCaretPosition();
      return;
    }
    ghostTextEl.style.opacity = "0";

    [...text].forEach((ch) => {
      if (!previewPatternCache[ch]) {
        previewPatternCache[ch] = generatePatternCells(ch, p);
      }
      const cells = previewPatternCache[ch];
      const glyphEl = document.createElement("div");
      glyphEl.className = "preview-glyph";
      cells.forEach((cell) => {
        const dot = document.createElement("div");
        dot.className  = "preview-cell";
        dot.style.left = `${cell.j * CELL_STEP()}px`;
        dot.style.top  = `${cell.i * CELL_STEP()}px`;
        glyphEl.appendChild(dot);
      });
      previewTrackEl.appendChild(glyphEl);
    });

    updateCaretPosition();
  }

  function clearPreview() {
    previewTrackEl.innerHTML = "";
    ghostTextEl.style.opacity = "1";
    updateCaretPosition();
  }

  function normalizeValue() {
    let raw = inputEl.value.toUpperCase();
    if (raw.length > MAX_GLYPHS) {
      raw = raw.substring(0, MAX_GLYPHS);
      inputEl.value = raw;
    }
    return raw;
  }

  async function syncFromInput() {
    const raw = normalizeValue();
    buildMiniPreview(raw);

    if (previewTrackEl && inputShellEl) {
      const idx       = getSelectionIndex();
      const padX      = PREVIEW_PAD_X();
      const advance   = ADVANCE();
      const caretLeft = padX + idx * advance;
      const shellW    = inputShellEl.clientWidth;
      const trackW    = padX + raw.length * advance + padX;
      const maxShift  = Math.max(0, trackW - shellW);
      let shift = caretLeft - shellW / 2;
      shift = Math.max(0, Math.min(shift, maxShift));
      currentTrackShift = shift;
      previewTrackEl.style.left = `${-shift}px`;
      if (caretEl) caretEl.style.left = `${caretLeft - shift}px`;
    }

    if (raw.length > 0) setStatus(`▸ ENCODING... [${raw.length} CHARS]`);
    else setStatus("▸ AWAITING_INPUT...");

    await updateHash(raw);
    p.loop();
  }

  p.setup = () => {
    p.createCanvas(window.innerWidth, window.innerHeight);

    inputEl        = document.getElementById("textInput");
    inputShellEl   = document.getElementById("input-shell");
    previewTrackEl = document.getElementById("patternTrack");
    ghostTextEl    = document.getElementById("ghostText");
    statusBarEl    = document.getElementById("status-bar");
    caretEl        = document.getElementById("previewCaret");

    if (inputShellEl) {
      inputShellEl.style.overflowX = "hidden";
      inputShellEl.style.overflowY = "hidden";
    }

    for (let i = 0; i < 26; i++) bgParticles.push(new BgParticle());

    inputEl.addEventListener("input", async () => {
      await syncFromInput();
      updateCaretPosition();
    });

    inputEl.addEventListener("click",  () => { syncFromInput(); updateCaretPosition(); });
    inputEl.addEventListener("keyup",  () => { syncFromInput(); updateCaretPosition(); });
    inputEl.addEventListener("select", () => updateCaretPosition());
    inputEl.addEventListener("focus",  () => updateCaretPosition());
    inputEl.addEventListener("blur",   () => updateCaretPosition());

    inputEl.addEventListener("keydown", (e) => {
      if (e.isComposing) return;

      const navKeys = ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","Backspace","Delete"];
      if (navKeys.includes(e.key)) {
        requestAnimationFrame(() => { syncFromInput(); updateCaretPosition(); });
      }

      if (e.key === "Enter" && !e.repeat) {
        const val = inputEl.value.trim();
        if (!val) return;
        e.preventDefault();

        const now = Date.now();
        if (now - lastSentAt < SEND_COOLDOWN_MS) return;
        lastSentAt = now;

        capturePreviewAsDying();

        channel.postMessage({
          type: "entry",
          id: now.toString(36) + "-" + Math.random().toString(36).slice(2),
          text: val,
        });

        spawnGlitchLines(5);

        inputEl.value = "";
        currentHash   = "";
        clearPreview();
        setCaretIndex(0);
        if (previewTrackEl) previewTrackEl.style.left = "0px";
        currentTrackShift = 0;

        setStatus("▸ TRANSMITTING...");
        setTimeout(() => setStatus("▸ AWAITING_INPUT..."), 1200);

        p.loop();
      }
    });

    inputShellEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const idx = getIndexFromPointer(e.clientX);
      setCaretIndex(idx);
    });

    window.addEventListener("pointerdown", (e) => {
      if (!inputShellEl.contains(e.target)) return;
      inputEl.focus();
      updateCaretPosition();
    });

    window.addEventListener("resize", () => requestAnimationFrame(updateCaretPosition));

    inputEl.focus();
    updateCaretPosition();
    p.noLoop();
  };

  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    updateCaretPosition();
    p.loop();
  };

  p.draw = () => {
    p.background(...BG, 255);
    drawRadialGradient();

    bgParticles.forEach(bp => { bp.update(); bp.draw(); });

    drawHorizonLine();
    drawGrainAndScanlines();
    drawGlitchLines();

    drawDyingGlyphs();

    const stillAnimating = glitchLines.length > 0 || dyingGlyphs.length > 0;
    if (stillAnimating) p.loop();
    else p.noLoop();
  };
});
