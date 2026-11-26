// Dedicated Archive mobile menu toggle (externalized for strict zero-unsafe-inline CSP)
(function () {
  const navToggle = document.getElementById('nav-toggle');
  const navMenu = document.getElementById('nav-menu');
  if (navToggle && navMenu) {
    navToggle.addEventListener('click', () => {
      const isOpen = navMenu.classList.toggle('show');
      navToggle.setAttribute('aria-expanded', String(isOpen));
    });
  }
})();
