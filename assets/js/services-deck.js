// Services page Command Deck navigation (externalized for strict zero-unsafe-inline CSP)
(function () {
  const toggle = document.getElementById('nav-toggle');
  const menu = document.getElementById('nav-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const isOpen = menu.classList.toggle('show');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });
  }

  let currentServicesIndex = 0;
  const screens = document.querySelectorAll('.deck-screen');
  const dots = document.querySelectorAll('.services-dot-btn');
  let isTransitioning = false;

  function switchServiceScreen(index) {
    if (index < 0 || index >= screens.length || isTransitioning) return;
    isTransitioning = true;
    currentServicesIndex = index;

    screens.forEach((scr, i) => {
      if (i === currentServicesIndex) {
        scr.classList.add('deck-screen-active');
      } else {
        scr.classList.remove('deck-screen-active');
      }
    });

    dots.forEach((dot, i) => {
      if (i === currentServicesIndex) {
        dot.classList.add('active');
      } else {
        dot.classList.remove('active');
      }
    });

    setTimeout(() => { isTransitioning = false; }, 350);
  }

  dots.forEach((dot, idx) => {
    dot.addEventListener('click', () => {
      switchServiceScreen(idx);
    });
  });

  let accumulatedDelta = 0;
  let resetTimer = null;

  window.addEventListener('wheel', (e) => {
    accumulatedDelta += e.deltaY;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { accumulatedDelta = 0; }, 180);

    if (isTransitioning) return;

    if (accumulatedDelta > 20 && currentServicesIndex < screens.length - 1) {
      accumulatedDelta = 0;
      switchServiceScreen(currentServicesIndex + 1);
    } else if (accumulatedDelta < -20 && currentServicesIndex > 0) {
      accumulatedDelta = 0;
      switchServiceScreen(currentServicesIndex - 1);
    }
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'ArrowRight') {
      if (currentServicesIndex < screens.length - 1) {
        switchServiceScreen(currentServicesIndex + 1);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'ArrowLeft') {
      if (currentServicesIndex > 0) {
        switchServiceScreen(currentServicesIndex - 1);
      }
    }
  });
})();
