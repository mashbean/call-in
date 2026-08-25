export let difficultyLabels = ["太簡單", "容易", "剛剛好", "有點難", "跟丟了"];

export function setDifficultyLabels(labels) {
  if (Array.isArray(labels) && labels.length === 5) difficultyLabels = [...labels];
}

export function renderDifficultyChart(root, difficulty = {}) {
  if (!root) return;
  const counts = Array.isArray(difficulty.counts) ? difficulty.counts.slice(0, 5) : [];
  while (counts.length < 5) counts.push(0);
  const total = Number(difficulty.total) || 0;
  const average = Number(difficulty.average);
  const baseline = 172;
  const chartTop = 24;
  const left = 30;
  const right = 570;
  const bandwidth = 0.48;
  const samples = Array.from({ length: 81 }, (_, index) => {
    const score = 1 + (index / 80) * 4;
    const density = total
      ? counts.reduce(
          (sum, count, countIndex) =>
            sum + count * Math.exp(-0.5 * ((score - (countIndex + 1)) / bandwidth) ** 2),
          0,
        )
      : 0;
    return { score, density };
  });
  const maxDensity = Math.max(1, ...samples.map((sample) => sample.density));
  const points = samples.map((sample) => ({
    x: left + ((sample.score - 1) / 4) * (right - left),
    y: baseline - (sample.density / maxDensity) * (baseline - chartTop),
  }));
  const line = points
    .map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  root.querySelector("[data-difficulty-line]")?.setAttribute("d", line);
  root
    .querySelector("[data-difficulty-area]")
    ?.setAttribute("d", `M ${left} ${baseline} ${line.slice(1)} L ${right} ${baseline} Z`);
  const pointsRoot = root.querySelector("[data-difficulty-points]");
  if (pointsRoot) {
    if (total && Number.isFinite(average)) {
      const meanX = left + ((average - 1) / 4) * (right - left);
      const nearest = points.reduce((best, point) =>
        Math.abs(point.x - meanX) < Math.abs(best.x - meanX) ? point : best,
      );
      pointsRoot.innerHTML = `<line class="difficulty-mean-line" x1="${meanX}" y1="${Math.max(chartTop, nearest.y)}" x2="${meanX}" y2="${baseline}"></line><circle class="difficulty-mean-dot" cx="${meanX}" cy="${nearest.y}" r="6"></circle>`;
    } else {
      pointsRoot.innerHTML = "";
    }
  }
  const countsRoot = root.querySelector("[data-difficulty-counts]");
  if (countsRoot) {
    countsRoot.innerHTML = difficultyLabels
      .map((label, index) => `<span><b>${counts[index]}</b><small>${label}</small></span>`)
      .join("");
  }
  const totalRoot = root.querySelector("[data-difficulty-total]");
  if (totalRoot) {
    totalRoot.textContent = total
      ? `${total} 筆回報 · 平均 ${Number.isFinite(average) ? average.toFixed(1) : "-"}`
      : "等待第一筆回報";
  }
}
