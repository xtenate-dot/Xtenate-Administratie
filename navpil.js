// navpil.js — de gekleurde markering in het zijmenu glijdt naar de pagina
// waar je heen gaat, in plaats van op de nieuwe plek te verschijnen.
//
// Puur uiterlijk: deze module leest alleen waar het actieve menu-item staat
// en verplaatst één decoratief element. Er wordt geen data aangeraakt. Gaat er
// iets mis (bijvoorbeeld een oude browser), dan valt het menu terug op de
// gewone markering per item.

let pil = null;
let eerste = true;

function zijmenu() { return document.querySelector('.sidebar'); }

function maakPil(menu) {
  if (pil && pil.isConnected) return pil;
  pil = document.createElement('div');
  pil.className = 'nav-pil';
  pil.setAttribute('aria-hidden', 'true');
  menu.prepend(pil);
  return pil;
}

/** Zet de pil achter het actieve menu-item. */
export function zetNavPil() {
  try {
    const menu = zijmenu();
    const actief = menu?.querySelector('.nav-item.active');
    // Staat het item in een dichtgeklapte groep, dan is het niet zichtbaar.
    if (!menu || !actief || actief.offsetParent === null) {
      if (menu?.classList.contains('heeft-pil')) menu.classList.remove('heeft-pil');
      return;
    }
    const p = maakPil(menu);
    const m = menu.getBoundingClientRect();
    const r = actief.getBoundingClientRect();
    const top = r.top - m.top + menu.scrollTop;

    // De allereerste plaatsing mag niet "invliegen" vanaf de bovenkant.
    if (eerste) p.classList.add('zonder-beweging');
    p.style.transform = `translateY(${Math.round(top)}px)`;
    p.style.height = `${Math.round(r.height)}px`;
    if (!menu.classList.contains('heeft-pil')) menu.classList.add('heeft-pil');
    if (eerste) {
      void p.offsetHeight;                 // eerst laten plaatsen, dan pas animeren
      p.classList.remove('zonder-beweging');
      eerste = false;
    }
  } catch (e) {
    console.warn('Menumarkering kon niet worden geplaatst:', e);
    zijmenu()?.classList.remove('heeft-pil');
  }
}

/** Volgt het menu een korte tijd, bijvoorbeeld terwijl het in- of uitklapt. */
export function volgNavPil(ms = 320) {
  const eind = performance.now() + ms;
  const stap = () => {
    zetNavPil();
    if (performance.now() < eind) requestAnimationFrame(stap);
  };
  requestAnimationFrame(stap);
}

export function initNavPil() {
  const menu = zijmenu();
  if (!menu) return;
  zetNavPil();
  window.addEventListener('resize', () => zetNavPil());
  menu.addEventListener('scroll', () => zetNavPil(), { passive: true });
  // Groep open/dicht of menu in/uit klappen verschuift de items.
  new MutationObserver(() => volgNavPil(300)).observe(menu, {
    attributes: true, subtree: true, attributeFilter: ['class']
  });
  new MutationObserver(() => volgNavPil(300)).observe(document.body, {
    attributes: true, attributeFilter: ['class']
  });
  // Lettertypes die later laden veranderen de hoogtes.
  document.fonts?.ready?.then(() => zetNavPil());
}
