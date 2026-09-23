// Shared GLSL snippets for the world renderers (terrain, trees, rocks, scatter).
// Everything is procedural: hashes + small tileable noise textures (see ProceduralTextures.ts).

/** Cheap, well-distributed hashes (no sin()) — Dave Hoskins' "hash without sine". */
export const GLSL_HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * Exact GPU replica of core/Terrain.heightAt(): Catmull-Rom bicubic heightmap + the two
 * simplex "detail" octaves (same permutation table), damped on the lake. Outside the 4 km
 * world the heightmap is mirrored so the far mountain ring never shows an edge.
 * Requires uniforms declared in TERRAIN_HEIGHT_PARS.
 */
export const GLSL_TERRAIN_HEIGHT = /* glsl */ `
uniform highp sampler2D tHeightTex; // R32F heights, res x res
uniform highp sampler2D tPermTex;   // R8 256x1 simplex permutation
uniform sampler2D tMaskTex;         // RGBA8: lake, flow, forest, snow cover
uniform vec4 tDims;                 // half, cell, res-1 (as float), 1/cell

int tMirror(int i, int n) {
  int period = 2 * n;
  int m = (i + 8 * period) % period;
  return m > n ? period - m : m;
}
float tH(int i, int j, bool inside) {
  int n = int(tDims.z);
  ivec2 p = inside ? ivec2(clamp(i, 0, n), clamp(j, 0, n)) : ivec2(tMirror(i, n), tMirror(j, n));
  return texelFetch(tHeightTex, p, 0).r;
}
float tCubic(float p0, float p1, float p2, float p3, float t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + t * (3.0 * (p1 - p2) + p3 - p0)));
}
float tBaseHeight(vec2 xz) {
  bool inside = abs(xz.x) <= tDims.x && abs(xz.y) <= tDims.x;
  vec2 g = (xz + tDims.x) * tDims.w;
  vec2 fi = floor(g);
  vec2 f = g - fi;
  int ix = int(fi.x), iz = int(fi.y);
  float r0 = tCubic(tH(ix - 1, iz - 1, inside), tH(ix, iz - 1, inside), tH(ix + 1, iz - 1, inside), tH(ix + 2, iz - 1, inside), f.x);
  float r1 = tCubic(tH(ix - 1, iz, inside), tH(ix, iz, inside), tH(ix + 1, iz, inside), tH(ix + 2, iz, inside), f.x);
  float r2 = tCubic(tH(ix - 1, iz + 1, inside), tH(ix, iz + 1, inside), tH(ix + 1, iz + 1, inside), tH(ix + 2, iz + 1, inside), f.x);
  float r3 = tCubic(tH(ix - 1, iz + 2, inside), tH(ix, iz + 2, inside), tH(ix + 1, iz + 2, inside), tH(ix + 2, iz + 2, inside), f.x);
  return tCubic(r0, r1, r2, r3, f.y);
}
// Bilinear lake mask exactly like Terrain.mask() (clamped, texel-exact).
float tLake(vec2 xz) {
  float n = tDims.z;
  vec2 g = clamp((xz + tDims.x) * tDims.w, vec2(0.0), vec2(n - 0.001));
  ivec2 i = ivec2(g);
  vec2 f = g - vec2(i);
  float a = texelFetch(tMaskTex, i, 0).r;
  float b = texelFetch(tMaskTex, i + ivec2(1, 0), 0).r;
  float c = texelFetch(tMaskTex, i + ivec2(0, 1), 0).r;
  float d = texelFetch(tMaskTex, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
int tPerm(int k) { return int(texelFetch(tPermTex, ivec2(k & 255, 0), 0).r * 255.0 + 0.5); }
vec2 tGrad(int h) {
  h &= 7;
  if (h == 0) return vec2(1.0, 1.0);
  if (h == 1) return vec2(-1.0, 1.0);
  if (h == 2) return vec2(1.0, -1.0);
  if (h == 3) return vec2(-1.0, -1.0);
  if (h == 4) return vec2(1.0, 0.0);
  if (h == 5) return vec2(-1.0, 0.0);
  if (h == 6) return vec2(0.0, 1.0);
  return vec2(0.0, -1.0);
}
// 2D simplex returning (value, d/dx, d/dy); matches core/noise.ts Simplex2.noise().
vec3 tSimplexD(vec2 v) {
  const float F2 = 0.36602540378;
  const float G2 = 0.2113248654;
  float s = (v.x + v.y) * F2;
  float fi = floor(v.x + s), fj = floor(v.y + s);
  float t = (fi + fj) * G2;
  vec2 d0 = v - vec2(fi - t, fj - t);
  vec2 o1 = d0.x > d0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 d1 = d0 - o1 + G2;
  vec2 d2 = d0 - 1.0 + 2.0 * G2;
  int ii = int(fi) & 255, jj = int(fj) & 255;
  int i1 = int(o1.x), j1 = int(o1.y);
  vec2 g0 = tGrad(tPerm(ii + tPerm(jj)));
  vec2 g1 = tGrad(tPerm(ii + i1 + tPerm(jj + j1)));
  vec2 g2 = tGrad(tPerm(ii + 1 + tPerm(jj + 1)));
  vec3 r = vec3(0.0);
  float t0 = 0.5 - dot(d0, d0);
  if (t0 > 0.0) { float gd = dot(g0, d0); float t2 = t0 * t0; r += vec3(t2 * t2 * gd, t2 * t2 * g0 - 8.0 * t2 * t0 * gd * d0); }
  float t1 = 0.5 - dot(d1, d1);
  if (t1 > 0.0) { float gd = dot(g1, d1); float t2 = t1 * t1; r += vec3(t2 * t2 * gd, t2 * t2 * g1 - 8.0 * t2 * t1 * gd * d1); }
  float t3 = 0.5 - dot(d2, d2);
  if (t3 > 0.0) { float gd = dot(g2, d2); float t2 = t3 * t3; r += vec3(t2 * t2 * gd, t2 * t2 * g2 - 8.0 * t2 * t3 * gd * d2); }
  return 70.0 * r;
}
// Terrain.detail(): returns height offset, writes its gradient (d/dx, d/dz) scaled by gradFade.
float tDetail(vec2 xz, vec2 gradFade, out vec2 grad) {
  grad = vec2(0.0);
  float lake = tLake(xz);
  if (lake >= 0.999) return 0.0;
  vec3 a = tSimplexD(xz * 0.045);
  vec3 b = tSimplexD(xz * 0.13 + vec2(7.1, -3.3));
  float k = 1.0 - lake;
  grad = (a.yz * (0.55 * 0.045) * gradFade.x + b.yz * (0.2 * 0.13) * gradFade.y) * k;
  return (0.55 * a.x + 0.2 * b.x) * k;
}
float tHeightAt(vec2 xz, vec2 gradFade, out vec2 detailGrad) {
  return tBaseHeight(xz) + tDetail(xz, gradFade, detailGrad);
}
`;
