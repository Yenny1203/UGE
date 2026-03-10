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

  // ====== Pulse 설정 ======
  // pulse 하나가 A→B 를 이동하는 데 걸리는 프레임 수
  const PULSE_TRAVEL_FRAMES = 60;
  // 동시에 같은 연결에 존재할 수 있는 최대 pulse 수
  const PULSE_MAX_PER_EDGE = 2;
  // pulse가 연결선 위를 이동하는 점의 크기
  const PULSE_DOT_SIZE = 4;
  // pulse 생성 간격 (프레임). 새 session 진입 후 이 간격마다 pulse 추가 생성
  const PULSE_SPAWN_INTERVAL = 30;

  // pulses: [{ fromIdx, toIdx, t, sessionId, createdFrame }]
  let pulses = [];
  let lastPulseSpawnFrame = -9999;

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
    pulses = [];
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

  // ====== Pulse 생성 ======
  // 현재 활성 세션의 연결 가능한 엣지 목록을 모아서 pulse를 spawning
  function spawnPulsesForSession(sessionId, cs, gx0, gy0) {
    const maxDist = CONNECTION_MAX_DIST_CELLS * cs;
    const glyphs = [];

    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (!g || g.hidden) continue;
      if (g.sessionId === sessionId) glyphs.push({ g, idx: i });
    }

    if (glyphs.length < 2) return;

    // 연결 가능한 엣지 수집
    const edges = [];
    for (let ai = 0; ai < glyphs.length; ai++) {
      for (let bi = ai + 1; bi < glyphs.length; bi++) {
        const { idx: ia } = glyphs[ai];
        const { idx: ib } = glyphs[bi];
        const ca = slotCenter(ia, cs, gx0, gy0);
        const cb = slotCenter(ib, cs, gx0, gy0);
        const dist = p.dist(ca.x, ca.y, cb.x, cb.y);
        if (dist <= maxDist) edges.push({ ia, ib });
      }
    }

    if (edges.length === 0) return;

    // 엣지 중 랜덤으로 골라 pulse 생성 (최대 pulse 수 제한)
    const edge = p.random(edges);
    const { ia, ib } = edge;

    // 이미 이 엣지에 pulse가 너무 많으면 생략
    const existing = pulses.filter(
      pu => (pu.fromIdx === ia && pu.toIdx === ib) ||
            (pu.fromIdx === ib && pu.toIdx === ia)
    );
    if (existing.length >= PULSE_MAX_PER_EDGE) return;

    // 방향: 랜덤하게 A→B 또는 B→A
    const [from, to] = p.random() > 0.5 ? [ia, ib] : [ib, ia];
    pulses.push({
      fromIdx: from,
      toIdx: to,
      t: 0,                     // 0 ~ 1 진행도
      sessionId,
      createdFrame: p.frameCount,
    });
  }

  // ====== 관계선 + Pulse 렌더 ======
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

    // 현재 유효 엣지 목록 (pulse 충돌 검사용)
    const validEdges = new Set();

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

          // 유효 엣지로 등록
          validEdges.add(`${Math.min(ia, ib)}-${Math.max(ia, ib)}`);

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

    // ====== Pulse 업데이트 & 렌더 ======
    // 유효하지 않은 엣지의 pulse 제거 + 완료된 pulse 제거
    pulses = pulses.filter(pu => {
      if (pu.t >= 1) return false;
      const key = `${Math.min(pu.fromIdx, pu.toIdx)}-${Math.max(pu.fromIdx, pu.toIdx)}`;
      return validEdges.has(key);
    });

    // pulse 이동 + 렌더
    for (const pu of pulses) {
      pu.t += 1 / PULSE_TRAVEL_FRAMES;
      pu.t = Math.min(pu.t, 1);

      const ca = slotCenter(pu.fromIdx, cs, gx0, gy0);
      const cb = slotCenter(pu.toIdx, cs, gx0, gy0);

      if (!ca || !cb) continue;

      const px = p.lerp(ca.x, cb.x, pu.t);
      const py = p.lerp(ca.y, cb.y, pu.t);

      // 현재 세션 pulse는 밝게, 이전 세션은 희미하게
      const isCurrentSession = pu.sessionId === sessionCounter - 1;

      // pulse의 글리프 alpha 반영
      const gFrom = slots[pu.fromIdx];
      const gTo   = slots[pu.toIdx];
      const alphaFactor = (gFrom && gTo)
        ? Math.min(getAlpha(gFrom), getAlpha(gTo)) / 255
        : 1;

      p.push();
      p.noStroke();

      if (isCurrentSession) {
        // 현재 세션: 밝은 cyan glow 효과
        // 외곽 glow (큰 반투명 원)
        p.fill(0, 210, 230, 40 * alphaFactor);
        p.circle(px, py, PULSE_DOT_SIZE * 4);

        // 중간 glow
        p.fill(0, 230, 255, 100 * alphaFactor);
        p.circle(px, py, PULSE_DOT_SIZE * 2);

        // 핵심 점
        p.fill(200, 255, 255, 220 * alphaFactor);
        p.circle(px, py, PULSE_DOT_SIZE);

      } else {
        // 이전 세션: 희미한 pulse
        p.fill(0, 180, 200, 60 * alphaFactor);
        p.circle(px, py, PULSE_DOT_SIZE * 1.5);
      }

      p.pop();
    }

    // ====== 주기적 pulse 생성 ======
    // 현재 세션에 대해 PULSE_SPAWN_INTERVAL 마다 새 pulse 추가
    if (
      sessionCounter > 0 &&
      p.frameCount - lastPulseSpawnFrame >= PULSE_SPAWN_INTERVAL
    ) {
      spawnPulsesForSession(sessionCounter - 1, cs, gx0, gy0);
      lastPulseSpawnFrame = p.frameCount;
    }
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

    // ── 레이어 1: 배경 hash 텍스트 (고정, 희미) ──
    p.fill(0, 210, 230, 10);
    p.textSize(11);
    p.textFont("monospace");
    backgroundNodes.forEach((n, i) => {
      p.text(activeHash.substring(i % activeHash.length, (i % activeHash.length) + 12), n.x, n.y);
    });

    // ── 레이어 2: 그리드 (고정, 낮은 opacity) ──
    p.stroke(0, 200, 210, 12);
    p.strokeWeight(1);
    for (let i = 0; i <= COLS; i++) p.line(gx0 + i * cs, gy0, gx0 + i * cs, gy0 + cs * ROWS);
    for (let i = 0; i <= ROWS; i++) p.line(gx0, gy0 + i * cs, gx0 + cs * COLS, gy0 + i * cs);

    // ── 레이어 3: 글리프 + 관계선 + pulse ──
    // 관계선 + Pulse
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

    // pulse가 살아있으면 루프 유지
    if (pulses.length > 0) isAnimating = true;

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

      // 새 entry 진입 시 기존 pulse 초기화 (새 세션 pulse로 교체)
      pulses = pulses.filter(pu => pu.sessionId !== currentSession);
      lastPulseSpawnFrame = p.frameCount - PULSE_SPAWN_INTERVAL;

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
