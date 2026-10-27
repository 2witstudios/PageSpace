// The liquid-metal shader (docs/imago/liquid-metal-engine.md), as confirmed in
// prototypes/imago-liquid-metal: one orb ray-marched in a single fragment pass. Its face reflects
// a designed field of chrome bands bent by the folds; the page only tints the outer edge.

export const METAL_VERTEX_SHADER = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

export const METAL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform vec2 uRes;       // view size in device px
uniform vec4 uRect;      // view rect in CSS px within the viewport
uniform vec2 uViewport;  // viewport CSS px
uniform float uScale;    // CSS px per world unit (view spans -1..1)
uniform sampler2D uWorld;
uniform vec4 uBalls[6];
uniform int uCount;
uniform float uK, uChurn, uPulse, uRough, uDim, uSquash, uTime, uShadow, uKeyGain, uWobble, uPageGain, uReflect;
uniform vec3 uKeyDir, uRoom, uSky, uFlag, uRim, uKey, uFloor, uWarm;

float smin(float a, float b, float k){ float h = max(k-abs(a-b),0.)/k; return min(a,b) - h*h*k*.25; }
float sdf(vec3 p){
  p.z /= uSquash;
  float t = uTime;
  // The orb: a sphere whose surface carries slow low-order modes, like a drop of mercury settling.
  vec3 q = p - uBalls[0].xyz;
  float r = length(q) + 1e-4;
  // Smooth polynomial surface modes (no angles, so no pinch at the pole facing the viewer),
  // each rotating slowly so the surface swells and settles rather than spinning.
  vec3 u = q / r;
  float c2 = cos(t*.7), s2 = sin(t*.7), c3 = cos(t*-.45+1.3), s3 = sin(t*-.45+1.3);
  float m2 = (u.x*u.x - u.y*u.y)*c2 + 2.*u.x*u.y*s2;
  float m3 = (u.x*u.x*u.x - 3.*u.x*u.y*u.y)*c3 + (3.*u.x*u.x*u.y - u.y*u.y*u.y)*s3;
  float mz = u.z*u.x*sin(t*.9) + u.z*u.y*cos(t*.6);
  float modes = m2*.7 + m3*.6 + mz*.5;
  float d = r - uBalls[0].w - uWobble*modes;
  // Bulges: droplets inside the orb that push its surface out as they travel.
  for(int i=1;i<6;i++){ if(i>=uCount) break; d = smin(d, length(p-uBalls[i].xyz)-uBalls[i].w, uK); }
  // Folds: fine creases from domain-warped waves. They barely move the silhouette but bend the
  // reflections hard, which is most of what reads as liquid metal rather than a polished ball.
  vec3 w = q*3.1 + vec3(t*.23, -t*.19, t*.15);
  w += .42*sin(w.yzx*1.7 + vec3(t*.31, t*.27, -t*.22));
  w += .21*sin(w.zxy*3.3 - t*.4);
  d -= (.015 + uChurn*.18) * sin(w.x*2.1)*sin(w.y*1.9 + 1.)*sin(w.z*2.3 + 2.);
  float rp = length(p.xy-uBalls[0].xy);
  d += uPulse*.03*sin(rp*16.-t*10.)*exp(-rp*2.);
  return d*min(1.,uSquash);
}
vec3 nrm(vec3 p){
  const vec2 e = vec2(1.,-1.)*.0015;
  return normalize(e.xyy*sdf(p+e.xyy)+e.yyx*sdf(p+e.yyx)+e.yxy*sdf(p+e.yxy)+e.xxx*sdf(p+e.xxx));
}
vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }

// The viewer's hemisphere: a chrome studio, since a screen cannot see who is in front of it.
// A sharp horizon crosses the face (bright sky over dark, warm ground), with softbox strips and
// a key light that follows the pointer. High contrast with few midtones is what makes it chrome.
float box(vec3 R, vec3 dir, vec2 size, float soft){
  vec3 kd = normalize(dir);
  float f = dot(R, kd);
  if(f <= 0.) return 0.;
  vec3 kx = normalize(cross(vec3(0.,1.,0.), kd));
  vec3 ky = cross(kd, kx);
  vec2 kp = vec2(dot(R,kx), dot(R,ky))/f;
  vec2 e = abs(kp) - size;
  float sd = length(max(e, 0.)) + min(max(e.x, e.y), 0.);
  return 1. - smoothstep(-soft, soft, sd);
}
// The orb's own reflection. The app is mostly flat panes, so a true mirror would mostly reflect
// light and nothing else. Like Paper's LiquidMetal, the environment is a designed field of light
// and dark bands that flows slowly; the folds bend it, and each colour channel sits a little out
// of phase, which leaves thin colour fringes where bands meet.
float band(float x, float soft){
  float broad = smoothstep(0., .2, x) * (1. - smoothstep(.42, .42 + soft, x));
  float line = exp(-pow((x - .63)/.028, 2.));
  return broad + line*.75;
}
vec3 studio(vec3 R, float rough){
  float soft = .025 + rough*.3;
  float u = dot(R, normalize(vec3(.35, 1., .3)));
  u += .1*sin(R.x*3.1 + uTime*.37) + .06*sin(R.z*4.3 - uTime*.29);
  float flow = uTime*.045;
  vec3 v = fract(vec3(u + .02, u, u - .02)*1.35 - flow);
  vec3 b = vec3(band(v.r, soft), band(v.g, soft), band(v.b, soft));
  vec3 c = mix(uRoom*.45, uSky, b);
  // Copper in the dip just after each bright band: the warmth of the reference recesses.
  float dip = exp(-pow((v.g - .5)/.05, 2.));
  c += uWarm * dip * .35;
  // Light still matters: the key follows the pointer, and a tall strip catches one edge.
  c += uKey * uKeyGain * box(R, uKeyDir, vec2(.2, .14), soft*.6);
  c += uKey * uKeyGain*.6 * box(R, vec3(-.85, .3, .4), vec2(.05, .55), soft*.6);
  // The flag: a dark card at grazing, so the silhouette keeps an edge on any page.
  float flag = 1. - smoothstep(.06, .3, R.z);
  return mix(c, uFlag, flag*.55);
}
// The page plane: reflect into z=0 and read the proxy world there.
vec3 world(vec3 P, vec3 R, float rough){
  float t = P.z / max(-R.z, 1e-3);
  vec2 q = P.xy + R.xy*t;
  vec2 css = uRect.xy + uRect.zw*.5 + vec2(q.x, -q.y)*uScale;
  vec2 uv = css/uViewport;
  float lod = log2(1. + t*1.6)*.8 + rough*5.;
  vec3 c = lin(textureLod(uWorld, clamp(uv, vec2(.001), vec2(.999)), lod).rgb);
  float outside = max(max(-uv.x, uv.x-1.), max(-uv.y, uv.y-1.));
  c = mix(c, uFloor, smoothstep(0., .08, outside));
  // The page right under the blob sits in its own occlusion, so contact reflections go dark.
  // This is what keeps a mirror visible on a page of one flat colour.
  float occl = smoothstep(-.02, .42, sdf(vec3(q, .02)));
  c *= mix(.18, 1., occl) * uPageGain;
  // The page is finite: grazing rays run past it into the studio's rim light, which draws the
  // silhouette. Dark on a light page, a bright strip on a dark one.
  return mix(c, uRim, smoothstep(2.2, 4., t)*.9);
}

vec4 shade(vec3 P){
  vec3 n = nrm(P);
  vec3 V = vec3(0.,0.,-1.);
  vec3 R = reflect(V, n);
  // A slight satin finish: reflections soften, so the metal has a body instead of reading as clear.
  float rough = max(uRough, .1);
  // The page only tints the outer edge; the metal never turns into a window onto it.
  float wPlane = (1. - smoothstep(-.55, -.3, R.z)) * .3;
  vec3 env = mix(studio(R, rough), world(P, R, rough), wPlane);
  // Dispersion: a slight spread of red and blue toward the edges, the fringe chrome photographs carry.
  float disp = .07*(1. - clamp(n.z, 0., 1.));
  vec3 Rr = reflect(V, normalize(n + vec3(n.xy, 0.)*disp));
  vec3 Rb = reflect(V, normalize(n - vec3(n.xy, 0.)*disp));
  float wr = (1. - smoothstep(-.55, -.3, Rr.z))*.3, wb = (1. - smoothstep(-.55, -.3, Rb.z))*.3;
  env.r = mix(studio(Rr, rough), world(P, Rr, rough), wr).r;
  env.b = mix(studio(Rb, rough), world(P, Rb, rough), wb).b;
  // Polished steel, not a silver mirror: about 60% reflectance head-on, rising toward white at the
  // edges (Schlick). The darker body and bright rim are what read as solid metal.
  float cosT = clamp(n.z, 0., 1.);
  // Reflectance is a theme token: on a white page the metal needs more of it to read as silver.
  vec3 F0 = vec3(1., 1., 1.03) * uReflect;
  vec3 F = F0 + (1.-F0)*pow(1.-cosT, 5.);
  float ao = clamp(sdf(P+n*.09)/.09, 0., 1.);
  vec3 col = env*F*mix(.55, 1., ao);
  col *= 1. - uDim*.55;
  return vec4(col, 1.);
}

void main(){
  vec2 p = (vUv*2.-1.);
  vec3 ro = vec3(p, 1.6);
  float t = 0., minD = 1e5; vec3 pMin = ro; bool hit = false;
  for(int i=0;i<110;i++){
    vec3 q = ro + vec3(0.,0.,-1.)*t;
    float d = sdf(q);
    if(d < minD){ minD = d; pMin = q; }
    if(d < .0008){ hit = true; break; }
    t += d*.75;
    if(t > 1.6) break;
  }
  float pxw = 2.6/uRes.x;
  vec4 col = vec4(0.);
  if(hit){ col = shade(pMin); }
  else if(minD < pxw){
    float a = 1. - smoothstep(0., pxw, minD);
    col = vec4(shade(pMin).rgb, a);
  }
  // Contact shadow on the page: light mode only, as the house elevation goes flat in dark.
  float sh = uShadow * (1.-smoothstep(-.02, .3, sdf(vec3(p+vec2(0.,.05), .02))));
  // Filmic curve: deep blacks and rolled-off highlights, so the metal keeps its contrast.
  vec3 x = col.rgb;
  vec3 c = pow(clamp((x*(2.51*x + .03))/(x*(2.43*x + .59) + .14), 0., 1.), vec3(1./2.2));
  float a = col.a + sh*(1.-col.a);
  o = vec4(c*col.a, a);
}`;

/** The uniforms the engine sets, in one place so the program and the renderer agree. */
export const METAL_UNIFORMS = [
  'uRes', 'uRect', 'uViewport', 'uScale', 'uWorld', 'uBalls', 'uCount', 'uK', 'uChurn', 'uPulse', 'uRough', 'uDim',
  'uSquash', 'uTime', 'uShadow', 'uKeyGain', 'uWobble', 'uPageGain', 'uReflect', 'uKeyDir', 'uRoom', 'uSky', 'uFlag',
  'uRim', 'uKey', 'uFloor', 'uWarm',
] as const;

export type MetalUniform = (typeof METAL_UNIFORMS)[number];
