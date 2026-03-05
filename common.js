// common.js
// 7x7 패턴 좌표 생성: [{i,j}, ...]
export function generatePatternCells(letter, p) {
    let cells = [];
    let seed = letter.charCodeAt(0);
    p.randomSeed(seed);
  
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 7; j++) {
        let isVowel = "AEIOU".includes(letter);
        let shouldDraw = false;
  
        if (isVowel) {
          if (p.random() > 0.65 && (i + j) % 2 === 0) shouldDraw = true;
        } else {
          if ((i + j + seed) % 3 === 0 || p.random() > 0.8) shouldDraw = true;
        }
  
        let center = 3;
        let dist = Math.abs(i - center) + Math.abs(j - center);
        if (dist < 2 && p.random() > 0.5) shouldDraw = true;
  
        if (shouldDraw) cells.push({ i, j });
      }
    }
  
    // 등장 순서 랜덤(하지만 시드로 고정)
    return p.shuffle(cells, true);
  }
  