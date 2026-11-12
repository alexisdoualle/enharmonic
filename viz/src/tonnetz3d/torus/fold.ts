/**
 * The lattice-to-torus fold: one map that carries a torus surface point from the flat sheet into the
 * tube (minor roll) and the torus (major bend), as in the tonnetz app's tools/diagrams/tonnetz-fold.html.
 * The lattice pose below is where it starts: the block, in place on the squashed lattice.
 *
 * The flat sheet is the torus unrolled around a centre (thetaC, phiC). Rolling and bending are circles of
 * radius r/b1 and R/b2, so at b1 = b2 = 1 the map is exactly `torusPos`: no jump at the handoff.
 *
 * The sheet is horizontal and seen from above, on whichever side of the tube keeps the lattice's
 * handedness (see `latticeSide`): the top (the outer surface) for the lattice as displayed.
 */
import * as THREE from 'three';
import { R, latticeToAngles } from './TorusGeometry.js';
import { ROW_SHIFT } from '../LatticeGeometry.js';

export interface FoldCentre { thetaC: number; phiC: number }

/** Fold a surface point. r = base tube radius (the roll radius), rt = this point's radius (r + level
 *  offset). b1 = minor roll 0..1, b2 = major bend 0..1. Writes position and unit outward normal. */
export function foldPoint(
    theta: number, phi: number, r: number, rt: number, b1: number, b2: number, c: FoldCentre,
    p: THREE.Vector3, n: THREE.Vector3,
): void {
    const tp = theta - c.thetaC, pp = phi - c.phiC;
    // Minor circle, in the meridian plane (rho = outward from the tube axis, h = height).
    const n0r = Math.cos(c.phiC), n0h = Math.sin(c.phiC), t0r = -n0h, t0h = n0r;
    let br: number, bh: number, nr: number, nh: number;
    if (b1 < 1e-4) {
        br = r * n0r + r * pp * t0r; bh = r * n0h + r * pp * t0h; nr = n0r; nh = n0h;
    } else {
        const a = pp * b1, k = r / b1, ca = Math.cos(a), sa = Math.sin(a);
        br = r * n0r + k * ((ca - 1) * n0r + sa * t0r);
        bh = r * n0h + k * ((ca - 1) * n0h + sa * t0h);
        nr = ca * n0r + sa * t0r; nh = ca * n0h + sa * t0h;
    }
    const rho = br + (rt - r) * nr, h = bh + (rt - r) * nh;
    // Major circle, in the horizontal plane.
    const m0x = Math.cos(c.thetaC), m0z = Math.sin(c.thetaC), s0x = -m0z, s0z = m0x;
    let cx: number, cz: number, mx: number, mz: number;
    if (b2 < 1e-4) {
        cx = R * m0x + R * tp * s0x; cz = R * m0z + R * tp * s0z; mx = m0x; mz = m0z;
    } else {
        const a = tp * b2, k = R / b2, ca = Math.cos(a), sa = Math.sin(a);
        cx = R * m0x + k * ((ca - 1) * m0x + sa * s0x);
        cz = R * m0z + k * ((ca - 1) * m0z + sa * s0z);
        mx = ca * m0x + sa * s0x; mz = ca * m0z + sa * s0z;
    }
    p.set(cx + rho * mx, h, cz + rho * mz);
    n.set(nr * mx, nh, nr * mz);
}

/** What the fold needs from the lattice scene: its grid anchor (fifths at column 0), where it draws each
 *  cell (mirrors included) and its camera. */
export interface LatticeView {
    startFifths: number;
    cellWorld: (col: number, row: number) => { x: number; y: number };
    position: THREE.Vector3;
    target: THREE.Vector3;
    up: THREE.Vector3;
    fov: number;
}

export interface CamPose { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; fov: number }

/** Which side of the tube the flat sheet lies on (its phi), seen from above. The torus's outer surface
 *  shows the Tonnetz one way round, the inner surface mirrored, so it depends on how the lattice is
 *  drawn: a torus fifth (cell +1, 0) then torus (0, 1) (cell +1, +1) turning clockwise from above means
 *  the outer surface, i.e. the top of the tube. */
export function latticeSide(view: LatticeView): number {
    const o = view.cellWorld(0, 0), f = view.cellWorld(1, 0), t = view.cellWorld(1, 1);
    const cross = (f.x - o.x) * (t.y - o.y) - (f.y - o.y) * (t.x - o.x);
    return cross < 0 ? Math.PI / 2 : -Math.PI / 2;
}

/**
 * Places the block on the squashed lattice. Torus vertex (x, y) is lattice cell (col = x + y + c0,
 * row = y + r0): a torus fifth is a lattice fifth, torus (-1, 1) is a lattice major third, and the
 * letters agree. A similarity (rotation, uniform scale, translation) takes lattice world space into the
 * torus group's local space, so the lattice camera, mapped the same way, sees the same picture.
 */
export class LatticePose {
    private c0 = 0;
    private r0 = 0;
    private readonly m = new THREE.Matrix4();
    /** The similarity's rotation and scale (lattice world -> torus group local). */
    readonly rot = new THREE.Quaternion();
    scale = 1;

    /** centre / centreAngles: the block's centre in lattice coordinates and its folded angles. The block
     *  sits under the lattice camera, and the lattice -> flat sheet morph turns about its centre.
     *  coverage(pose): how much of the block (0..1) the lattice actually draws at a candidate placement (the
     *  lattice only draws some accidental layers, so in a far key part of the grid is empty there). */
    constructor(
        private readonly view: LatticeView, r: number, c: FoldCentre,
        centre: [number, number], centreAngles: { theta: number; phi: number },
        coverage?: (pose: LatticePose) => number,
    ) {
        this.place(centre, coverage);
        this.fit(r, c, centre, centreAngles);
    }

    /** Lattice cell (column, row) of torus vertex (x, y). */
    cell(x: number, y: number): { col: number; row: number } {
        return { col: x + y + this.c0, row: y + this.r0 };
    }

    /** Squashed-lattice world position of torus vertex (x, y): bilinear in (col, row), so fractional
     *  points land where the lattice would draw them. */
    latticeWorld(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
        const { col, row } = this.cell(x, y);
        const o = this.view.cellWorld(0, 0), c = this.view.cellWorld(1, 0), r = this.view.cellWorld(0, 1);
        return out.set(o.x + col * (c.x - o.x) + row * (r.x - o.x), o.y + col * (c.y - o.y) + row * (r.y - o.y), 0);
    }

    /** The same point in the torus group's local space. */
    local(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
        return this.latticeWorld(x, y, out).applyMatrix4(this.m);
    }

    /** The lattice camera, in the torus group's local space. */
    camera(): CamPose {
        return {
            pos: this.view.position.clone().applyMatrix4(this.m),
            target: this.view.target.clone().applyMatrix4(this.m),
            up: this.view.up.clone().applyQuaternion(this.rot).normalize(),
            fov: this.view.fov,
        };
    }

    /** Choose (c0, r0): letters must match (startFifths + c0 + 4 r0 = 0 mod 7). Among those, the most
     *  complete block (by `coverage`), then the one nearest where the lattice camera is looking. */
    private place([xc, yc]: [number, number], coverage?: (pose: LatticePose) => number): void {
        const tx = this.view.target.x, ty = this.view.target.y;
        const cands: { c0: number; r0: number; d: number }[] = [];
        for (let r0 = -12; r0 <= 14; r0++) {
            for (let c0 = -40; c0 <= 40; c0++) {
                if ((((this.view.startFifths + c0 + ROW_SHIFT * r0) % 7) + 7) % 7 !== 0) continue;
                this.c0 = c0; this.r0 = r0;
                const w = this.latticeWorld(xc, yc, new THREE.Vector3());
                cands.push({ c0, r0, d: Math.hypot(w.x - tx, w.y - ty) });
            }
        }
        cands.sort((a, b) => a.d - b.d);
        let best = cands[0]!, bestScore = -1;
        for (const k of cands) {
            this.c0 = k.c0; this.r0 = k.r0;
            const score = coverage ? coverage(this) : 0;
            if (score > bestScore) { best = k; bestScore = score; }
            if (!coverage || score >= 1) break;   // nearest complete block
        }
        this.c0 = best.c0; this.r0 = best.r0;
    }

    /** Fit the similarity to the flat sheet: lattice up -> scene up (the sheet's inner side, facing the
     *  camera), lattice fifths -> the sheet's fifths direction, scale by triangle area, and the anchor
     *  onto its flat position. */
    private fit(r: number, c: FoldCentre, [wx, wy]: [number, number], wa: { theta: number; phi: number }): void {
        const P = new THREE.Vector3(), N = new THREE.Vector3();
        const flat = (theta: number, phi: number): THREE.Vector3 => {
            foldPoint(theta, phi, r, r, 0, 0, c, P, N);
            return P.clone();
        };
        const step = (x: number, y: number): THREE.Vector3 => {
            const a = latticeToAngles(x, y), z = latticeToAngles(0, 0);
            return flat(wa.theta + a.theta - z.theta, wa.phi + a.phi - z.phi).sub(flat(wa.theta, wa.phi));
        };
        const f = step(1, 0), t = step(0, 1);
        foldPoint(c.thetaC, c.phiC, r, r, 0, 0, c, P, N);
        const v = N.clone().normalize();                                  // lattice +z: the face seen from above
        if (v.y < 0) v.negate();
        const u = f.clone().addScaledVector(v, -f.dot(v)).normalize();    // lattice +x
        const w = new THREE.Vector3().crossVectors(v, u);                 // lattice +y
        this.rot.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, w, v));
        const lo = this.latticeWorld(0, 0, new THREE.Vector3()), lf = this.latticeWorld(1, 0, new THREE.Vector3()).sub(lo);
        const lt = this.latticeWorld(0, 1, new THREE.Vector3()).sub(lo);
        const s = this.scale = Math.sqrt(new THREE.Vector3().crossVectors(f, t).length() / new THREE.Vector3().crossVectors(lf, lt).length());
        const lat = this.latticeWorld(wx, wy, new THREE.Vector3()).applyQuaternion(this.rot).multiplyScalar(s);
        this.m.compose(flat(wa.theta, wa.phi).sub(lat), this.rot, new THREE.Vector3(s, s, s));
    }
}
