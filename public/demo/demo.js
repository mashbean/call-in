const difficultyLabel = document.querySelector("[data-difficulty-label]");

document.querySelectorAll("[data-difficulty]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-difficulty]").forEach((option) => option.classList.remove("active"));
    button.classList.add("active");
    difficultyLabel.textContent = button.dataset.difficulty;
  });
});

document.querySelectorAll("[data-reaction]").forEach((button) => {
  button.addEventListener("click", () => {
    const count = button.querySelector("b");
    count.textContent = String(Number(count.textContent) + 1);
    button.classList.remove("popped");
    requestAnimationFrame(() => button.classList.add("popped"));
  });
});

document.querySelector("[data-demo-question-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = event.currentTarget.querySelector("input");
  const value = input.value.trim();
  if (!value) return;
  document.querySelector("[data-demo-question]").textContent = value;
  input.value = "";
});

document.querySelector("[data-fullscreen]")?.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
});
