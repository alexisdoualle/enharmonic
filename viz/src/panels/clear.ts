/** The card chrome main.ts mounts on a panel host: the view menu, the help `i` and the expand button. */
const CHROME = '.view-pick, .help-i, .panel-expand';

/** Empty a panel host for a re-render but keep its chrome and any `keep` nodes in place. A wipe would
 *  rebuild the chrome on every note during playback, closing an open view menu and eating clicks. */
export function clearPanel(host: HTMLElement, ...keep: (Element | null)[]): void {
    for (const child of [...host.children]) {
        if (!child.matches(CHROME) && !keep.includes(child)) child.remove();
    }
}
