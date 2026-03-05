import { generatePatternCells } from "./common.js";

const channel = new BroadcastChannel("dual-screen-patterns");

new p5((p) => {
  let COLS, ROWS, CAPACITY;
  const CELL_MIN_SIZE = 80;
  const CELL_MAX_SIZE = 160;
  const GRID_MAX_COLS = 16;
  const GRID_MAX_ROWS = 9;
  const MARGIN = 60;
  const BG = [6, 7, 9];

  let slots = [];
  let queue = [];
  let activeHash = "00000000000000000000000000000000";
  let backgroundNodes = [];

  const FADE_OUT_FRAMES = 100;
  const BUILD_FRAMES = 40;

  // ====== 관계선 설정 ======
  const CONNECTION_MAX_DIST_CELLS = 6;
  const CONNECTION_MAX_SESSIONS = 3;

  let sessionCounter = 0;

  // ====== 그리드 ======
  function updateGridConfig() {
    const availW = p.width - MARGIN * 2;
    const availH = p.height - MARGIN * 2;
    COLS = p.constrain(Math.floor(availW / CELL_MIN_SIZE), 4, GRID_MAX_COLS);
    ROWS = p.constrain(Math.floor(availH / CELL_MIN_SIZE), 3, GRID_MAX_ROWS);
    CAPACITY = COLS * ROWS;
    slots = Array(CAPACITY).fill(null);
    queue = [];
  }

  function cellSize() {
    const cs = Math.min(
      (p.width  - MARGIN * 2) / COLS,
      (p.height - MARGIN * 2) / ROWS
    );
    return Math.min(cs, CELL_MAX_SIZE);
  }

  function gridOrigin() {
    const cs = cellSize();
    return {
      x: p.width  / 2 - (cs * COLS) / 2,
      y: p.height / 2 - (cs * ROWS) / 2,
    };
  }

  function slotCenter(idx, cs, gx0, gy0) {
    const g = slots[idx];
    const scale = (g && g.isBig) ? 2 : 1;
    return {
      x: gx0 + (idx % COLS) * cs + (cs * scale) / 2,
      y: gy0 + Math.floor(idx / COLS) * cs + (cs * scale) / 2,
    };
  }

  async function computeHash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text + Date.now());
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function canOccupy2x2(idx) {
    const c = idx % COLS;
    const r = Math.floor(idx / COLS);
    if (c >= COLS - 1 || r >= ROWS - 1) return false;
    return slots[idx] === null &&
           slots[idx + 1] === null &&
           slots[idx + COLS] === null &&
           slots[idx + COLS + 1] === null;
  }

  function occupy2x2(idx, glyph) {
    slots[idx] = glyph;
    slots[idx + 1]        = { hidden: true, parentIdx: idx };
    slots[idx + COLS]     = { hidden: true, parentIdx: idx };
    slots[idx + COLS + 1] = { hidden: true, parentIdx: idx };
  }

  function freeSlot(idx, g) {
    slots[idx] = null;
    if (g && g.isBig) {
      if (idx + 1 < CAPACITY)        slots[idx + 1]        = null;
      if (idx + COLS < CAPACITY)     slots[idx + COLS]     = null;
      if (idx + COLS + 1 < CAPACITY) slots[idx + COLS + 1] = null;
    }
  }

  function purgeOldest(n) {
    let removedCount = 0;
    while (removedCount < n && queue.length > 0) {
      const g = queue.shift();
      const idx = slots.findIndex(s => s === g);
      if (idx !== -1) {
        freeSlot(idx, g);
        removedCount += g.isBig ? 2 : 1;
      }
    }
  }

  function generateRects(ch, cs) {
    const cells = generatePatternCells(ch, p);
    if (!cells || cells.length === 0) return [];
    const inset = 12;
    const mini = (cs - inset * 2) / 7;
    return p.shuffle(cells.map(c => ({
      x: inset + c.j * mini,
      y: inset + c.i * mini,
      s: mini - 1
    })));
  }

  // ====== 관계선 ======
  function drawConnections(cs, gx0, gy0) {
    const sessionMap = new Map();
    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (!g || g.hidden) continue;
      if (!sessionMap.has(g.sessionId)) sessionMap.set(g.sessionId, []);
      sessionMap.get(g.sessionId).push({ g, idx: i });
    }

    const sessions = [...sessionMap.entries()].sort((a, b) => b[0] - a[0]);
    const maxDist = CONNECTION_MAX_DIST_CELLS * cs;

    sessions.slice(0, CONNECTION_MAX_SESSIONS).forEach(([sid, glyphs], sessionAge) => {
      const ageFactor = 1 - sessionAge / CONNECTION_MAX_SESSIONS;
      const isCurrentSession = sid === sessionCounter - 1;

      for (let ai = 0; ai < glyphs.length; ai++) {
        for (let bi = ai + 1; bi < glyphs.length; bi++) {
          const { g: ga, idx: ia } = glyphs[ai];
          const { g: gb, idx: ib } = glyphs[bi];
          const ca = slotCenter(ia, cs, gx0, gy0);
          const cb = slotCenter(ib, cs, gx0, gy0);
          const dist = p.dist(ca.x, ca.y, cb.x, cb.y);
          if (dist > maxDist) continue;

          const distFactor = 1 - dist / maxDist;
          const alphaFactor = Math.min(getAlpha(ga), getAlpha(gb)) / 255;
          const baseAlpha = alphaFactor * distFactor * ageFactor;

          p.push();
          if (isCurrentSession) {
            p.stroke(0, 210, 230, baseAlpha * 120);
            p.strokeWeight(0.8);
            p.drawingContext.setLineDash([]);
          } else {
            p.stroke(0, 180, 200, baseAlpha * 50);
            p.strokeWeight(0.5);
            p.drawingContext.setLineDash([3, 6]);
          }
          p.line(ca.x, ca.y, cb.x, cb.y);
          p.drawingContext.setLineDash([]);
          p.pop();
        }
      }
    });
  }

  // ====== 글리프 렌더 ======
  function drawGlyph(g, tx, ty, cs) {
    const alpha = getAlpha(g);
    const scale = g.isBig ? 2 : 1;
    const currentCS = cs * scale;
    const maxToShow = Math.floor(g.rects.length * g.progress);

    p.push();
    if (g.isActive) {
      p.noFill();
      p.stroke(0, 210, 230, 180);
      p.strokeWeight(1.5);
      p.drawingContext.setLineDash([8, 4]);
      p.rect(tx + 4, ty + 4, currentCS - 8, currentCS - 8);
      p.drawingContext.setLineDash([]);
    }

    p.noStroke();
    const glitch = g.isActive && p.random() > 0.98;
    p.fill(220, 255, 255, glitch ? 150 : alpha);

    const xOff = glitch ? p.random(-5, 5) : 0;
    for (let i = 0; i < maxToShow; i++) {
      const r = g.rects[i];
      if (r) p.rect(tx + r.x * scale + xOff, ty + r.y * scale, r.s * scale, r.s * scale);
    }
    p.pop();
  }

  function getAlpha(g) {
    if (g.isActive) return 255;
    if (!g.fadeStartFrame) return 50;
    const ratio = p.constrain((p.frameCount - g.fadeStartFrame) / FADE_OUT_FRAMES, 0, 1);
    return p.lerp(255, 50, ratio);
  }

  p.setup = () => {
    p.createCanvas(window.innerWidth, window.innerHeight);
    updateGridConfig();
    for (let i = 0; i < 15; i++) {
      backgroundNodes.push({
        x: p.random(p.width), y: p.random(p.height),
        speed: p.random(0.5, 1.5), opacity: p.random(10, 30)
      });
    }
    p.noLoop();
  };

  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    updateGridConfig();
    p.loop();
  };

  p.draw = () => {
    p.background(...BG);
    const cs = cellSize();
    const { x: gx0, y: gy0 } = gridOrigin();

    // 배경 노드
    p.fill(0, 210, 230, 20);
    p.textSize(12);
    p.textFont("monospace");
    backgroundNodes.forEach((n, i) => {
      p.text(activeHash.substring(i, i + 15), n.x, n.y);
      n.y += n.speed;
      if (n.y > p.height) n.y = -20;
    });

    // 그리드 가이드
    p.stroke(0, 200, 210, 30);
    for (let i = 0; i <= COLS; i++) p.line(gx0 + i * cs, gy0, gx0 + i * cs, gy0 + cs * ROWS);
    for (let i = 0; i <= ROWS; i++) p.line(gx0, gy0 + i * cs, gx0 + cs * COLS, gy0 + i * cs);

    // 관계선 (글리프 아래 레이어)
    drawConnections(cs, gx0, gy0);

    // 글리프 렌더
    let isAnimating = false;
    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (!g || g.hidden) continue;

      const tx = gx0 + (i % COLS) * cs;
      const ty = gy0 + Math.floor(i / COLS) * cs;

      if (!g.done) {
        g.progress += 1 / BUILD_FRAMES;
        if (g.progress >= 1) { g.progress = 1; g.done = true; }
        isAnimating = true;
      }
      if (g.fadeStartFrame && (p.frameCount - g.fadeStartFrame) < FADE_OUT_FRAMES) {
        isAnimating = true;
      }

      drawGlyph(g, tx, ty, cs);
    }
    if (!isAnimating) p.noLoop();
  };

  channel.onmessage = async (ev) => {
    if (ev.data?.type === "entry") {
      const text = ev.data.text || "";
      activeHash = await computeHash(text);

      const currentSession = sessionCounter++;

      slots.forEach(s => {
        if (s && s.isActive) {
          s.isActive = false;
          s.fadeStartFrame = p.frameCount;
        }
      });

      const chars = text.toUpperCase().replace(/\s/g, "").split("").slice(0, 20);
      const cs = cellSize();

      for (const ch of chars) {
        let free = [];
        for (let i = 0; i < CAPACITY; i++) if (slots[i] === null) free.push(i);

        if (free.length < CAPACITY * 0.4) {
          purgeOldest(Math.floor(CAPACITY * 0.45));
          free = [];
          for (let i = 0; i < CAPACITY; i++) if (slots[i] === null) free.push(i);
        }

        if (free.length === 0) continue;

        const idx = p.random(free);
        const isBig = p.random() > 0.7 && canOccupy2x2(idx);
        const rects = generateRects(ch, cs);

        const glyph = {
          ch, isBig, rects,
          progress: 0, done: false,
          isActive: true, fadeStartFrame: null,
          sessionId: currentSession,
        };

        if (isBig) occupy2x2(idx, glyph);
        else slots[idx] = glyph;

        queue.push(glyph);
      }
      p.loop();
    }
  };
});