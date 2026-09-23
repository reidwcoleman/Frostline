// Campfires: fuel (in-game hours), burning → embers → cold, animated flames, embers, smoke,
// a flickering pooled point light, positioned crackle loop, warmth field, cooking and wolf-fear.
//
// The stone ring / logs / spit geometry belongs to the campfire build piece (Pieces.ts); a Fire
// only owns the living part (FX, light, sound, interactions, fuel).
import * as THREE from 'three';
import type { GameContext, LoopHandle } from '../core/types';
import type { LightHandle } from '../atmosphere/Sky';
import type { Effects } from './Particles';
import { clamp, damp, smoothstep } from '../core/math';
import { matTime } from './Materials';

export const FIRE = {
  /** Fuel added by one log / one stick (in-game hours). */
  logHours: 2,
  stickHours: 0.35,
  /** Fuel a freshly built campfire starts with. */
  startHours: 1.5,
  maxHours: 10, // a well-stocked fire (5 logs) lasts a whole night's sleep
  /** Embers glow this long after the flames die; adding fuel rekindles without a stick. */
  emberHours: 0.75,
  /** Warmth radius (m) at full strength; sheltered fires reach further. */
  radius: 6,
  /** Standing in the flames. */
  burnRadius: 0.55,
  burnDps: 6,
  /** Cooking one piece of meat (hold time, s). */
  cookSeconds: 3,
};

export type FireState = 'burning' | 'embers' | 'cold';

export interface FireSave {
  fuel: number;
  state: FireState;
  ember: number;
}

// ------------------------------------------------------------------ flame shader
const FLAME_VERT = /* glsl */ `
  attribute vec2 aCorner;
  attribute vec3 aOffset;
  attribute vec3 aDims; // width, height, phase
  uniform float uStrength;
  varying vec2 vUv;
  varying float vPhase;
  void main() {
    vec3 c = (modelMatrix * vec4(aOffset, 1.0)).xyz;
    vec3 toCam = cameraPosition - c;
    toCam.y = 0.0;
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), normalize(toCam + vec3(1e-4, 0.0, 0.0))));
    float s = uStrength;
    float w = aDims.x * (0.55 + 0.45 * s);
    float h = aDims.y * (0.35 + 0.65 * s);
    vec3 wp = c + right * aCorner.x * w + vec3(0.0, aCorner.y * h, 0.0);
    // Pull the billboard slightly toward the camera so it doesn't clip into the logs.
    wp += normalize(cameraPosition - c) * 0.12;
    vUv = vec2(aCorner.x + 0.5, aCorner.y);
    vPhase = aDims.z;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  varying vec2 vUv;
  varying float vPhase;
  float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float t = uTime + vPhase * 7.0;
    float y = vUv.y;
    float x = (vUv.x - 0.5) * 2.0;
    float n = n2(vec2(vUv.x * 3.0 + vPhase * 3.0, y * 2.6 - t * 2.4));
    float n2v = n2(vec2(vUv.x * 7.0 - vPhase, y * 6.0 - t * 4.1));
    float sway = (n2(vec2(t * 0.8, vPhase * 5.0)) - 0.5) * 0.5 * y * y;
    float xo = x + sway + (n2v - 0.5) * 0.35 * y;
    float width = mix(0.95, 0.08, pow(y, 0.8)) * (0.8 + 0.4 * n);
    float shape = 1.0 - smoothstep(width * 0.45, width, abs(xo));
    shape *= smoothstep(0.0, 0.1, y);
    // Tongues: break the top into licks.
    float lick = smoothstep(0.25, 0.9, y + (n - 0.5) * 0.7 + (n2v - 0.5) * 0.3);
    float body = shape * (1.0 - lick);
    float heat = body * (1.15 - y * 0.8);
    vec3 col = mix(vec3(0.75, 0.08, 0.01), vec3(1.0, 0.36, 0.05), smoothstep(0.05, 0.45, heat));
    col = mix(col, vec3(1.0, 0.72, 0.32), smoothstep(0.45, 0.85, heat));
    col = mix(col, vec3(1.0, 0.93, 0.75), smoothstep(0.85, 1.05, heat));
    float a = body * uStrength;
    gl_FragColor = vec4(col * a * 3.2, 1.0);
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform float uStrength;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 c = vUv * 2.0 - 1.0;
    float r = length(c);
    float g = pow(max(0.0, 1.0 - r), 2.2);
    float flick = 0.9 + 0.1 * sin(uTime * 13.0) * sin(uTime * 7.3 + 1.0);
    gl_FragColor = vec4(vec3(1.0, 0.42, 0.13) * g * uStrength * flick * 0.55, 1.0);
  }
`;
const GLOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

let _flameGeo: THREE.BufferGeometry | null = null;
/** 4 camera-facing flame tongues (cylindrical billboards) in one geometry. */
function flameGeometry(): THREE.BufferGeometry {
  if (_flameGeo) return _flameGeo;
  const tongues = [
    [0, 0.05, 0, 0.62, 1.15, 0.0],
    [0.1, 0.04, 0.08, 0.5, 0.9, 0.37],
    [-0.1, 0.04, -0.06, 0.48, 0.85, 0.71],
    [0.02, 0.03, -0.12, 0.42, 0.7, 0.53],
    [-0.06, 0.03, 0.11, 0.38, 0.62, 0.19],
  ];
  const corner: number[] = [],
    offset: number[] = [],
    dims: number[] = [],
    pos: number[] = [],
    idx: number[] = [];
  tongues.forEach((t, k) => {
    for (const [cx, cy] of [
      [-0.5, 0],
      [0.5, 0],
      [0.5, 1],
      [-0.5, 1],
    ]) {
      corner.push(cx, cy);
      offset.push(t[0], t[1], t[2]);
      dims.push(t[3], t[4], t[5]);
      pos.push(t[0], t[1] + cy, t[2]);
    }
    const b = k * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute('aOffset', new THREE.Float32BufferAttribute(offset, 3));
  g.setAttribute('aDims', new THREE.Float32BufferAttribute(dims, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2);
  _flameGeo = g;
  return g;
}

const _v = new THREE.Vector3();

let nextFireId = 1;

export class Fire {
  readonly id = nextFireId++;
  fuel = FIRE.startHours;
  state: FireState = 'burning';
  /** Remaining ember time (hours). */
  ember = 0;
  /** Smoothed visual/thermal strength 0..1. */
  strength = 0;
  /** 0..1 roofed (burns slower in snowfall, warms more). */
  roofed = 0;
  readonly group = new THREE.Group();
  private flameMat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  private light: LightHandle | null = null;
  private loop: LoopHandle | null = null;
  private removers: (() => void)[] = [];
  private emberAcc = 0;
  private smokeAcc = 0;
  private flicker = 0;
  private shelterTimer = 0;
  private smokeY = 0.9;
  /** Glow uniforms of this fire's own ash/charred-log material variants. */
  glowUniforms: { value: number }[] = [];

  constructor(
    private ctx: GameContext,
    private fx: Effects,
    readonly position: THREE.Vector3,
    private owner: FireManager,
    /** Built on a wooden floor (no ground-glow decal: it would float past the floor edges). */
    readonly onFloor = false,
  ) {
    this.flameMat = new THREE.ShaderMaterial({
      uniforms: { uTime: matTime, uStrength: { value: 0 } },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const flames = new THREE.Mesh(flameGeometry(), this.flameMat);
    flames.frustumCulled = false;
    flames.renderOrder = 7;
    flames.position.y = 0.08;
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { uTime: matTime, uStrength: { value: 0 } },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), this.glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.04;
    glow.renderOrder = 4;
    this.group.add(flames, glow);
    this.group.position.copy(position);
    ctx.scene.add(this.group);
    this.addInteractions();
  }

  get lit() {
    return this.state === 'burning';
  }

  /** Warmth contribution 0..1 at a distance (m) from the fire. */
  warmthAt(d: number): number {
    if (this.state === 'cold') return 0;
    const s = this.state === 'burning' ? this.strength : (this.ember / FIRE.emberHours) * 0.25;
    const r = FIRE.radius * (1 + 0.35 * this.roofed) * (this.state === 'burning' ? 0.6 + 0.4 * this.strength : 0.35);
    return s * (1 - smoothstep(0.9, r, d));
  }

  private addInteractions() {
    const { ctx } = this;
    const inv = ctx.inventory;
    const fuelPos = this.position.clone().add(new THREE.Vector3(0, 0.25, 0));
    this.removers.push(
      ctx.interact.add({
        position: fuelPos,
        radius: 0.55,
        label: () => {
          if (this.state === 'cold') return 'Light fire';
          const verb = this.state === 'embers' ? 'Rekindle with' : 'Add';
          if (inv.has('log')) return `${verb} log (burns ${FIRE.logHours}h)`;
          return `${verb} stick (burns ${Math.round(FIRE.stickHours * 60)}m)`;
        },
        blockedReason: () => {
          if (this.state === 'cold') return inv.has('stick') ? null : 'Need a stick to light the fire';
          if (!inv.has('log') && !inv.has('stick')) return 'Need logs or sticks';
          if (this.fuel > FIRE.maxHours - 0.3) return 'The fire is roaring';
          return null;
        },
        onInteract: () => this.feed(),
      }),
    );
    const cookPos = this.position.clone().add(new THREE.Vector3(0, 0.85, 0));
    this.removers.push(
      ctx.interact.add({
        position: cookPos,
        radius: 0.3,
        holdTime: FIRE.cookSeconds,
        enabled: () => this.state === 'burning' && inv.has('raw_meat'),
        label: () => `Cook meat (${inv.count('raw_meat')})`,
        onInteract: () => this.cook(),
      }),
    );
  }

  /** Add one log (preferred) or stick; lights a cold fire with a stick. */
  feed() {
    const { ctx } = this;
    const inv = ctx.inventory;
    const wasBurning = this.state === 'burning';
    if (this.state === 'cold') {
      if (!inv.remove('stick', 1)) return;
      this.fuel = FIRE.stickHours * 1.5;
    } else if (inv.has('log')) {
      inv.remove('log', 1);
      this.fuel = Math.min(FIRE.maxHours, this.fuel + FIRE.logHours);
    } else if (inv.has('stick')) {
      inv.remove('stick', 1);
      this.fuel = Math.min(FIRE.maxHours, this.fuel + FIRE.stickHours);
    } else return;
    this.fx.sparks(this.position.x, this.position.y + 0.3, this.position.z, 26);
    this.fx.smoke(this.position.x, this.position.y + 0.5, this.position.z, 1.5, 0.5);
    if (!wasBurning) this.ignite();
    else ctx.audio.play('fire_ignite', { position: this.position, volume: 0.45, pitch: 1.2 });
  }

  ignite() {
    this.state = 'burning';
    this.ember = 0;
    this.ctx.audio.play('fire_ignite', { position: this.position });
    this.ctx.events.emit('fire:lit', { id: this.id });
  }

  private cook() {
    const { ctx } = this;
    if (!ctx.inventory.remove('raw_meat', 1)) return;
    ctx.inventory.add('cooked_meat', 1);
    ctx.audio.play('cook_sizzle', { position: this.position });
    for (let i = 0; i < 6; i++) this.fx.smoke(this.position.x, this.position.y + 0.9, this.position.z, 1.2, 0.75);
    ctx.events.emit('item:crafted', { recipe: 'cook', item: 'cooked_meat', count: 1 });
  }

  /** dt real seconds; hours = in-game hours elapsed this frame. */
  update(dt: number, hours: number, camPos: THREE.Vector3, wantLight: boolean) {
    const { ctx } = this;
    const env = ctx.env;
    // Re-check roof cover every few seconds (buildings can change around a fire).
    this.shelterTimer -= dt;
    if (this.shelterTimer <= 0) {
      this.shelterTimer = 3;
      _v.set(0, 1, 0);
      const hit = ctx.physics.raycast(this.position.clone().setY(this.position.y + 1.2), _v, 7, { terrain: false, trees: false, rocks: false });
      this.roofed = hit ? 1 : 0;
      // Smoke leaves through the roof (as if through a smoke hole) instead of seeping out of the walls.
      this.smokeY = hit ? 1.2 + hit.distance + 0.45 : 0.9;
    }
    if (this.state === 'burning') {
      const exposure = 1 - this.roofed;
      const rate = 1 + env.snowfall * 0.8 * exposure + env.windStrength * 0.5 * exposure;
      this.fuel -= hours * rate;
      if (this.fuel <= 0) {
        this.fuel = 0;
        this.state = 'embers';
        this.ember = FIRE.emberHours;
        ctx.audio.play('fire_out', { position: this.position });
        ctx.events.emit('fire:out', { id: this.id });
      }
    } else if (this.state === 'embers') {
      this.ember -= hours;
      if (this.ember <= 0) {
        this.ember = 0;
        this.state = 'cold';
      }
    }
    const target = this.state === 'burning' ? clamp(0.45 + this.fuel * 0.35, 0.45, 1) : 0;
    this.strength = damp(this.strength, target, this.state === 'burning' ? 1.5 : 0.6, dt);
    const emberGlow = this.state === 'burning' ? 1 : this.state === 'embers' ? 0.25 + 0.6 * (this.ember / FIRE.emberHours) : 0;

    // Flicker: layered sines + noise, strongest at low strength (a dying fire gutters).
    this.flicker = damp(this.flicker, Math.random(), 18, dt);
    const t = ctx.time;
    const fl = 0.82 + 0.1 * Math.sin(t * 11.3) * Math.sin(t * 6.1 + 2) + 0.12 * this.flicker;
    this.flameMat.uniforms.uStrength.value = this.strength;
    this.group.children[0].visible = this.strength > 0.02;
    this.glowMat.uniforms.uStrength.value = this.strength * fl + emberGlow * 0.15;
    // The fake bounce-light decal only suits open ground; indoors the point light does the job.
    this.group.children[1].visible = !this.onFloor && this.roofed < 0.5;
    const coal = Math.max(emberGlow * 0.9, this.strength);
    for (const u of this.glowUniforms) u.value = coal;

    // Light from the pool (the nearest fires get one).
    if (wantLight && (this.strength > 0.03 || this.state === 'embers')) {
      if (!this.light) this.light = ctx.sys.sky?.acquireLight?.() ?? null;
      if (this.light) {
        const L = this.light.light;
        L.color.setRGB(1, 0.46 + 0.08 * this.flicker, 0.16);
        // Point lights have no shadows here, so a fire inside a cabin keeps a short range to avoid
        // lighting the snow through the walls.
        const inside = this.roofed > 0.5;
        L.intensity = (this.strength * (inside ? 16 : 26) + emberGlow * 1.2) * fl;
        L.distance = inside ? 5.2 + this.strength * 0.6 : 18 + 6 * this.strength;
        L.decay = 2;
        L.position.set(this.position.x + (this.flicker - 0.5) * 0.06, this.position.y + 0.75 + this.strength * 0.2, this.position.z);
      }
    } else if (this.light) {
      this.light.release();
      this.light = null;
    }

    // Crackle loop.
    const near = camPos.distanceToSquared(this.position) < 60 * 60;
    if (this.state === 'burning' && near) {
      if (!this.loop) this.loop = ctx.audio.loop('fire_crackle', { position: this.position, volume: 0 });
      this.loop.setVolume(0.25 + 0.75 * this.strength);
      this.loop.setPosition(this.position);
    } else if (this.loop) {
      this.loop.stop(1.5);
      this.loop = null;
    }

    // Particles (only when someone could see them).
    if (camPos.distanceToSquared(this.position) < 140 * 140) {
      if (this.strength > 0.05) {
        this.emberAcc += dt * (4 + 10 * this.strength);
        while (this.emberAcc > 1) {
          this.emberAcc -= 1;
          this.fx.ember(this.position.x, this.position.y + 0.4, this.position.z, this.strength);
        }
      }
      const smokeRate = this.state === 'burning' ? 1.5 + this.strength * 2.5 : this.state === 'embers' ? 1.2 : 0;
      this.smokeAcc += dt * smokeRate;
      while (this.smokeAcc > 1) {
        this.smokeAcc -= 1;
        const sy = this.roofed > 0.5 ? this.smokeY : this.smokeY + this.strength * 0.5;
        this.fx.smoke(this.position.x, this.position.y + sy, this.position.z, this.state === 'burning' ? 0.6 + 0.6 * this.strength : 0.8, 0.3);
      }
    }
    this.owner.touch();
  }

  serialize(): FireSave {
    return { fuel: this.fuel, state: this.state, ember: this.ember };
  }

  restore(s: FireSave) {
    this.fuel = s.fuel;
    this.state = s.state;
    this.ember = s.ember;
    this.strength = s.state === 'burning' ? clamp(0.45 + s.fuel * 0.35, 0.45, 1) : 0;
  }

  dispose() {
    for (const r of this.removers) r();
    this.removers.length = 0;
    this.light?.release();
    this.light = null;
    this.loop?.stop(0.5);
    this.loop = null;
    this.ctx.scene.remove(this.group);
    (this.group.children[1] as THREE.Mesh).geometry.dispose();
    this.flameMat.dispose();
    this.glowMat.dispose();
  }
}

export interface FirePos {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export class FireManager {
  readonly fires: Fire[] = [];
  private positions: FirePos[] = [];
  private posFrame = -1;
  private lightOrder: Fire[] = [];

  constructor(private ctx: GameContext, private fx: Effects) {}

  create(pos: THREE.Vector3, state?: FireSave, onFloor = false): Fire {
    const f = new Fire(this.ctx, this.fx, pos.clone(), this, onFloor);
    if (state) f.restore(state);
    else f.ignite();
    this.fires.push(f);
    return f;
  }

  remove(f: Fire) {
    const i = this.fires.indexOf(f);
    if (i < 0) return; // already cleared (reset)
    this.fires.splice(i, 1);
    if (f.lit) this.ctx.events.emit('fire:out', { id: f.id });
    f.dispose();
  }

  clear() {
    for (const f of this.fires) f.dispose();
    this.fires.length = 0;
  }

  /** Called by fires each update so cached positions refresh. */
  touch() {
    this.posFrame = -1;
  }

  update(dt: number, hours: number) {
    const cam = this.ctx.camera.position;
    // The 3 nearest visible fires get pooled lights (the pool is shared with torches/flares).
    this.lightOrder.length = 0;
    for (const f of this.fires) if (f.state !== 'cold') this.lightOrder.push(f);
    this.lightOrder.sort((a, b) => a.position.distanceToSquared(cam) - b.position.distanceToSquared(cam));
    for (const f of this.fires) {
      const rank = this.lightOrder.indexOf(f);
      f.update(dt, hours, cam, rank >= 0 && rank < 3 && f.position.distanceToSquared(cam) < 160 * 160);
    }
  }

  /** Summed warmth 0..1 at a point, plus the distance to the nearest lit fire. */
  warmthAt(p: THREE.Vector3): number {
    let w = 0;
    for (const f of this.fires) {
      const d = Math.hypot(p.x - f.position.x, (p.y - f.position.y) * 0.7, p.z - f.position.z);
      w += f.warmthAt(d);
    }
    return clamp(w, 0, 1.25);
  }

  /** Distance (m) to the nearest burning fire, or Infinity. */
  nearestLit(p: THREE.Vector3): number {
    let best = Infinity;
    for (const f of this.fires) {
      if (!f.lit) continue;
      const d = p.distanceTo(f.position);
      if (d < best) best = d;
    }
    return best;
  }

  /** Is the point standing in the flames? */
  inFlames(p: THREE.Vector3): boolean {
    for (const f of this.fires) {
      if (!f.lit || f.strength < 0.2) continue;
      const dx = p.x - f.position.x,
        dz = p.z - f.position.z;
      if (dx * dx + dz * dz < FIRE.burnRadius * FIRE.burnRadius && Math.abs(p.y - f.position.y) < 0.8) return true;
    }
    return false;
  }

  /** Lit fires as {x,y,z,radius} — wolves keep out of `radius`. Cached per frame; don't mutate. */
  positionsList(): FirePos[] {
    if (this.posFrame === this.ctx.frame) return this.positions;
    this.posFrame = this.ctx.frame;
    this.positions.length = 0;
    for (const f of this.fires) {
      if (f.state === 'cold') continue;
      const r = f.lit ? 7 + 5 * f.strength : 2.5;
      this.positions.push({ x: f.position.x, y: f.position.y, z: f.position.z, radius: r });
    }
    return this.positions;
  }
}
