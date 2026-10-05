// Optional WebGL2 CRT post-pass over the 2D phosphor canvas: barrel distortion, scanlines,
// cheap single-pass bloom, film grain and ≤2% flicker. Returns null when WebGL2 is unavailable,
// in which case the page falls back to the CSS scanline + vignette overlay.

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_res;     // backing pixels
uniform float u_dpr;
uniform float u_time;   // ms
uniform float u_anim;   // 1 = grain + flicker, 0 = static (reduced motion)
in vec2 v_uv;
out vec4 o;

vec2 barrel(vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  float r2 = dot(c, c);
  c *= 1.0 + 0.035 * r2 + 0.018 * r2 * r2;
  return c * 0.5 + 0.5;
}

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  // Only the tube gets the CRT treatment; the square canvas corners pass through untouched so
  // the canvas edge disappears into the page background.
  vec3 flat_ = texture(u_tex, v_uv).rgb;
  float tube = 1.0 - smoothstep(0.955, 0.985, length(v_uv - 0.5) * 2.0);
  if (tube <= 0.0) {
    o = vec4(flat_, 1.0);
    return;
  }
  vec2 uv = clamp(barrel(v_uv), 0.0, 1.0);
  vec3 col = texture(u_tex, uv).rgb;

  // Bloom: 16 taps on a golden-angle spiral, keeping only what's brighter than the graticule.
  vec3 bloom = vec3(0.0);
  vec2 px = 1.0 / u_res;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float a = fi * 2.39996;
    float r = sqrt(fi + 0.5) * 2.4 * u_dpr;
    vec3 s = texture(u_tex, uv + vec2(cos(a), sin(a)) * r * px).rgb;
    bloom += max(s - 0.22, 0.0);
  }
  col += bloom / 16.0 * vec3(0.55, 1.0, 0.5) * 1.6;

  // Faint horizontal convergence error: the red gun sits a hair off.
  col.r = mix(col.r, texture(u_tex, uv + vec2(0.6 * u_dpr * px.x, 0.0)).r, 0.5);

  // Scanlines every 3 CSS px.
  float y = gl_FragCoord.y / u_dpr;
  col *= 0.86 + 0.14 * (0.5 + 0.5 * cos(y * 6.2831853 / 3.0));

  // Grain and flicker (flicker capped at 2% brightness).
  float g = hash(gl_FragCoord.xy + floor(u_time / 41.0) * 7.31) - 0.5;
  col += g * 0.03 * u_anim;
  float fl = 1.0 - 0.02 * u_anim * hash(vec2(floor(u_time / 33.0), 3.7));
  col *= fl;

  // Vignette towards the tube edge.
  vec2 c = v_uv * 2.0 - 1.0;
  col *= 1.0 - 0.18 * dot(c, c);

  o = vec4(mix(flat_, col, tube), 1.0);
}`

export type Crt = {
  render(now: number, animating: boolean): void
  destroy(): void
}

export function createCrt(target: HTMLCanvasElement, source: HTMLCanvasElement): Crt | null {
  let gl = target.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, powerPreference: 'low-power' })
  if (!gl) return null

  let compile = (type: number, src: string) => {
    let sh = gl.createShader(type)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      let log = gl.getShaderInfoLog(sh)
      gl.deleteShader(sh)
      throw new Error(`CRT shader: ${log}`)
    }
    return sh
  }

  let program: WebGLProgram
  try {
    program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
  } catch (error) {
    console.warn('CRT post-pass disabled:', error)
    return null
  }

  let vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  let buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  let loc = gl.getAttribLocation(program, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  let tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

  gl.useProgram(program)
  let uRes = gl.getUniformLocation(program, 'u_res')
  let uDpr = gl.getUniformLocation(program, 'u_dpr')
  let uTime = gl.getUniformLocation(program, 'u_time')
  let uAnim = gl.getUniformLocation(program, 'u_anim')
  gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0)

  let lost = false
  let onLost = (e: Event) => {
    e.preventDefault()
    lost = true
  }
  target.addEventListener('webglcontextlost', onLost)

  return {
    render(now, animating) {
      if (lost || !source.width) return
      if (target.width !== source.width || target.height !== source.height) {
        target.width = source.width
        target.height = source.height
      }
      gl.viewport(0, 0, target.width, target.height)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.uniform2f(uRes, target.width, target.height)
      gl.uniform1f(uDpr, Math.max(1, target.width / Math.max(1, target.clientWidth)))
      gl.uniform1f(uTime, now)
      gl.uniform1f(uAnim, animating ? 1 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    destroy() {
      target.removeEventListener('webglcontextlost', onLost)
      gl.deleteTexture(tex)
      gl.deleteBuffer(buf)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
