import { generatePatternCells } from "./common.js";

const channel = new BroadcastChannel("dual-screen-patterns");

new p5((p) => {
  let COLS, ROWS, CAPACITY;
  const CELL_MIN_SIZE = 85;
  const CELL_MAX_SIZE = 160;
  const GRID_MAX_COLS = 16;
  const GRID_MAX_ROWS = 9;
  const MARGIN = 60;

  const BG = [8, 9, 11];

  let slots = [];
  let queue = [];
  let activeHash = "00000000000000000000000000000000";
  let backgroundNodes = [];

  const FADE_OUT_FRAMES = 180;
  const BUILD_FRAMES = 45;

  const FILL_THRESHOLD = 0.50;
  const GLITCH_DEATH_FRAMES = 45;
  let glitchParticles = [];

  const ZONE_MORPH_FRAMES = 60 * 60 * 2;
  let zones        = [];
  let orphanGlyphs = [];
  let zoneVersion  = 0;
  let lastMorphFrame = 0;

  const CONNECTION_MAX_DIST_CELLS = 6;
  const CONNECTION_MAX_SESSIONS = 3;
  const PULSE_TRAVEL_FRAMES = 80;
  const PULSE_SPAWN_INTERVAL = 40;

  let pulses = [];
  let lastPulseSpawnFrame = -9999;
  let sessionCounter = 0;
  let lastEntryFrame = -9999;

  let ghostGlyphs = [];

  const ERROR_POOL = [
    "CORRUPT_SECTOR://0x000F42_DATA_LOSS",
    "RECOVERY_FAILED... [RETRY: 0]",
    "/VOID_POINTER_EXCEPTION//",
    "FRAGMENT_ID: 992-B // CRC_ERROR",
    "[SYSTEM_HALT] :: ADDR_INVALID",
    "DECODE_ATTEMPT_04_FAILED@773",
    "CHECKSUM_MISMATCH :: 0xDEADBEEF",
    "BUFFER_OVERFLOW >> STACK_TRACE",
    "NULL_REF :: SECTOR [F7-3C]",
    "MEMORY_FAULT // REGION_LOCKED",
    "SYNC_LOST... ATTEMPTING RESYNC",
    "PACKET_DROP_RATE: 87.3%",
    "ENTROPY_THRESHOLD_EXCEEDED",
    "AUTH_TOKEN_EXPIRED :: REVOKED",
    "KERNEL_PANIC // CORE_DUMP_0x44",
  ];

  const STAMP_POOL = [
    { text: "ACCESS: DENIED", color: [145, 40, 44], size: 28, border: true },
    { text: "CONFIDENTIAL", color: [145, 40, 44], size: 22, border: true },
    { text: "REC ● S3CR3T", color: [145, 40, 44], size: 16, border: false },
    { text: "DELETION_PENDING", color: [142, 52, 55], size: 14, border: false },
    { text: "OVERRIDE_REQUIRED", color: [145, 40, 44], size: 13, border: false },
    { text: "USER_ID: ANONYMOUS_#092", color: [145, 40, 44], size: 13, border: false },
    { text: "SIGNAL_TRACE: ACTIVE", color: [142, 52, 55], size: 13, border: false },
    { text: "RESTRICTED_AREA // NO_ACCESS", color: [145, 40, 44], size: 12, border: false },
  ];

  let activeStamps = [];
  let overlayLogs = [];
  let cornerTexts = [];
  let scrollingLog = [];
  let scrollX = 0;

  let scribbleTraces = [];
  let sessionLayouts = [];

  // ══════════════════════════════════════════════════════
  // Size-aware hierarchy helpers
  // ══════════════════════════════════════════════════════

  function getGlyphSize(g) {
    return g.size || 'S';
  }

  function getGlyphPriority(g) {
    const s = getGlyphSize(g);
    if (s === 'L') return 3;
    if (s === 'M') return 2;
    return 1;
  }

  function countLiveGlyphsBySize() {
    const counts = { L: 0, M: 0, S: 0 };
    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (!g || g.hidden || g.dying) continue;
      const sz = getGlyphSize(g);
      counts[sz] = (counts[sz] || 0) + 1;
    }
    return counts;
  }

  function getLiveAnchors() {
    const anchors = [];
    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (!g || g.hidden || g.dying) continue;
      if (getGlyphSize(g) === 'L') anchors.push({ g, idx: i });
    }
    return anchors;
  }

  // D. 각 live L마다 가장 가까운 M 1개만 필수 support
  function getNecessarySupportIdxPerAnchor() {
    const anchors = getLiveAnchors();
    const necessary = new Set();
    for (const { g: anchor } of anchors) {
      const lCol = anchor.zone ? anchor.zone.col : 0;
      const lRow = anchor.zone ? anchor.zone.row : 0;
      let closest = null;
      let closestDist = Infinity;
      for (let i = 0; i < CAPACITY; i++) {
        const g = slots[i];
        if (!g || g.hidden || g.dying) continue;
        if (getGlyphSize(g) !== 'M') continue;
        const mCol = g.zone ? g.zone.col : (i % COLS);
        const mRow = g.zone ? g.zone.row : Math.floor(i / COLS);
        const dist = Math.abs(mCol - lCol) + Math.abs(mRow - lRow);
        if (dist < closestDist) { closestDist = dist; closest = i; }
      }
      if (closest !== null) necessary.add(closest);
    }
    return necessary;
  }

  // B. holdUntilSession 기반 isHolding 판별
  function isGlyphHolding(g) {
    if (g.holdUntilSession === undefined) return false;
    return sessionCounter < g.holdUntilSession;
  }

  // B. getAlpha: holdUntilSession 기반
  function getAlpha(g) {
    if (g.dying) {
      const elapsed = p.frameCount - g.deathFrame;
      const deathRatio = p.constrain(elapsed / GLITCH_DEATH_FRAMES, 0, 1);
      // start from whatever the glyph's natural alpha was — no flash
      const startAlpha = g.isActive ? 200
        : isGlyphHolding(g) ? (getGlyphSize(g) === 'L' ? 155 : 110)
        : g.fadeStartFrame ? p.lerp(200, 42, p.constrain((p.frameCount - g.fadeStartFrame) / FADE_OUT_FRAMES, 0, 1))
        : 44;
      return p.lerp(startAlpha, 0, deathRatio);
    }
    if (g.isActive) return 200;
    if (isGlyphHolding(g)) {
      return getGlyphSize(g) === 'L' ? 150 : 105;
    }
    if (g.fadeStartFrame) {
      const ratio = p.constrain((p.frameCount - g.fadeStartFrame) / FADE_OUT_FRAMES, 0, 1);
      return p.lerp(200, 38, ratio);
    }
    return 38;
  }

  // C. canRemoveGlyph: holdUntilSession + anchor protection
  function canRemoveGlyph(g) {
    const sz = getGlyphSize(g);

    // F. holdUntilSession이 남아 있으면 제거 불가
    if (isGlyphHolding(g)) return false;

    // bornSession 기반 cluster lock
    if (sz === 'L') {
      if (g.bornSession !== undefined && sessionCounter - g.bornSession < 2) return false;
    }

    // B. L anchor 보호: live L이 1개 이하이면 제거 금지
    if (sz === 'L') {
      const counts = countLiveGlyphsBySize();
      return counts.L > 1;
    }

    // D. M: 각 anchor의 nearest support만 보호 (1개)
    if (sz === 'M') {
      const necessaryIdxs = getNecessarySupportIdxPerAnchor();
      for (let i = 0; i < CAPACITY; i++) {
        if (slots[i] === g && necessaryIdxs.has(i)) return false;
      }
    }

    return true;
  }

  // C. getEvictionCandidates: holdUntilSession 제외
  function getEvictionCandidates() {
    const all = [];
    for (const g of queue) {
      if (!g || g.dying || g.isActive) continue;
      if (isGlyphHolding(g)) continue;
      if (!canRemoveGlyph(g)) continue;
      all.push(g);
    }
    all.sort((a, b) => getGlyphPriority(a) - getGlyphPriority(b));
    return all;
  }

  // ══════════════════════════════════════════════════════
  // A. chooseZoneForSession: drift-aware bucket selection
  // ══════════════════════════════════════════════════════

  function chooseZoneForSession(_layout) {
    const empty = zones.filter(z =>
      z.active && z.slots.every(idx => slots[idx] === null)
    );
    if (empty.length === 0) return null;

    const anchors = getLiveAnchors();

    // bucket 1: near-anchor (dist 1~3), M/S
    const nearBucket = [];
    // bucket 2: mid-drift (dist 4~7), M/S
    const midBucket = [];
    // bucket 3: support (live M 주변 1~3 거리 empty S)
    const supportBucket = [];

    if (anchors.length > 0) {
      for (const z of empty) {
        if (z.size === 'L') continue;
        let minDist = Infinity;
        for (const { g: anchor } of anchors) {
          const lCol = anchor.zone ? anchor.zone.col : 0;
          const lRow = anchor.zone ? anchor.zone.row : 0;
          const dist = Math.abs(z.col - lCol) + Math.abs(z.row - lRow);
          if (dist < minDist) minDist = dist;
        }
        if (minDist >= 1 && minDist <= 3) nearBucket.push(z);
        else if (minDist >= 4 && minDist <= 7) midBucket.push(z);
      }
    }

    // support bucket: live M 주변 1~3 거리 empty S
    const liveMs = [];
    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (!g || g.hidden || g.dying) continue;
      if (getGlyphSize(g) === 'M') liveMs.push(g);
    }
    if (liveMs.length > 0) {
      for (const z of empty) {
        if (z.size !== 'S') continue;
        let nearM = false;
        for (const m of liveMs) {
          const mCol = m.zone ? m.zone.col : 0;
          const mRow = m.zone ? m.zone.row : 0;
          const dist = Math.abs(z.col - mCol) + Math.abs(z.row - mRow);
          if (dist <= 3) { nearM = true; break; }
        }
        if (nearM) supportBucket.push(z);
      }
    }

    // bucket 확률 선택
    const roll = p.random();
    const nearProb   = 0.30;
    const midProb    = 0.45;
    const suppProb   = 0.15;
    // fallback deficit: 나머지

    if (roll < nearProb && nearBucket.length > 0) {
      return p.random(nearBucket);
    }
    if (roll < nearProb + midProb && midBucket.length > 0) {
      return p.random(midBucket);
    }
    if (roll < nearProb + midProb + suppProb && supportBucket.length > 0) {
      return p.random(supportBucket);
    }

    // fallback: deficit-based
    const counts = { L: 0, M: 0, S: 0 };
    for (const z of zones) {
      if (z.slots[0] !== undefined && slots[z.slots[0]] && !slots[z.slots[0]].hidden)
        counts[z.size] = (counts[z.size] || 0) + 1;
    }
    const total = counts.L + counts.M + counts.S + 1;
    const ratios = { L: counts.L / total, M: counts.M / total, S: counts.S / total };
    const targets = { L: 0.15, M: 0.30, S: 0.55 };
    const deficits = ['L', 'M', 'S'].map(s => ({ size: s, deficit: targets[s] - ratios[s] }));
    deficits.sort((a, b) => b.deficit - a.deficit);
    for (const { size } of deficits) {
      const pool = empty.filter(z => z.size === size);
      if (pool.length > 0) return p.random(pool);
    }
    return p.random(empty);
  }

  function occupyZone(zone, glyph) {
    slots[zone.slots[0]] = glyph;
    for (let i = 1; i < zone.slots.length; i++) {
      slots[zone.slots[i]] = { hidden: true, parentIdx: zone.slots[0] };
    }
  }

  function freeZone(zone) {
    for (const idx of zone.slots) slots[idx] = null;
  }

  function cellSize() {
    const cs = Math.min(
      (p.width - MARGIN * 2) / COLS,
      (p.height - MARGIN * 2) / ROWS
    );
    return Math.min(cs, CELL_MAX_SIZE);
  }

  function gridOrigin() {
    const cs = cellSize();
    return {
      x: p.width / 2 - (cs * COLS) / 2,
      y: p.height / 2 - (cs * ROWS) / 2,
    };
  }

  function slotCenter(idx, cs, gx0, gy0) {
    const g = slots[idx];
    if (!g) return null;
    if (g.hidden && g.parentIdx !== undefined) return slotCenter(g.parentIdx, cs, gx0, gy0);
    const col  = g.zone ? g.zone.col : (idx % COLS);
    const row  = g.zone ? g.zone.row : Math.floor(idx / COLS);
    const w    = g.zoneW || cs;
    const offX = g.zone ? (g.zone.offX || 0) * p.width  : 0;
    const offY = g.zone ? (g.zone.offY || 0) * p.height : 0;
    return {
      x: gx0 + col * cs + offX + w / 2,
      y: gy0 + row * cs + offY + w / 2,
    };
  }

  async function computeHash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text + Date.now());
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function freeSlot(idx, g) {
    slots[idx] = null;
    if (g && g.isBig) {
      if (idx + 1 < CAPACITY) slots[idx + 1] = null;
      if (idx + COLS < CAPACITY) slots[idx + COLS] = null;
      if (idx + COLS + 1 < CAPACITY) slots[idx + COLS + 1] = null;
    }
  }

  function occupancyRate() {
    const activeSlots = zones.filter(z => z.active).flatMap(z => z.slots);
    if (activeSlots.length === 0) return 0;
    const occupied = activeSlots.filter(idx => slots[idx] !== null).length;
    return occupied / activeSlots.length;
  }

  function spawnGlitchParticles(tx, ty, cs, scale) {
    const count = 12 + Math.floor(Math.random() * 8);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 4 + 1.5;
      glitchParticles.push({
        x: tx + cs * scale * 0.5,
        y: ty + cs * scale * 0.5,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.0,
        decay: Math.random() * 0.04 + 0.03,
        size: Math.random() * 5 + 2,
        isRed: Math.random() > 0.5,
      });
    }
  }

  // F. evictIfOverfilled: holdUntilSession 기준 제외
  function evictIfOverfilled() {
    if (p.frameCount - lastEntryFrame < 90) return;
    if (occupancyRate() < FILL_THRESHOLD) return;
    if (!activeStamps.find(s => s.text === "ACCESS: DENIED")) {
      spawnStamp("ACCESS: DENIED", "bottomRight");
    }
    const candidates = getEvictionCandidates();
    let evicted = 0;
    for (const g of candidates) {
      if (evicted >= 2) break;
      g.dying = true;
      g.holdUntilSession = undefined;
      g.deathFrame = p.frameCount;
      if (!g.sliceOffsets) {
        g.sliceOffsets = [];
        for (let _k = 0; _k < 6; _k++) g.sliceOffsets.push(p.random(-15, 15));
      }
      evicted++;
    }
  }

  function spawnGhostFromGlyph(g, tx, ty) {
    if (getGlyphSize(g) === 'L') return;
    if (p.random() > 0.30) return;
    const nearby = ghostGlyphs.filter(gh =>
      Math.abs(gh.tx - tx) < 10 && Math.abs(gh.ty - ty) < 10
    );
    if (nearby.length >= 2) return;

    const sampleRatio = p.random(0.40, 0.55);
    const sampledRects = p.shuffle([...g.rects])
      .slice(0, Math.floor(g.rects.length * sampleRatio));

    ghostGlyphs.push({
      tx, ty,
      zoneW: g.zoneW,
      zoneH: g.zoneH,
      rects: sampledRects,
      sessionId: g.sessionId,
      createdSession: g.sessionId,
    });
  }

  function getGhostAlpha(gh) {
    const age = (sessionCounter - 1) - gh.createdSession;
    if (age <= 0) return 0;
    if (age === 1) return 90;
    if (age === 2) return 28;
    return 0;
  }

  function drawGhostGlyphs() {
    ghostGlyphs = ghostGlyphs.filter(gh => {
      const age = (sessionCounter - 1) - gh.createdSession;
      return age < 3;
    });

    for (const gh of ghostGlyphs) {
      const alpha = getGhostAlpha(gh);
      if (alpha <= 0) continue;

      // 15–28% of rects only — broken scatter, not a readable shape
      const sampleCount = Math.floor(gh.rects.length * p.random(0.15, 0.28));
      const sampledRects = gh.rects.slice(0, sampleCount);

      p.push();
      p.translate(gh.tx, gh.ty);
      p.noStroke();
      for (const r of sampledRects) {
        if (!r) continue;
        // age-1 ghosts slightly brighter, age-2 very dim
        p.fill(82, 118, 126, alpha * r.alphaBias * 0.28);
        p.rect(r.x, r.y, r.sw, r.sh);
      }
      // no corner hints, no border — pure atmosphere
      p.pop();
    }
  }

  function generateRects(ch, pw, ph) {
    const cells = generatePatternCells(ch, p);
    if (!cells || cells.length === 0) return [];
    const sq = (pw && pw > 20) ? pw : cellSize();
    const inset = sq * 0.1;
    const mini = (sq - inset * 2) / 7;
    return p.shuffle(
      cells.map((c) => ({
        j: c.j, i: c.i,
        x: inset + c.j * mini,
        y: inset + c.i * mini,
        sw: mini - 1,
        sh: mini - 1,
        alphaBias: p.random(0.55, 1),
        echo: p.random() > 0.84,
      }))
    );
  }

  function createSessionLayout(sessionId) {
    const anchorX = p.random(p.width * 0.25, p.width * 0.75);
    const anchorY = p.random(p.height * 0.25, p.height * 0.75);
    const driftAngle = p.random(Math.PI * 2);
    return {
      sessionId, anchorX, anchorY,
      secondaryX: anchorX + Math.cos(driftAngle) * p.random(120, 220),
      secondaryY: anchorY + Math.sin(driftAngle) * p.random(90, 180),
      driftAngle,
      spreadA: p.random(90, 180),
      spreadB: p.random(120, 220),
    };
  }

  function getSessionLayout(sessionId) {
    let found = sessionLayouts.find(s => s.sessionId === sessionId);
    if (!found) { found = createSessionLayout(sessionId); sessionLayouts.push(found); }
    return found;
  }

  function spawnStamp(text, position, options = {}) {
    if (activeStamps.find(s => s.text === text)) return;
    const base = STAMP_POOL.find(s => s.text === text) ||
      { text, color: [145, 40, 44], size: 18, border: false };
    const positions = {
      bottomRight: { x: p.width - MARGIN, y: p.height - MARGIN - 62, align: "right", angle: 0 },
      topCenter:   { x: p.width / 2, y: MARGIN + 30, align: "center", angle: 0 },
      topLeft:     { x: MARGIN + 80, y: MARGIN + 70, align: "center", angle: -0.12 },
      midLeft:     { x: MARGIN + 20, y: p.height * 0.45, align: "left", angle: 0 },
      midRight:    { x: p.width - MARGIN - 20, y: p.height * 0.45, align: "right", angle: 0 },
    };
    const pos = positions[position] || positions.topCenter;
    const life = options.life || 200;
    activeStamps.push({ ...base, ...pos, life, maxLife: life });
  }

  function drawStamps() {
    activeStamps = activeStamps.filter((st) => {
      st.life--;
      if (st.life <= 0) return false;
      const fadeIn  = p.constrain((st.maxLife - st.life) / 18, 0, 1);
      const fadeOut = p.constrain(st.life / 22, 0, 1);
      const alpha = Math.min(fadeIn, fadeOut) * 255;
      const blink = st.size >= 20 && p.frameCount % 8 < 1 ? 0 : 1;
      p.push();
      p.translate(st.x, st.y);
      p.rotate(st.angle || 0);
      if (st.border) {
        const tw = st.text.length * st.size * 0.62;
        const th = st.size + 14;
        p.stroke(st.color[0], st.color[1], st.color[2], alpha * 0.72 * blink);
        p.strokeWeight(1.4);
        p.noFill();
        if (st.align === "right") p.rect(-tw - 10, -th / 2 - 4, tw + 20, th + 8);
        else p.rect(-tw / 2 - 10, -th / 2 - 4, tw + 20, th + 8);
      }
      p.noStroke();
      p.fill(st.color[0], st.color[1], st.color[2], alpha * blink);
      p.textFont("monospace");
      p.textSize(st.size);
      if (st.align === "right") p.textAlign(p.RIGHT, p.CENTER);
      else if (st.align === "left") p.textAlign(p.LEFT, p.CENTER);
      else p.textAlign(p.CENTER, p.CENTER);
      p.text(st.text, 0, 0);
      p.pop();
      return true;
    });
  }

  function drawGrain() {
    const ctx = p.drawingContext;
    ctx.save();
    for (let i = 0; i < 700; i++) {
      const gx = Math.random() * p.width;
      const gy = Math.random() * p.height;
      const br = Math.random() * 40;
      const ga = Math.random() * 0.2;
      ctx.fillStyle = `rgba(${br},${br},${br},${ga})`;
      ctx.fillRect(gx, gy, 1, 1);
    }
    ctx.restore();
    p.noStroke();
    p.fill(90, 138, 148, 40);
    p.textFont("monospace");
    p.textSize(10);
    p.textAlign(p.RIGHT);
    for (let i = 0; i < 8; i++) {
      p.text("—", p.width - MARGIN + 30, p.height * 0.3 + i * 28);
    }
  }

  function drawOverlayTexts() {
    p.textFont("monospace");
    p.noStroke();
    cornerTexts.forEach((ct) => {
      const blinkAlpha = ct.blink
        ? 80 + 70 * Math.sin(p.frameCount * 0.05)
        : (ct.color[3] ?? 255);
      const [r, g, b] = ct.color;
      p.fill(r, g, b, blinkAlpha);
      p.textSize(11);
      if (ct.align === "right") {
        p.textAlign(p.RIGHT); p.text(ct.text, ct.x, ct.y); p.textAlign(p.LEFT);
      } else {
        p.text(ct.text, ct.x, ct.y);
      }
    });
    drawTimestamp();
    if (activeHash !== "00000000000000000000000000000000") {
      p.fill(90, 138, 148, 45);
      p.textSize(9);
      const hashLines = activeHash.match(/.{1,40}/g) || [];
      hashLines.forEach((line, i) => p.text(line, MARGIN, p.height - MARGIN - 92 + i * 13));
    }
    overlayLogs = overlayLogs.filter((log) => {
      log.life -= 1;
      if (log.life <= 0) return false;
      const fadeIn  = p.constrain((log.maxLife - log.life) / 12, 0, 1);
      const fadeOut = p.constrain(log.life / 18, 0, 1);
      const alpha = Math.min(fadeIn, fadeOut) * log.alpha;
      p.fill(145, 40, 44, alpha * 0.85);
      p.textSize(9);
      const revealRatio = 1 - log.life / log.maxLife;
      const charsToShow = Math.floor(log.text.length * Math.min(revealRatio * 4, 1));
      p.text(log.text.substring(0, charsToShow), log.x, log.y);
      if (p.random() > 0.97) {
        p.fill(145, 40, 44, alpha * 0.25);
        p.rect(log.x - 2, log.y - 9, p.random(40, 120), 1);
      }
      return true;
    });
    scrollX -= 0.65;
    const totalScrollWidth = scrollingLog.join("   //   ").length * 7;
    if (Math.abs(scrollX) > totalScrollWidth) scrollX = 0;
    p.fill(90, 138, 148, 26);
    p.textSize(8.5);
    p.textAlign(p.LEFT);
    let sx = scrollX + p.width * 0.12;
    scrollingLog.forEach((txt) => {
      p.text(txt + "   //   ", sx, p.height - 18);
      sx += (txt.length + 6) * 7;
    });
    drawStamps();
  }

  function drawTimestamp() {
    const now = new Date();
    const mm   = String(now.getMonth() + 1).padStart(2, "0");
    const dd   = String(now.getDate()).padStart(2, "0");
    const yyyy = now.getFullYear();
    p.noStroke();
    p.fill(90, 138, 148, 110);
    p.textFont("monospace");
    p.textSize(18);
    p.textAlign(p.RIGHT);
    p.text(`${mm}.${dd}.${yyyy}`, p.width - MARGIN, p.height - MARGIN);
  }

  function spawnOverlayLog(tx, ty, cs) {
    const isRight = tx + cs * 1.5 < p.width - MARGIN;
    overlayLogs.push({
      text: p.random(ERROR_POOL),
      x: isRight ? tx + cs + 8 : tx - 8,
      y: ty + cs * 0.4 + p.random(-10, 10),
      life: 200, maxLife: 200,
      alpha: p.random(140, 200),
    });
  }

  function drawZonesBg(cs, gx0, gy0) {
    if (zones.length === 0) return;
    p.push();
    p.noStroke();
    for (const zone of zones) {
      if (!zone.active) continue;
      const hasGlyph = zone.slots.some(idx => slots[idx] && !slots[idx].hidden);
      if (!hasGlyph) continue;
      const offPx = (zone.offX || 0) * p.width;
      const offPy = (zone.offY || 0) * p.height;
      const px = gx0 + zone.col * cs + offPx;
      const py = gy0 + zone.row * cs + offPy;
      const pw = zone.zw * cs;
      const ph = zone.zh * cs;
      const inset = 3;
      // L zones: very light fill so they read as containers, not solid panels
      // M: slightly lighter than before; S: near-original
      const fillAlpha = zone.size === 'L' ? 55 : zone.size === 'M' ? 110 : 180;
      p.fill(0, 30, 40, fillAlpha);
      p.rect(px + inset, py + inset, pw - inset * 2, ph - inset * 2);
    }
    p.pop();
  }

  function drawZonesBorder(cs, gx0, gy0) {
    if (zones.length === 0) return;
    p.push();
    p.noFill();
    for (const zone of zones) {
      if (zone.opacity < 0.005) continue;
      const hasGlyph = zone.slots.some(idx => slots[idx] && !slots[idx].hidden);
      if (!hasGlyph) continue;

      // determine if the zone's main glyph is active, holding, or residual
      const mainGlyph = slots[zone.slots[0]];
      if (!mainGlyph || mainGlyph.hidden) continue;
      const glyphIsActive  = mainGlyph.isActive;
      const glyphIsHolding = !mainGlyph.isActive && isGlyphHolding(mainGlyph);

      const offPx = (zone.offX || 0) * p.width;
      const offPy = (zone.offY || 0) * p.height;
      const px = gx0 + zone.col * cs + offPx;
      const py = gy0 + zone.row * cs + offPy;
      const pw = zone.zw * cs;
      const ph = zone.zh * cs;
      const inset = 3;

      if (glyphIsActive) {
        // dashed border + bright corner markers
        p.stroke(0, 205, 228, 140 * zone.opacity);
        p.strokeWeight(1.0);
        p.drawingContext.setLineDash([5, 5]);
        p.rect(px + inset, py + inset, pw - inset * 2, ph - inset * 2);
        p.drawingContext.setLineDash([]);
        const bLen = Math.min(16, pw * 0.20);
        p.stroke(105, 155, 162, 200 * zone.opacity);
        p.strokeWeight(1.6);
        const corners = [
          [px + inset,      py + inset     ],
          [px + pw - inset, py + inset     ],
          [px + inset,      py + ph - inset],
          [px + pw - inset, py + ph - inset],
        ];
        corners.forEach(([cx, cy]) => {
          const dx = cx < px + pw / 2 ? 1 : -1;
          const dy = cy < py + ph / 2 ? 1 : -1;
          p.line(cx, cy, cx + dx * bLen, cy);
          p.line(cx, cy, cx, cy + dy * bLen);
        });
      } else if (glyphIsHolding) {
        // holding: only corner ticks, no dashed rect, much dimmer
        const bLen = Math.min(10, pw * 0.12);
        p.stroke(100, 148, 158, 55 * zone.opacity);
        p.strokeWeight(0.9);
        const corners = [
          [px + inset,      py + inset     ],
          [px + pw - inset, py + inset     ],
          [px + inset,      py + ph - inset],
          [px + pw - inset, py + ph - inset],
        ];
        corners.forEach(([cx, cy]) => {
          const dx = cx < px + pw / 2 ? 1 : -1;
          const dy = cy < py + ph / 2 ? 1 : -1;
          p.line(cx, cy, cx + dx * bLen, cy);
          p.line(cx, cy, cx, cy + dy * bLen);
        });
      }
      // residual zones: no border drawn
    }
    p.pop();
  }

  function drawConnections(cs, gx0, gy0) {
    const sessionMap = new Map();
    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (!g || g.hidden) continue;
      if (!sessionMap.has(g.sessionId)) sessionMap.set(g.sessionId, []);
      sessionMap.get(g.sessionId).push({ g, idx: i });
    }
    const sessions = [...sessionMap.entries()].sort((a, b) => b[0] - a[0]);
    const maxDistCurrent = CONNECTION_MAX_DIST_CELLS * cs;
    const validEdges = new Set();

    sessions.slice(0, CONNECTION_MAX_SESSIONS).forEach(([sid, glyphs], ageIdx) => {
      const isCurrent = sid === sessionCounter - 1;
      const maxDist   = isCurrent ? maxDistCurrent : maxDistCurrent * 0.55;
      // reference-style ageFactor: 1.0 current, drops for older sessions
      const ageFactor = 1 - ageIdx / CONNECTION_MAX_SESSIONS;

      for (let ai = 0; ai < glyphs.length; ai++) {
        for (let bi = ai + 1; bi < glyphs.length; bi++) {
          const { g: ga, idx: ia } = glyphs[ai];
          const { g: gb, idx: ib } = glyphs[bi];
          const ca = slotCenter(ia, cs, gx0, gy0);
          const cb = slotCenter(ib, cs, gx0, gy0);
          if (!ca || !cb) continue;
          const d = p.dist(ca.x, ca.y, cb.x, cb.y);
          if (d > maxDist) continue;

          validEdges.add(`${Math.min(ia, ib)}-${Math.max(ia, ib)}`);

          const distFactor  = 1 - d / maxDist;
          const alphaFactor = Math.min(getAlpha(ga), getAlpha(gb)) / 255;
          const baseAlpha   = alphaFactor * distFactor * ageFactor;

          p.push();
          p.noFill();
          if (isCurrent) {
            // current session: solid line, muted teal
            p.stroke(90, 138, 148, baseAlpha * 110);
            p.strokeWeight(0.8);
            p.drawingContext.setLineDash([]);
          } else {
            // older sessions: dashed, much dimmer
            p.stroke(60, 95, 104, baseAlpha * 45);
            p.strokeWeight(0.5);
            p.drawingContext.setLineDash([3, 6]);
          }
          p.line(ca.x, ca.y, cb.x, cb.y);
          p.drawingContext.setLineDash([]);
          p.pop();
        }
      }
    });

    // Pulses: current session only
    pulses = pulses.filter((pu) => {
      pu.t += 1 / PULSE_TRAVEL_FRAMES;
      if (pu.t >= 1) return false;
      const key = `${Math.min(pu.fromIdx, pu.toIdx)}-${Math.max(pu.fromIdx, pu.toIdx)}`;
      if (!validEdges.has(key)) return false;
      if (pu.sessionId !== sessionCounter - 1) return false;

      const ca = slotCenter(pu.fromIdx, cs, gx0, gy0);
      const cb = slotCenter(pu.toIdx,   cs, gx0, gy0);
      if (!ca || !cb) return false;

      const gFrom = slots[pu.fromIdx];
      const gTo   = slots[pu.toIdx];
      const alphaFactor = (gFrom && gTo)
        ? Math.min(getAlpha(gFrom), getAlpha(gTo)) / 255
        : 1;

      const px2 = p.lerp(ca.x, cb.x, pu.t);
      const py2 = p.lerp(ca.y, cb.y, pu.t);

      p.push();
      p.noStroke();
      // outer glow
      p.fill(90, 138, 148, 35 * alphaFactor);
      p.circle(px2, py2, 14);
      // mid
      p.fill(110, 160, 170, 90 * alphaFactor);
      p.circle(px2, py2, 6);
      // core dot — paper gray
      p.fill(198, 203, 205, 200 * alphaFactor);
      p.circle(px2, py2, 3);
      p.pop();

      return true;
    });
  }

  function spawnPulsesForSession(sessionId, cs, gx0, gy0) {
    const maxDist = CONNECTION_MAX_DIST_CELLS * cs;
    const glyphs  = [];
    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (g && !g.hidden && g.sessionId === sessionId) glyphs.push(i);
    }
    if (glyphs.length < 2) return;

    // collect valid edges within distance
    const edges = [];
    for (let ai = 0; ai < glyphs.length; ai++) {
      for (let bi = ai + 1; bi < glyphs.length; bi++) {
        const ia = glyphs[ai], ib = glyphs[bi];
        const ca = slotCenter(ia, cs, gx0, gy0);
        const cb = slotCenter(ib, cs, gx0, gy0);
        if (!ca || !cb) continue;
        if (p.dist(ca.x, ca.y, cb.x, cb.y) <= maxDist) edges.push([ia, ib]);
      }
    }
    if (edges.length === 0) return;

    const [ia, ib] = p.random(edges);
    const [from, to] = p.random() > 0.5 ? [ia, ib] : [ib, ia];
    pulses.push({ fromIdx: from, toIdx: to, t: 0, sessionId, createdFrame: p.frameCount });
  }

  function spawnScribbleTracesForSession(sessionId, selectedGlyphIndices, cs, gx0, gy0) {
    if (!selectedGlyphIndices || selectedGlyphIndices.length === 0) return;
    const traceCount = Math.min(2, selectedGlyphIndices.length);
    for (let t = 0; t < traceCount; t++) {
      const idx = selectedGlyphIndices[Math.floor(p.random(selectedGlyphIndices.length))];
      const c = slotCenter(idx, cs, gx0, gy0);
      if (!c) continue;
      const isRed = p.random() > 0.72;
      const pointCount = Math.floor(p.random(28, 52));
      const pts = [];
      let x = c.x + p.random(-20, 20);
      let y = c.y + p.random(-20, 20);
      let angle = p.random(Math.PI * 2);
      for (let i = 0; i < pointCount; i++) {
        angle += p.random(-0.9, 0.9);
        const step = p.random(6, 18);
        x = p.constrain(x + Math.cos(angle) * step, MARGIN, p.width - MARGIN);
        y = p.constrain(y + Math.sin(angle) * step, MARGIN, p.height - MARGIN);
        pts.push({ x, y });
      }
      scribbleTraces.push({
        sessionId, points: pts, isRed,
        weight: p.random(0.7, 1.3),
        life: 240, maxLife: 240,
      });
    }
  }

  function drawScribbleTraces() {
    scribbleTraces = scribbleTraces.filter((tr) => {
      tr.life--;
      if (tr.life <= 0) return false;
      const fadeIn  = p.constrain((tr.maxLife - tr.life) / 18, 0, 1);
      const fadeOut = p.constrain(tr.life / 34, 0, 1);
      const alphaBase = Math.min(fadeIn, fadeOut);
      p.push();
      p.noFill();
      for (let pass = 0; pass < 2; pass++) {
        if (tr.isRed) {
          p.stroke(pass===0?180:200, pass===0?60:80, pass===0?70:90, (pass===0?42:20)*alphaBase);
        } else {
          p.stroke(pass===0?160:120, pass===0?210:180, pass===0?220:210, (pass===0?26:12)*alphaBase);
        }
        p.strokeWeight(tr.weight + pass * 0.2);
        p.beginShape();
        for (const pt of tr.points) {
          const jx = p.random(pass===0?-0.6:-1.2, pass===0?0.6:1.2);
          const jy = p.random(pass===0?-0.6:-1.2, pass===0?0.6:1.2);
          p.curveVertex(pt.x + jx, pt.y + jy);
        }
        p.endShape();
      }
      p.pop();
      return true;
    });
  }

  function drawGlyphFrame(g, currentW, currentH, ease, alpha) {
    const currentCS = currentW;
    const pad = 6;
    const aNorm = p.constrain(alpha / 255, 0, 1);

    const isActive  = g.isActive;
    const isHolding = !g.isActive && isGlyphHolding(g);
    const isResidual = !g.isActive && !isGlyphHolding(g) && !g.fadeStartFrame;

    // Residual: no frame at all
    if (isResidual) return;

    // Holding: only faint corner ticks, no dashed border
    if (isHolding) {
      if (g.frameStyle === "none") return;
      const bLen = 8;
      p.noFill();
      p.stroke(46, 72, 80, 45 * ease * aNorm);
      p.strokeWeight(1.0);
      [[pad,pad],[currentCS-pad,pad],[pad,currentCS-pad],[currentCS-pad,currentCS-pad]].forEach(([cx,cy]) => {
        const dx = cx < currentCS/2 ? 1 : -1;
        const dy = cy < currentCS/2 ? 1 : -1;
        p.line(cx, cy, cx + dx * bLen, cy);
        p.line(cx, cy, cx, cy + dy * bLen);
      });
      return;
    }

    // Fading (fadeStartFrame set): minimal — single corner only, very faint
    if (g.fadeStartFrame && !g.dying) {
      if (g.frameStyle === "none") return;
      const bLen = 6;
      p.noFill();
      p.stroke(46, 70, 78, 28 * ease * aNorm);
      p.strokeWeight(0.8);
      const cx = pad, cy = pad;
      p.line(cx, cy, cx + bLen, cy);
      p.line(cx, cy, cx, cy + bLen);
      return;
    }

    // Active: full treatment
    if (g.frameStyle === "none") {
      // still draw active glow rect even for "none" frameStyle when active
      p.noStroke();
      p.fill(90, 138, 148, 8 * ease * aNorm);
      p.rect(-4, -4, currentCS + 8, currentCS + 8);
      return;
    }

    const bLen = 14;

    if (g.frameStyle === "full") {
      // dashed border
      p.stroke(90, 138, 148, 82 * ease * aNorm);
      p.strokeWeight(1.0);
      p.noFill();
      p.drawingContext.setLineDash([5, 5]);
      p.rect(pad, pad, currentCS - pad * 2, currentCS - pad * 2);
      p.drawingContext.setLineDash([]);
      // bright corner markers
      p.stroke(102, 152, 160, 128 * ease * aNorm);
      p.strokeWeight(1.8);
      [[pad,pad],[currentCS-pad,pad],[pad,currentCS-pad],[currentCS-pad,currentCS-pad]].forEach(([cx,cy]) => {
        const dx = cx < currentCS/2 ? 1 : -1;
        const dy = cy < currentCS/2 ? 1 : -1;
        p.line(cx, cy, cx+dx*bLen, cy);
        p.line(cx, cy, cx, cy+dy*bLen);
      });
    } else if (g.frameStyle === "corners") {
      p.stroke(180, 240, 245, 160 * ease * aNorm);
      p.strokeWeight(1.8);
      [[pad,pad],[currentCS-pad,pad],[pad,currentCS-pad],[currentCS-pad,currentCS-pad]].forEach(([cx,cy]) => {
        const dx = cx < currentCS/2 ? 1 : -1;
        const dy = cy < currentCS/2 ? 1 : -1;
        p.line(cx, cy, cx+dx*(bLen+4), cy);
        p.line(cx, cy, cx, cy+dy*(bLen+4));
      });
    } else if (g.frameStyle === "half") {
      p.stroke(90, 138, 148, 72 * ease * aNorm);
      p.strokeWeight(1.0);
      p.noFill();
      p.line(pad, pad, currentCS-pad*1.2, pad);
      p.line(pad, pad, pad, currentCS-pad*1.2);
      p.line(currentCS-pad, currentCS-pad, currentCS-pad, currentCS*0.55);
      p.line(currentCS-pad, currentCS-pad, currentCS*0.55, currentCS-pad);
    }

    // active internal crosshair + glow
    p.stroke(90, 138, 148, 20 * ease * aNorm);
    p.strokeWeight(0.4);
    if (p.random() > 0.5) p.line(currentCS/2, pad, currentCS/2, currentCS-pad);
    if (p.random() > 0.5) p.line(pad, currentCS/2, currentCS-pad, currentCS/2);
    p.noStroke();
    p.fill(90, 138, 148, 8 * ease * aNorm);
    p.rect(-4, -4, currentCS+8, currentCS+8);
  }

  function drawGlyph(g, tx, ty, cs) {
    const alpha = getAlpha(g);
    if (alpha <= 0) return;
    const currentW  = g.zoneW || cs;
    const currentH  = g.zoneH || cs;
    const ease = 1 - Math.pow(1 - g.progress, 3);

    // Determine layer for cell color choices
    const isActive  = g.isActive;
    const isHolding = !g.isActive && isGlyphHolding(g);
    // residual: not active, not holding, no fadeStartFrame
    const isResidual = !g.isActive && !isGlyphHolding(g) && !g.fadeStartFrame && !g.dying;

    p.push();
    p.translate(tx + currentW/2, ty + currentW/2);
    p.scale(0.88 + ease * 0.12);
    p.translate(-currentW/2, -currentW/2);

    drawGlyphFrame(g, currentW, currentH, ease, alpha);
    p.noStroke();

    if (!g.dying) {
      const maxToShow = Math.floor(g.rects.length * ease);
      for (let i = 0; i < maxToShow; i++) {
        const r = g.rects[i];
        if (!r) continue;
        const cellAlpha = alpha * r.alphaBias;

        if (isActive) {
          // paper-gray cells with slight alpha variation per cell
          const varAlpha = cellAlpha * p.random(0.94, 1.0);
          if (r.echo) {
            p.fill(196, 202, 204, varAlpha * 0.10);
            p.rect(r.x + p.random(-1.4, 1.4), r.y + p.random(-1.4, 1.4), r.sw, r.sh);
          }
          p.fill(196, 202, 204, varAlpha * 0.88);
          p.rect(r.x, r.y, r.sw, r.sh);
        } else if (isHolding) {
          // structurally present but clearly dimmer — cooler, no echo
          p.fill(88, 132, 140, cellAlpha * 0.72);
          p.rect(r.x, r.y, r.sw, r.sh);
        } else if (isResidual) {
          // leftover memory — very dim, no frills
          p.fill(72, 112, 120, cellAlpha * 0.45);
          p.rect(r.x, r.y, r.sw, r.sh);
        } else {
          // fading — interpolate toward residual
          p.fill(96, 140, 148, cellAlpha * 0.60);
          p.rect(r.x, r.y, r.sw, r.sh);
        }
      }
    } else {
      // dying — glitch disintegration
      const elapsed    = p.frameCount - g.deathFrame;
      const deathRatio = p.constrain(elapsed / GLITCH_DEATH_FRAMES, 0, 1);
      const eased      = Math.pow(deathRatio, 2);

      if (!g.sliceOffsets || g.sliceOffsets.length === 0) {
        p.fill(198, 203, 205, alpha * (1 - deathRatio));
        for (const r of g.rects) p.rect(r.x, r.y, r.sw, r.sh);
      } else {
        const sliceH = currentH / g.sliceOffsets.length;
        for (let s = 0; s < g.sliceOffsets.length; s++) {
          const yStart    = s * sliceH;
          const yEnd      = (s + 1) * sliceH;
          const slideOffX = g.sliceOffsets[s] * eased * 0.45;
          const slideOffY = s % 2 === 0 ? eased * 4 : eased * -4;
          p.fill(198, 203, 205, alpha * (1 - deathRatio * 0.6));
          for (const r of g.rects) {
            if (r.y >= yStart && r.y < yEnd)
              p.rect(r.x + slideOffX, r.y + slideOffY, r.sw, r.sh);
          }
        }
      }
    }

    // Debris: only on active glyphs
    if (isActive && g.debris && g.debris.length > 0) {
      for (const d of g.debris) {
        if (g.hasRedAccent && p.random() > 0.92) p.fill(142, 44, 48, alpha * d.a * 0.6);
        else p.fill(198, 203, 205, alpha * d.a * 0.7);
        p.rect(d.x, d.y, d.s, d.s);
      }
    }

    // Label: only on active glyphs
    if (isActive && !g.dying && g.frameStyle !== "none") {
      p.fill(90, 138, 148, 72 * ease);
      p.textFont("monospace");
      p.textSize(8);
      p.textAlign(p.LEFT);
      p.text(`0x${g.ch.charCodeAt(0).toString(16).toUpperCase().padStart(4,"0")}`, 8, 4);
    }

    p.pop();
  }

  function drawGlitchParticles() {
    glitchParticles = glitchParticles.filter((pt) => {
      pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.08; pt.life -= pt.decay;
      if (pt.life <= 0) return false;
      p.noStroke();
      if (pt.isRed) p.fill(145, 40, 44, pt.life * 255);
      else p.fill(90, 138, 148, pt.life * 255);
      p.rect(pt.x, pt.y, pt.size * pt.life, pt.size * pt.life);
      return true;
    });
  }

  function drawRadialGradient() {
    const ctx = p.drawingContext;
    const cx = p.width/2, cy = p.height/2;
    // wider, dimmer, desaturated center — old monitor residue not SF glow
    const r1 = Math.max(p.width, p.height) * 0.75;
    const grad1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r1);
    grad1.addColorStop(0,    "rgba(18, 26, 24, 0.60)");
    grad1.addColorStop(0.30, "rgba(12, 18, 17, 0.50)");
    grad1.addColorStop(0.65, "rgba(6, 9, 10, 0.35)");
    grad1.addColorStop(1,    "rgba(4, 5, 6, 0)");
    ctx.fillStyle = grad1;
    ctx.fillRect(0, 0, p.width, p.height);
    // corner vignette — slightly stronger to push edges dark
    [[0,0],[p.width,0],[0,p.height],[p.width,p.height]].forEach(([vx, vy]) => {
      const vr = Math.max(p.width, p.height) * 0.65;
      const vg = ctx.createRadialGradient(vx, vy, 0, vx, vy, vr);
      vg.addColorStop(0,   "rgba(0, 0, 0, 0.80)");
      vg.addColorStop(0.45,"rgba(0, 0, 0, 0.35)");
      vg.addColorStop(1,   "rgba(0, 0, 0, 0)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, p.width, p.height);
    });
  }

  p.setup = () => {
    p.createCanvas(window.innerWidth, window.innerHeight);
    updateGridConfig();
    buildZones();

    for (let i = 0; i < 20; i++) {
      backgroundNodes.push({
        x: p.random(p.width),
        y: p.random(p.height),
        speed: p.random(0.15, 0.4),
        opacity: p.random(8, 22),
        size: p.random(10, 14),
      });
    }

    cornerTexts = [
      { x: MARGIN, y: MARGIN + 16, color: [145, 40, 44], text: `VECTOR_LOCK: [37.520 / 126.921]`, blink: false },
      { x: MARGIN, y: p.height - MARGIN - 46, color: [90, 138, 148, 120], text: `ENCRYPTION_KEY:`, blink: false },
      { x: MARGIN, y: p.height - MARGIN - 30, color: [90, 138, 148, 90], text: `**********`, blink: false },
      { x: MARGIN, y: p.height / 2, color: [90, 138, 148, 90], text: `FORCE_QUIT... [Y/N]`, blink: true },
    ];

    for (let i = 0; i < 6; i++) {
      scrollingLog.push(p.random(ERROR_POOL));
    }

    p.noLoop();
  };

  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    updateGridConfig();
    p.loop();
  };

  function updateGridConfig() {
    const availW = p.width - MARGIN * 2;
    const availH = p.height - MARGIN * 2;
    COLS = p.constrain(Math.floor(availW / CELL_MIN_SIZE), 4, GRID_MAX_COLS);
    ROWS = p.constrain(Math.floor(availH / CELL_MIN_SIZE), 3, GRID_MAX_ROWS);
    CAPACITY = COLS * ROWS;
    slots = Array(CAPACITY).fill(null);
    queue = [];
    pulses = [];
    sessionLayouts = [];
    scribbleTraces = [];
    ghostGlyphs = [];
    buildZones();
  }

  function buildZones() {
    zones = [];
    const taken = new Set();

    function canPlace(sc, sr, n) {
      if (sc + n > COLS || sr + n > ROWS) return false;
      for (let dr = 0; dr < n; dr++)
        for (let dc = 0; dc < n; dc++)
          if (taken.has((sr + dr) * COLS + (sc + dc))) return false;
      return true;
    }

    function placeZone(sc, sr, n) {
      const zSlots = [];
      for (let dr = 0; dr < n; dr++)
        for (let dc = 0; dc < n; dc++) {
          const idx = (sr + dr) * COLS + (sc + dc);
          taken.add(idx);
          zSlots.push(idx);
        }
      const size = n >= 3 ? 'L' : n === 2 ? 'M' : 'S';
      const offRange = size === 'L' ? 0.002 : size === 'M' ? 0.003 : 0.004;
      const z = {
        col: sc, row: sr, zw: n, zh: n, slots: zSlots,
        active: false, opacity: 0, targetOpacity: 0,
        offX: p.random(-offRange, offRange),
        offY: p.random(-offRange, offRange),
        size,
      };
      zones.push(z);
      return z;
    }

    function placeInCellRegion(c0, c1, r0, r1, n) {
      const cands = [];
      for (let r = r0; r <= r1 - n; r++)
        for (let c = c0; c <= c1 - n; c++)
          cands.push([c, r]);
      for (const [c, r] of p.shuffle(cands))
        if (canPlace(c, r, n)) return placeZone(c, r, n);
      return null;
    }

    function placeNear(anchor, n, max, radiusCells) {
      const cands = [];
      for (let dr = -radiusCells; dr <= anchor.zh + radiusCells - 1; dr++)
        for (let dc = -radiusCells; dc <= anchor.zw + radiusCells - 1; dc++) {
          const c = anchor.col + dc, r = anchor.row + dr;
          if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
          cands.push([c, r, Math.abs(dc) + Math.abs(dr)]);
        }
      cands.sort((a, b) => a[2] - b[2]);
      let placed = 0;
      for (const [c, r] of cands) {
        if (placed >= max) break;
        if (!taken.has(r * COLS + c) && canPlace(c, r, n)) {
          placeZone(c, r, n);
          placed++;
        }
      }
    }

    const hMid = Math.floor(COLS / 2);
    const vMid = Math.floor(ROWS / 2);
    const quad = {
      TL: [0,    hMid, 0,    vMid],
      TR: [hMid, COLS, 0,    vMid],
      BL: [0,    hMid, vMid, ROWS],
      BR: [hMid, COLS, vMid, ROWS],
    };

    const diagPair = p.random() > 0.5 ? ['TL', 'BR'] : ['TR', 'BL'];
    const anchorA = placeInCellRegion(...quad[diagPair[0]], 3);
    const anchorB = placeInCellRegion(...quad[diagPair[1]], 3);
    const anchors = [anchorA, anchorB].filter(Boolean);

    const otherQuads = ['TL','TR','BL','BR'].filter(k => !diagPair.includes(k));
    for (const key of otherQuads) placeInCellRegion(...quad[key], 2);
    for (const a of anchors) placeNear(a, 2, 2, 3);
    for (const a of anchors) placeNear(a, 1, 5, 4);

    let micro = 0;
    for (const idx of p.shuffle([...Array(CAPACITY).keys()])) {
      if (micro >= 20) break;
      const c = idx % COLS, r = Math.floor(idx / COLS);
      if (!taken.has(idx)) { placeZone(c, r, 1); micro++; }
    }

    activateZones();
  }

  function activateZones() {
    zones.forEach(z => {
      z.active = true;
      z.opacity = 1.0;
      z.targetOpacity = 1.0;
    });
  }

  function updateZoneOpacities() {
    zones.forEach(z => {
      z.opacity += (z.targetOpacity - z.opacity) * 0.02;
    });
  }

  function morphZones() {
    const hasLiveGlyph = (z) => z.slots.some(idx => slots[idx] && !slots[idx].hidden);
    const activeZones   = zones.filter(z => z.active && !hasLiveGlyph(z));
    const inactiveZones = zones.filter(z => !z.active);
    if (inactiveZones.length === 0 || activeZones.length === 0) return;
    const swapCount = Math.max(1, Math.floor(activeZones.length * 0.18));
    const toDeactivate = p.shuffle(activeZones).slice(0, swapCount);
    const toActivate   = p.shuffle(inactiveZones).slice(0, swapCount);
    toDeactivate.forEach(z => { z.active = false; z.targetOpacity = 0; });
    toActivate.forEach(z => { z.active = true; z.targetOpacity = 1.0; z.opacity = 1.0; });
    zoneVersion++;
  }

  function zoneOfSlot(idx) {
    return zones.find(z => z.slots.includes(idx)) || null;
  }

  p.draw = () => {
    if (p.frameCount - lastMorphFrame >= ZONE_MORPH_FRAMES) {
      morphZones();
      lastMorphFrame = p.frameCount;
    }
    updateZoneOpacities();

    p.background(...BG);
    drawRadialGradient();

    const cs = cellSize();
    const { x: gx0, y: gy0 } = gridOrigin();

    p.fill(72, 108, 116, 6);
    p.textSize(9);
    p.textFont("monospace");
    p.textAlign(p.LEFT);
    backgroundNodes.forEach((n, i) => {
      p.text(activeHash.substring(i % activeHash.length, (i % activeHash.length) + 10), n.x, n.y);
      n.y -= n.speed;
      if (n.y < 0) n.y = p.height;
    });

    drawScribbleTraces();

    // ── Blueprint coordinate field ─────────────────────
    p.push();

    // Tertiary: full-span architectural guide lines at screen level (not grid-bound)
    // 2 vertical + 2 horizontal near golden-ratio positions, extremely faint
    p.stroke(46, 72, 80, 4);
    p.strokeWeight(0.5);
    const gvx1 = p.width * 0.382, gvx2 = p.width * 0.618;
    const gvy1 = p.height * 0.382, gvy2 = p.height * 0.618;
    p.line(gvx1, 0, gvx1, p.height);
    p.line(gvx2, 0, gvx2, p.height);
    p.line(0, gvy1, p.width, gvy1);
    p.line(0, gvy2, p.width, gvy2);

    // Secondary: larger-scale cell guide lines every 4 cells, very faint
    p.stroke(46, 72, 80, 4);
    p.strokeWeight(0.5);
    for (let i = 0; i <= COLS; i++) {
      if (i % 4 === 0) p.line(gx0 + i * cs, gy0, gx0 + i * cs, gy0 + ROWS * cs);
    }
    for (let j = 0; j <= ROWS; j++) {
      if (j % 4 === 0) p.line(gx0, gy0 + j * cs, gx0 + COLS * cs, gy0 + j * cs);
    }

    // Primary: intersection tick marks — major nodes slightly larger
    p.strokeWeight(0.7);
    for (let i = 0; i <= COLS; i++) {
      for (let j = 0; j <= ROWS; j++) {
        const px = gx0 + i * cs, py = gy0 + j * cs;
        const isMajor = (i % 4 === 0 && j % 4 === 0);
        const tickLen = isMajor ? 4 : 2;
        const tickAlpha = isMajor ? 16 : 10;
        p.stroke(80, 118, 128, tickAlpha);
        p.line(px - tickLen, py, px + tickLen, py);
        p.line(px, py - tickLen, px, py + tickLen);
      }
    }

    // Outer boundary — single very faint long-dash line
    p.noFill();
    p.stroke(46, 72, 80, 14);
    p.strokeWeight(0.6);
    p.drawingContext.setLineDash([2, 10]);
    p.rect(gx0, gy0, COLS * cs, ROWS * cs);
    p.drawingContext.setLineDash([]);

    p.pop();

    drawZonesBg(cs, gx0, gy0);
    drawGhostGlyphs();
    drawConnections(cs, gx0, gy0);

    for (let i = CAPACITY - 1; i >= 0; i--) {
      const g = slots[i];
      if (!g || g.hidden || g.dying) continue;
      const gz = zoneOfSlot(i);
      if (!gz || !gz.active) {
        if (g.isActive) g.isActive = false;
        if (!g.fadeStartFrame) g.fadeStartFrame = p.frameCount;
      }
    }

    let isAnimating = slots.some(s => s && !s.hidden && (!s.done || s.dying || s.fadeStartFrame));
    isAnimating = isAnimating || orphanGlyphs.length > 0 || ghostGlyphs.length > 0;

    for (let i = 0; i < CAPACITY; i++) {
      const g = slots[i];
      if (!g || g.hidden) continue;

      const gc    = g.zone ? g.zone.col : (i % COLS);
      const gr    = g.zone ? g.zone.row : Math.floor(i / COLS);
      const gOffX = g.zone ? (g.zone.offX || 0) * p.width  : 0;
      const gOffY = g.zone ? (g.zone.offY || 0) * p.height : 0;
      const tx = gx0 + gc * cs + gOffX;
      const ty = gy0 + gr * cs + gOffY;

      if (g.dying) {
        const elapsed = p.frameCount - g.deathFrame;
        if (elapsed >= GLITCH_DEATH_FRAMES) {
          spawnGhostFromGlyph(g, tx, ty);
          const qi = queue.indexOf(g);
          if (qi !== -1) queue.splice(qi, 1);
          if (g.zone) freeZone(g.zone); else freeSlot(i, g);
          continue;
        }
        isAnimating = true;
      }

      if (!g.done) {
        g.progress += 1 / BUILD_FRAMES;
        if (g.progress >= 1) { g.progress = 1; g.done = true; }
        isAnimating = true;
      }

      if (g.fadeStartFrame && !g.dying) {
        const fadeElapsed = p.frameCount - g.fadeStartFrame;
        if (fadeElapsed < FADE_OUT_FRAMES) {
          isAnimating = true;
        } else {
          spawnGhostFromGlyph(g, tx, ty);
          const isLarge = getGlyphSize(g) === 'L';
          if (!isLarge && p.random() < 0.25) {
            g.dying = true;
            g.deathFrame = p.frameCount;
            if (!g.sliceOffsets) {
              g.sliceOffsets = [];
              for (let _k = 0; _k < 6; _k++) g.sliceOffsets.push(p.random(-15, 15));
            }
            isAnimating = true;
          } else {
            const qi = queue.indexOf(g);
            if (qi !== -1) queue.splice(qi, 1);
            if (g.zone) { freeZone(g.zone); g.zone = null; }
            else freeSlot(i, g);
            continue;
          }
        }
      }

      // holding glyph도 isAnimating에 포함
      if (isGlyphHolding(g)) isAnimating = true;

      drawGlyph(g, tx, ty, cs);
    }

    orphanGlyphs = orphanGlyphs.filter(g => {
      const elapsed = p.frameCount - g.deathFrame;
      if (elapsed >= GLITCH_DEATH_FRAMES) return false;
      drawGlyph(g, g._tx, g._ty, g._cs);
      isAnimating = true;
      return true;
    });

    drawGlitchParticles();
    drawZonesBorder(cs, gx0, gy0);

    if (glitchParticles.length > 0) isAnimating = true;
    if (pulses.length > 0)          isAnimating = true;
    if (scribbleTraces.length > 0)  isAnimating = true;

    if (sessionCounter > 0 && p.frameCount - lastPulseSpawnFrame >= PULSE_SPAWN_INTERVAL) {
      spawnPulsesForSession(sessionCounter - 1, cs, gx0, gy0);
      lastPulseSpawnFrame = p.frameCount;
    }

    evictIfOverfilled();
    if (slots.some(s => s && s.dying)) isAnimating = true;

    drawGrain();
    drawOverlayTexts();

    if (overlayLogs.length > 0 || activeStamps.length > 0) isAnimating = true;
    if (!isAnimating) p.noLoop();
  };

  channel.onmessage = async (ev) => {
    if (ev.data?.type === "entry") {
      const text = ev.data.text || "";
      activeHash = await computeHash(text);
      const currentSession = sessionCounter++;
      const layout = getSessionLayout(currentSession);

      lastEntryFrame = p.frameCount;

      // ── E. size별 이전 active glyph 처리 (holdUntilSession 기반) ──
      const prevBySize = { L: [], M: [], S: [] };
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s && !s.hidden && s.isActive) {
          const sz = getGlyphSize(s);
          prevBySize[sz].push(s);
        }
      }

      // S: 75~80% fadeStart, 나머지 residual
      const sShuffled = p.shuffle([...prevBySize.S]);
      const sFadeCount = Math.ceil(sShuffled.length * p.random(0.75, 0.80));
      sShuffled.forEach((g, i) => {
        g.isActive = false;
        g.holdUntilSession = undefined;
        if (i < sFadeCount) g.fadeStartFrame = p.frameCount;
        // 나머지: residual (alpha 44)
      });

      // M: 20~25% holdUntilSession+1, 25~30% fadeStart, 나머지 residual
      const mShuffled = p.shuffle([...prevBySize.M]);
      const mHoldRatio = p.random(0.20, 0.25);
      const mFadeRatio = p.random(0.25, 0.30);
      const mHoldCount = Math.ceil(mShuffled.length * mHoldRatio);
      const mFadeCount = Math.ceil(mShuffled.length * mFadeRatio);
      mShuffled.forEach((g, i) => {
        g.isActive = false;
        if (i < mHoldCount) {
          g.holdUntilSession = currentSession + 1;
        } else if (i < mHoldCount + mFadeCount) {
          g.holdUntilSession = undefined;
          g.fadeStartFrame = p.frameCount;
        } else {
          g.holdUntilSession = undefined;
          // residual
        }
      });

      // L: 90~95% holdUntilSession+2, 최대 0~5%만 fadeStart (canRemoveGlyph 통과 시)
      // 나머지는 residual 금지 → hold
      const lShuffled = p.shuffle([...prevBySize.L]);
      const lFadeMax = Math.ceil(lShuffled.length * p.random(0.00, 0.05));
      let lFaded = 0;
      lShuffled.forEach((g) => {
        g.isActive = false;
        if (lFaded < lFadeMax && canRemoveGlyph(g)) {
          g.holdUntilSession = undefined;
          g.fadeStartFrame = p.frameCount;
          lFaded++;
        } else {
          // anchor holding: holdUntilSession = currentSession + 2
          g.holdUntilSession = currentSession + 2;
        }
      });

      cornerTexts[0].text = `VECTOR_LOCK: [${(Math.random() * 90 - 45).toFixed(3)} / ${(Math.random() * 360 - 180).toFixed(3)}]`;

      const stampChance = Math.random();
      if (stampChance > 0.6)      spawnStamp("REC ● S3CR3T", "topCenter");
      else if (stampChance > 0.3) spawnStamp("SIGNAL_TRACE: ACTIVE", "midRight");
      if (sessionCounter > 5 && Math.random() > 0.5) spawnStamp("DELETION_PENDING", "midLeft");

      lastPulseSpawnFrame = p.frameCount - PULSE_SPAWN_INTERVAL;

      const chars = text.toUpperCase().replace(/\s/g, "").split("").slice(0, 20);
      const cs = cellSize();
      const { x: gx0, y: gy0 } = gridOrigin();

      // ── F. 선제 eviction: holdUntilSession 제외, S→M→L, 최대 1개 ──
      const getEmptyZones = () => zones.filter(z =>
        z.active && z.slots.every(idx => slots[idx] === null)
      );
      let emptyZones = getEmptyZones();
      if (emptyZones.length < chars.length) {
        const candidates = getEvictionCandidates();
        let evicted = 0;
        for (const g of candidates) {
          if (evicted >= 1) break;
          g.holdUntilSession = undefined;
          g.dying = true;
          g.deathFrame = p.frameCount;
          if (!g.sliceOffsets) {
            g.sliceOffsets = [];
            for (let _k = 0; _k < 6; _k++) g.sliceOffsets.push(p.random(-15, 15));
          }
          evicted++;
        }
        emptyZones = getEmptyZones();
      }

      const actualChars = chars.slice(0, emptyZones.length);
      const placedGlyphIndices = [];

      for (const ch of actualChars) {
        const zone = chooseZoneForSession(layout);
        if (!zone) break;

        const idx   = zone.slots[0];
        const zoneW = zone.zw * cs;
        const zoneH = zone.zh * cs;
        const rects = generateRects(ch, zoneW, zoneH);

        const debris = [];
        const debrisCount = Math.floor(p.random(2, 7));
        for (let k = 0; k < debrisCount; k++) {
          debris.push({
            x: p.random(4, 44), y: p.random(4, 44),
            s: p.random(1.8, 4.5), a: p.random(0.12, 0.32),
          });
        }

        // 4. glyph 생성 object: isHolding 제거, holdUntilSession 사용
        const glyph = {
          ch,
          isBig: false,
          size: zone.size,
          bornSession: currentSession,
          zoneW, zoneH, zone,
          rects, debris,
          progress: 0, done: false,
          isActive: true,
          holdUntilSession: undefined,  // 신규 glyph는 holding 없음
          fadeStartFrame: null,
          sessionId: currentSession,
          frameStyle: p.random(["full", "corners", "half", "none"]),
          hasRedAccent: p.random() > 0.72,
        };

        occupyZone(zone, glyph);
        placedGlyphIndices.push(idx);
        queue.push(glyph);
      }

      const selectedForTrace = placedGlyphIndices.filter(() => p.random() > 0.68);
      spawnScribbleTracesForSession(currentSession, selectedForTrace, cs, gx0, gy0);

      p.loop();
    }
  };
});
