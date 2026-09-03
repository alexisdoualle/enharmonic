/**
 * Triangle-opacity constants the 3D scene reads. In the original tonnetz app these live in the big
 * `tonnetz.ts` UI module (and `TRI_OPACITY_BASE` is slider-mutable); here we only vendor the scene, so
 * the two values it actually imports are pinned to the app's defaults.
 */
export const TRI_OPACITY_BASE = 0.5; // scale-active, no resonance
export const TRI_OPACITY_HELD = 1.0; // full resonance / held
