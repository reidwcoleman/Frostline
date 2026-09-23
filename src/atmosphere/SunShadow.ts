// Cascaded shadow for three's SunLight with a configurable cascade count (three ships 2).
// The WebGL renderer drives this through the SunLight path, so every lit material gets cascaded shadows
// without per-material setup. Cascades are bounding spheres (rotation-invariant size) snapped to the
// shadow texel grid, so they don't shimmer as the camera turns or moves.
import * as THREE from 'three';

const _orient = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _lightDir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _near = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _far = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

export class FrostSunShadow extends THREE.LightShadow<THREE.OrthographicCamera> {
  readonly isSunLightShadow = true;
  readonly cascades: number;
  /** Maximum shadow distance from the camera (m). */
  distance = 300;
  /** Blend between uniform (0) and logarithmic (1) cascade splits. */
  lambda = 0.82;
  /** Fraction of each cascade blended into the next. */
  fade = 0.12;
  /** Metres above the cascade to still catch casters (tall trees on slopes, cliffs). */
  casterMargin = 400;

  _cameras: THREE.OrthographicCamera[] = [];
  _matrices: THREE.Matrix4[] = [];
  _frustums: THREE.Frustum[] = [];
  _cascadeData: THREE.Vector4[] = [];
  private splits: number[];

  constructor(cascades: number) {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.cascades = cascades;
    this.mapSize.set(2048, 2048);
    this.splits = new Array(cascades + 1).fill(0);
    const self = this as unknown as { _viewportCount: number; _frameExtents: THREE.Vector2; _viewports: THREE.Vector4[] };
    self._viewportCount = cascades;
    self._frameExtents.set(cascades, 1);
    for (let i = 0; i < cascades; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new THREE.Frustum());
      this._cascadeData.push(new THREE.Vector4());
    }
    while (self._viewports.length < cascades) self._viewports.push(new THREE.Vector4());
  }

  getCamera(i = 0): THREE.OrthographicCamera {
    return this._cameras[i];
  }
  getMatrix(i = 0): THREE.Matrix4 {
    return this._matrices[i];
  }
  getFrustum(i = 0): THREE.Frustum {
    return this._frustums[i];
  }

  /** Split distances (m) for debugging / UI. */
  get splitDistances(): readonly number[] {
    return this.splits;
  }

  updateMatrices(light: THREE.Light, viewCamera?: THREE.Camera): void {
    const cam = viewCamera as THREE.PerspectiveCamera | undefined;
    if (!cam) return;
    const self = this as unknown as { _viewports: THREE.Vector4[] };
    const n = this.cascades;
    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
    for (let i = 0; i < n; i++) self._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    const resX = this.mapSize.x * (1 - 2 * insetX);
    const resY = this.mapSize.y * (1 - 2 * insetY);
    const res = Math.min(resX, resY);

    const near = cam.near;
    const far = Math.max(near + 1e-3, Math.min(this.distance, cam.far));
    const sp = this.splits;
    sp[0] = near;
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const uni = near + (far - near) * f;
      const log = near * Math.pow(far / near, f);
      sp[i] = uni + (log - uni) * this.lambda;
    }
    sp[n] = far;

    _lightDir.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_lightDir)) > 0.99) _up.set(0, 0, 1);
    _orient.lookAt(_center.set(0, 0, 0), _lightDir, _up);
    _viewToLight.copy(_orient).transpose().multiply(cam.matrixWorld);

    const inv = cam.projectionMatrixInverse;
    let maxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const nc = _near[i].set(x, y, -1).applyMatrix4(inv);
      _far[i].copy(nc).multiplyScalar(far / near);
      nc.applyMatrix4(_viewToLight);
      _far[i].applyMatrix4(_viewToLight);
      maxZ = Math.max(maxZ, nc.z, _far[i].z);
    }
    maxZ += this.casterMargin;
    const shadowNear = this.camera.near;

    for (let i = 0; i < n; i++) {
      const cNear = i === 0 ? sp[0] : this._cascadeData[i - 1].z;
      const cFar = sp[i + 1];
      const fadeStart = cFar - this.fade * (cFar - sp[i]);
      this._cascadeData[i].set(i === 0 ? -1e10 : cNear, cFar, fadeStart, 0);

      const a0 = (cNear - near) / (far - near);
      const a1 = (cFar - near) / (far - near);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _corners[j * 2].lerpVectors(_near[j], _far[j], a0);
        _corners[j * 2 + 1].lerpVectors(_near[j], _far[j], a1);
        _center.add(_corners[j * 2]).add(_corners[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let r2 = 0,
        minZ = Infinity;
      for (let j = 0; j < 8; j++) {
        r2 = Math.max(r2, _corners[j].distanceToSquared(_center));
        minZ = Math.min(minZ, _corners[j].z);
      }
      // Quantise the radius so the texel size only changes in coarse steps (no swimming on FOV changes).
      let radius = Math.ceil(Math.sqrt(r2) * 4) / 4;
      if (res > 1) {
        radius /= 1 - 1 / res;
        const tx = (2 * radius) / resX,
          ty = (2 * radius) / resY;
        _center.x = Math.round(_center.x / tx) * tx;
        _center.y = Math.round(_center.y / ty) * ty;
      }
      _center.z = maxZ + shadowNear;
      _center.applyMatrix4(_orient);

      const c = this._cameras[i];
      c.position.copy(_center);
      c.quaternion.setFromRotationMatrix(_orient);
      c.left = -radius;
      c.right = radius;
      c.top = radius;
      c.bottom = -radius;
      c.near = shadowNear;
      c.far = maxZ - minZ + 2 * shadowNear;
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
      (this as unknown as { _updateMatrix: (c: THREE.Camera, m: THREE.Matrix4, f: THREE.Frustum, v: THREE.Vector4) => void })._updateMatrix(
        c,
        this._matrices[i],
        this._frustums[i],
        self._viewports[i],
      );
    }
  }
}
