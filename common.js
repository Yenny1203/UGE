// common.js
// 7x7 패턴 좌표 생성: [{i,j}, ...]
export function generatePatternCells(letter, p) {
  const seed = letter.charCodeAt(0);
  p.randomSeed(seed);

  // ── 시드로 이 글자의 "패턴 성격" 결정 ──────────────────
  const patternType = seed % 5;       // 0~4: 십자/대각/링/덴스센터/분산
  const useMirrorH  = seed % 3 !== 0; // 좌우 대칭 여부
  const useMirrorV  = seed % 7 < 3;   // 상하 대칭 여부
  const density     = 0.38 + (seed % 11) * 0.03; // 전체 밀도 0.38~0.68

  const CENTER = 3;
  const grid = Array.from({ length: 7 }, () => new Array(7).fill(false));

  // ── 기본 확률 맵 계산 ────────────────────────────────────
  function baseProbability(i, j) {
    const di = Math.abs(i - CENTER);
    const dj = Math.abs(j - CENTER);
    const manhattan = di + dj;
    const chebyshev = Math.max(di, dj);

    switch (patternType) {
      case 0: // 십자형 — 수평/수직 축이 강함
        return manhattan === 0 ? 0.97
          : di === 0 ? p.lerp(0.82, 0.35, dj / 3)
          : dj === 0 ? p.lerp(0.82, 0.35, di / 3)
          : p.lerp(0.55, 0.12, manhattan / 6);

      case 1: // 대각선형 — 45도 축이 강함
        return (di === dj) ? p.lerp(0.92, 0.45, di / 3)
          : p.lerp(0.50, 0.10, manhattan / 6);

      case 2: // 링형 — 가운데 비고 테두리 강함
        return chebyshev === 0 ? 0.25
          : chebyshev === 1 ? 0.30
          : chebyshev === 2 ? 0.88
          : chebyshev === 3 ? 0.65
          : 0.20;

      case 3: // 덴스센터 — 중앙이 꽉 찬 점
        return p.lerp(0.96, 0.08, manhattan / 6);

      case 4: // 분산형 — 체스판 + 노이즈
      default:
        return ((i + j) % 2 === 0)
          ? p.lerp(0.75, 0.30, manhattan / 6)
          : p.lerp(0.20, 0.05, manhattan / 6);
    }
  }

  // ── 1패스: 확률 기반 채우기 ──────────────────────────────
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const prob = baseProbability(i, j) * density * 1.6;
      if (p.random() < prob) grid[i][j] = true;
    }
  }

  // ── 대칭 적용 ────────────────────────────────────────────
  if (useMirrorH) {
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < CENTER; j++) {
        // 좌측 기준으로 우측을 미러 (OR — 어느 쪽이든 켜져 있으면 켬)
        const mirror = grid[i][j] || grid[i][6 - j];
        grid[i][j]     = mirror;
        grid[i][6 - j] = mirror;
      }
    }
  }
  if (useMirrorV) {
    for (let i = 0; i < CENTER; i++) {
      for (let j = 0; j < 7; j++) {
        const mirror = grid[i][j] || grid[6 - i][j];
        grid[i][j]     = mirror;
        grid[6 - i][j] = mirror;
      }
    }
  }

  // ── 2패스: 밀도 보정 (너무 비거나 가득 차면 조정) ────────
  let onCount = grid.flat().filter(Boolean).length;

  // 최소 10개 보장
  if (onCount < 10) {
    const candidates = [];
    for (let i = 0; i < 7; i++)
      for (let j = 0; j < 7; j++)
        if (!grid[i][j]) candidates.push([i, j]);
    p.shuffle(candidates, true);
    for (let k = 0; k < Math.min(10 - onCount, candidates.length); k++) {
      const [i, j] = candidates[k];
      grid[i][j] = true;
    }
  }

  // 최대 30개 제한 (너무 빽빽하면 글자 구분 안 됨)
  if (onCount > 30) {
    const ons = [];
    for (let i = 0; i < 7; i++)
      for (let j = 0; j < 7; j++)
        if (grid[i][j]) ons.push([i, j]);
    // 외곽(manhattan 거리 큰 것)부터 끔
    ons.sort((a, b) => {
      const da = Math.abs(a[0]-CENTER) + Math.abs(a[1]-CENTER);
      const db = Math.abs(b[0]-CENTER) + Math.abs(b[1]-CENTER);
      return db - da;
    });
    for (let k = 0; k < onCount - 30; k++) {
      grid[ons[k][0]][ons[k][1]] = false;
    }
  }

  // ── 셀 수집 → 셔플 ───────────────────────────────────────
  const cells = [];
  for (let i = 0; i < 7; i++)
    for (let j = 0; j < 7; j++)
      if (grid[i][j]) cells.push({ i, j });

  return p.shuffle(cells, true);
}
