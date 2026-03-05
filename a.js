import { generatePatternCells } from "./common.js";

const channel = new BroadcastChannel("dual-screen-patterns");

new p5((p) => {
  let inputEl;
  let letterPatterns = {};
  let currentHash = "";

  let letterGroups = [];
  let bgParticles = [];
  let exitingParticles = [];

  let lastSentAt = 0;
  const SEND_COOLDOWN_MS = 500;

  const cell = 20;
  const letterWidth = 7 * cell + 15;
  const lineHeight = 7 * cell + 30;
  const BG = [11, 11, 13];

  // ── 레이아웃 설정 ────────────────────────────
  const ZONE_MARGIN_X = 80;
  const ZONE_TOP = 160;        
  const ZONE_BOTTOM_MARGIN = 60;

  // 화면 크기에 따라 가변적인 영역 계산
  function getZone() {
    return {
      x: ZONE_MARGIN_X,
      y: ZONE_TOP,
      w: p.width - ZONE_MARGIN_X * 2,
      h: p.height - ZONE_TOP - ZONE_BOTTOM_MARGIN,
    };
  }

  function getMaxChars() {
    const zone = getZone();
    const charsPerLine = Math.max(1, Math.floor(zone.w / letterWidth));
    const maxLines = Math.max(1, Math.floor(zone.h / lineHeight));
    return charsPerLine * maxLines;
  }

  // ── 클래스 정의 (기존과 동일) ──────────────────────────
  class HashParticle {
    constructor(char, tx, ty) {
      this.char = char;
      this.x = tx + p.random(-200, 200);
      this.y = ty + p.random(-200, 200);
      this.tx = tx;
      this.ty = ty;
      this.arrived = false;
      this.speed = p.random(0.08, 0.14);
      this.opacity = p.random(80, 160);
    }
    setTarget(tx, ty) {
      this.tx = tx;
      this.ty = ty;
      this.arrived = false;
    }
    update() {
      if (this.arrived) return;
      this.x = p.lerp(this.x, this.tx, this.speed);
      this.y = p.lerp(this.y, this.ty, this.speed);
      if (p.dist(this.x, this.y, this.tx, this.ty) < 1) {
        this.x = this.tx;
        this.y = this.ty;
        this.arrived = true;
      }
    }
    draw() {
      if (this.arrived) {
        p.drawingContext.shadowBlur = 6;
        p.drawingContext.shadowColor = 'rgba(0,210,230,0.5)';
        p.fill(255);
        p.noStroke();
        p.rect(this.tx, this.ty, cell - 2, cell - 2);
        p.drawingContext.shadowBlur = 0;
      } else {
        const d = p.dist(this.x, this.y, this.tx, this.ty);
        const alpha = p.map(d, 0, 200, 220, this.opacity, true);
        p.fill(0, 210, 230, alpha);
        p.noStroke();
        p.textFont('monospace');
        p.textSize(13);
        p.textAlign(p.CENTER, p.CENTER);
        p.text(this.char, this.x, this.y);
      }
    }
  }

  class ExitParticle {
    constructor(char, x, y) {
      this.char = char; this.x = x; this.y = y;
      const angle = p.random(p.TWO_PI);
      const spd = p.random(3, 12);
      this.vx = p.cos(angle) * spd;
      this.vy = p.sin(angle) * spd;
      this.alpha = 200;
    }
    update() {
      this.x += this.vx; this.y += this.vy;
      this.vx *= 1.04; this.vy *= 1.04;
      this.alpha -= 14;
    }
    draw() {
      p.fill(0, 210, 230, this.alpha);
      p.noStroke();
      p.textFont('monospace');
      p.textSize(13);
      p.textAlign(p.CENTER, p.CENTER);
      p.text(this.char, this.x, this.y);
    }
    isDead() { return this.alpha <= 0; }
  }

  class BgParticle {
    constructor() { this.reset(true); }
    reset(init = false) {
      this.x = p.random(p.width);
      this.y = init ? p.random(p.height) : p.height + 10;
      this.char = p.random(['0','1','a','b','c','d','e','f','#','$','%','&']);
      this.alpha = p.random(12, 35);
      this.size = p.random(9, 13);
      this.vy = p.random(-0.3, -0.7);
      this.vx = p.random(-0.15, 0.15);
    }
    update() {
      this.x += this.vx; this.y += this.vy;
      if (this.y < -20 || this.x < 0 || this.x > p.width) this.reset();
    }
    draw() {
      p.fill(0, 210, 230, this.alpha);
      p.noStroke();
      p.textFont('monospace');
      p.textSize(this.size);
      p.textAlign(p.CENTER, p.CENTER);
      p.text(this.char, this.x, this.y);
    }
  }

  // ── 로직 ──────────────────────────────────────────────────
  async function updateHash(text) {
    if (!text) { currentHash = ""; return; }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    currentHash = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 64);
  }

  function computeLetterLayouts(text) {
    const zone = getZone();
    const lines = splitTextIntoLines(text);
    const totalH = lines.length * lineHeight;
    // 존 내부 세로 중앙 정렬
    const startY = zone.y + (zone.h - totalH) / 2;
    const layouts = [];

    lines.forEach((line, li) => {
      // 각 줄마다 가로 중앙 정렬
      let x = p.width / 2 - (line.length * letterWidth) / 2;
      const y = startY + li * lineHeight;
      for (let ch of line) {
        layouts.push({ ch, x, y });
        x += letterWidth;
      }
    });
    return layouts;
  }

  function updateLetterGroups(newText) {
    const layouts = computeLetterLayouts(newText);

    // 1. 남는 글자 제거 (애니메이션과 함께)
    while (letterGroups.length > layouts.length) {
      const removed = letterGroups.pop();
      removed.particles.forEach(hp => {
        exitingParticles.push(new ExitParticle(hp.char, hp.x, hp.y));
      });
    }

    // 2. 기존 글자 위치 업데이트 (창 크기 대응)
    for (let i = 0; i < letterGroups.length; i++) {
      const { ch, x, y } = layouts[i];
      const group = letterGroups[i];
      if (!letterPatterns[ch]) letterPatterns[ch] = generatePatternCells(ch, p);
      const cells = letterPatterns[ch];
      
      group.ch = ch;
      group.particles.forEach((hp, j) => {
        const c = cells[j % cells.length];
        hp.char = hashCharAt(i * cells.length + j);
        hp.setTarget(x + c.j * cell, y + c.i * cell);
      });
    }

    // 3. 새 글자 추가
    for (let i = letterGroups.length; i < layouts.length; i++) {
      const { ch, x, y } = layouts[i];
      if (!letterPatterns[ch]) letterPatterns[ch] = generatePatternCells(ch, p);
      const cells = letterPatterns[ch];
      const particles = cells.map((c, j) =>
        new HashParticle(hashCharAt(i * cells.length + j), x + c.j * cell, y + c.i * cell)
      );
      letterGroups.push({ ch, particles });
    }
  }

  function hashCharAt(index) {
    if (!currentHash) return '0';
    return currentHash[index % currentHash.length];
  }

  function splitTextIntoLines(txt) {
    const zone = getZone();
    const maxLineChars = Math.max(1, Math.floor(zone.w / letterWidth));
    const lines = [];
    let cur = "";
    for (let c of txt) {
      if (cur.length >= maxLineChars) {
        lines.push(cur);
        cur = c;
      } else {
        cur += c;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function safeSend(text) {
    const now = Date.now();
    const norm = text.trim();
    if (!norm || now - lastSentAt < SEND_COOLDOWN_MS) return;
    lastSentAt = now;
    const id = now.toString(36) + "-" + Math.random().toString(36).slice(2);
    channel.postMessage({ type: "entry", id, text: norm });

    letterGroups.forEach(group => {
      group.particles.forEach(hp => {
        exitingParticles.push(new ExitParticle(hp.char, hp.x, hp.y));
      });
    });
    letterGroups = [];
    p.loop();
  }

  // ── 이벤트 ────────────────────────────────────────────────
  p.setup = () => {
    p.createCanvas(window.innerWidth, window.innerHeight);
    inputEl = document.getElementById("textInput");

    for (let i = 0; i < 50; i++) bgParticles.push(new BgParticle());

    inputEl.addEventListener("input", async (e) => {
      let raw = e.target.value.toUpperCase();
      const maxChars = getMaxChars();
      if (raw.length > maxChars) {
        raw = raw.substring(0, maxChars);
        inputEl.value = raw;
      }
      await updateHash(raw);
      updateLetterGroups(raw);
      p.loop();
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.repeat) {
        safeSend(inputEl.value);
        inputEl.value = "";
        currentHash = "";
        letterGroups = [];
        p.loop();
      }
    });

    p.noLoop();
  };

  // ★ 중요: 창 크기가 바뀔 때 호출되는 p5.js 내장 함수
  p.windowResized = () => {
    p.resizeCanvas(window.innerWidth, window.innerHeight);
    
    // 현재 입력된 텍스트가 있다면 바뀐 화면 크기에 맞춰 레이아웃 재계산
    const currentText = inputEl.value.toUpperCase();
    const maxChars = getMaxChars();
    
    // 만약 화면이 너무 작아져서 글자가 넘치면 잘라냄
    let finalText = currentText;
    if (currentText.length > maxChars) {
      finalText = currentText.substring(0, maxChars);
      inputEl.value = finalText;
      updateHash(finalText);
    }
    
    updateLetterGroups(finalText);
    p.loop(); // 애니메이션 트리거
  };

  p.draw = () => {
    p.background(...BG, 210);

    // 배경 가이드라인
    p.stroke(22, 22, 32);
    p.strokeWeight(1);
    for (let i = 0; i < p.width; i += cell * 2) p.line(i, 0, i, p.height);

    bgParticles.forEach(bp => { bp.update(); bp.draw(); });

    let anyMoving = false;
    letterGroups.forEach(group => {
      group.particles.forEach(hp => {
        hp.update();
        hp.draw();
        if (!hp.arrived) anyMoving = true;
      });
    });

    exitingParticles = exitingParticles.filter(ep => !ep.isDead());
    exitingParticles.forEach(ep => { ep.update(); ep.draw(); });

    if (anyMoving || exitingParticles.length > 0) {
      p.loop();
    } else {
      p.noLoop();
    }
  };
});