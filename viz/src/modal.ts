/** Expand a panel into a large centred card over a dimmed page (not the browser's fullscreen). The panel
 *  stays in place in the DOM; a class pins it. Esc, the backdrop, or the corner button closes it. */

/** The cards that get the corner expand button, next to their help `i`. */
const EXPANDABLE = ['scoring', 'wheel', 'live-tonnetz', 'spirals', 'tonnetz'];

let open: HTMLElement | null = null;
let backdrop: HTMLElement | null = null;
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); collapse(); } };

export function collapse(): void {
    if (!open) return;
    open.classList.remove('panel-modal');
    open = null;
    backdrop?.remove(); backdrop = null;
    document.removeEventListener('keydown', onKey, true);
}

export function expand(host: HTMLElement): void {
    collapse();
    backdrop = document.createElement('div');
    backdrop.className = 'panel-backdrop';
    backdrop.addEventListener('click', collapse);
    document.body.appendChild(backdrop);
    host.classList.add('panel-modal');
    open = host;
    document.addEventListener('keydown', onKey, true);
}

/** Add the corner expand button to each card (re-added after a panel re-renders and wipes it). The panel's
 *  state lives in its class, so a re-added button still closes an open card. */
export function mountExpandButtons(): void {
    for (const id of EXPANDABLE) {
        const host = document.getElementById(id);
        if (!host || host.querySelector(':scope > .panel-expand')) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'panel-expand';
        btn.title = 'expand (Esc closes)';
        btn.setAttribute('aria-label', 'expand or close the panel');
        btn.addEventListener('click', e => { e.stopPropagation(); if (open === host) collapse(); else expand(host); });
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(btn);
    }
}
