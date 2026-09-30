import * as THREE from 'three'
import './styles/main.css'

type Axis = 'a' | 'b' | 'c' | 'd'
type V4 = [number, number, number, number]
type Projection = { title: string; keep: [number, number, number]; hidden: number }
type Obstacle = { min: V4; max: V4; id: number }

type Level = { start: V4; target: V4; player: V4; checkpoint: V4; gateAxis: number; gateMin: number; gateMax: number; obstacles: Obstacle[]; route: V4[] }

const AXES: Axis[] = ['a', 'b', 'c', 'd']
const AXIS_COLORS = [0xff8066, 0x59e3d3, 0x8e9dff, 0xf6c75f]
const PROJECTIONS: Projection[] = [
  { title: '视图 1 · ABC', keep: [0, 1, 2], hidden: 3 },
  { title: '视图 2 · ABD', keep: [0, 1, 3], hidden: 2 },
  { title: '视图 3 · ACD', keep: [0, 2, 3], hidden: 1 },
  { title: '视图 4 · BCD', keep: [1, 2, 3], hidden: 0 },
]
const MOVE_SPEED = 3.1
const GOAL_RADIUS = 0.48
const CHECK_RADIUS = 0.55
const STEP = 1 / 60

const add = (v: V4, axis: number, amount: number): V4 => { const r = [...v] as V4; r[axis] += amount; return r }
const distance4 = (a: V4, b: V4) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3])
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const fmt = (n: number) => n.toFixed(2)
const lerp4 = (a: V4, b: V4, t: number): V4 => [0, 1, 2, 3].map(i => a[i] + (b[i] - a[i]) * t) as V4

function seededRandom(seed = Math.floor(Math.random() * 0xffffffff)) {
  let t = seed >>> 0
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ t >>> 15, 1 | t); r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296 }
}

function insideObstacle(p: V4, o: Obstacle, padding = 0) { return p.every((n, i) => n > o.min[i] - padding && n < o.max[i] + padding) }
function routePoints(start: V4, target: V4, order: number[]): V4[] {
  const points: V4[] = [start]
  let current = [...start] as V4
  for (const axis of order) { current = [...current] as V4; current[axis] = target[axis]; points.push(current) }
  return points
}
function routeClear(route: V4[], o: Obstacle) {
  for (let s = 0; s < route.length - 1; s++) {
    const a = route[s], b = route[s + 1]
    const steps = Math.ceil(distance4(a, b) / 0.25)
    for (let i = 0; i <= steps; i++) if (insideObstacle(lerp4(a, b, i / steps), o, 0.42)) return false
  }
  return true
}
function randomLevel(): Level {
  const rand = seededRandom()
  const point = (): V4 => [0, 1, 2, 3].map(() => Math.round((rand() * 2 - 1) * 6)) as V4
  let start = point(), target = point()
  while (distance4(start, target) < 8) target = point()
  const order = [...AXES.keys()].sort(() => rand() - 0.5)
  const route = routePoints(start, target, order)
  const gateAxis = order[1]
  const checkpoint = route[Math.min(2, route.length - 1)]
  const obstacles: Obstacle[] = []
  let attempts = 0
  while (obstacles.length < 10 && attempts++ < 300) {
    const center = point()
    const size = [1 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 2)]
    const o: Obstacle = { id: obstacles.length, min: center.map((n, i) => clamp(n - size[i] * 0.5, -8, 7)) as V4, max: center.map((n, i) => clamp(n + size[i] * 0.5, -7, 8)) as V4 }
    if (o.max.some((n, i) => n - o.min[i] < 0.9) || !routeClear(route, o) || insideObstacle(start, o, 0.5) || insideObstacle(target, o, 0.5)) continue
    obstacles.push(o)
  }
  return { start, target, player: [...start], checkpoint, gateAxis, gateMin: Math.min(start[gateAxis], target[gateAxis]) - 0.8, gateMax: Math.max(start[gateAxis], target[gateAxis]) + 0.8, obstacles, route }
}

class Viewport {
  readonly root = new THREE.Group()
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100)
  readonly renderer: THREE.WebGLRenderer
  private yaw = 0.68
  private pitch = 0.54
  private distance = 18
  private pan = new THREE.Vector3()
  private dragging = false
  private panning = false
  private last = new THREE.Vector2()
  private readonly points = new Map<string, THREE.Points>()
  private readonly labels = new Map<string, HTMLDivElement>()
  private readonly projection: Projection
  private readonly canvas: HTMLCanvasElement

  constructor(host: HTMLElement, projection: Projection, onExpand: () => void) {
    this.projection = projection
    this.canvas = document.createElement('canvas')
    host.appendChild(this.canvas)
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setClearColor(0x070b14, 1)
    this.scene.add(this.root)
    this.camera.up.set(0, 1, 0)
    this.buildGrid()
    this.canvas.addEventListener('pointerdown', e => { this.last.set(e.clientX, e.clientY); this.dragging = e.button === 0; this.panning = e.button === 2; this.canvas.setPointerCapture(e.pointerId) })
    this.canvas.addEventListener('pointermove', e => { if (!this.dragging && !this.panning) return; const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y; this.last.set(e.clientX, e.clientY); if (this.dragging) { this.yaw += dx * 0.008; this.pitch = clamp(this.pitch + dy * 0.008, -1.35, 1.35) } else { this.pan.x += dx * 0.012; this.pan.y -= dy * 0.012 } })
    this.canvas.addEventListener('pointerup', e => { this.dragging = false; this.panning = false; this.canvas.releasePointerCapture(e.pointerId) })
    this.canvas.addEventListener('wheel', e => { e.preventDefault(); this.distance = clamp(this.distance + e.deltaY * 0.015, 8, 34) }, { passive: false })
    this.canvas.addEventListener('contextmenu', e => e.preventDefault())
    this.canvas.addEventListener('click', onExpand)
  }
  setExpanded(value: boolean) { this.canvas.parentElement?.classList.toggle('is-expanded', value) }
  private buildGrid() {
    const grid = new THREE.GridHelper(18, 18, 0x203149, 0x132235)
    grid.rotation.x = Math.PI / 2
    this.root.add(grid)
    for (let axis = 0; axis < 3; axis++) {
      const material = new THREE.LineBasicMaterial({ color: AXIS_COLORS[this.projection.keep[axis]], transparent: true, opacity: 0.75 })
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-9, 0, 0), new THREE.Vector3(9, 0, 0)])
      const line = new THREE.Line(geo, material)
      if (axis === 1) line.rotation.y = Math.PI / 2
      if (axis === 2) line.rotation.x = Math.PI / 2
      this.root.add(line)
    }
  }
  private pos(p: V4) { return new THREE.Vector3(p[this.projection.keep[0]], p[this.projection.keep[1]], p[this.projection.keep[2]]) }
  private point(name: string, color: number, size: number) { const mat = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, transparent: true, opacity: 0.98 }); const geo = new THREE.BufferGeometry(); const points = new THREE.Points(geo, mat); this.points.set(name, points); this.root.add(points); return points }
  private label(name: string, text: string, color: string) { let el = this.labels.get(name); if (!el) { el = document.createElement('div'); el.className = 'world-label'; this.canvas.parentElement?.appendChild(el); this.labels.set(name, el) } el.textContent = text; el.style.color = color; return el }
  sync(level: Level, trail: V4[], checkpointReached: boolean, crashed: boolean) {
    const entities: [string, V4, number, number, string][] = [['start', level.start, 0x63a8ff, 8, 'S 起点'], ['target', level.target, 0xff6f77, 9, 'T 终点'], ['player', level.player, 0xffffff, 12, 'P 你'], ['checkpoint', level.checkpoint, checkpointReached ? 0x59e3d3 : 0x6cae9d, 7, 'C 检查点']]
    for (const [name, p, color, size, text] of entities) { const obj = this.points.get(name) ?? this.point(name, color, size); obj.position.copy(this.pos(p)); obj.geometry.setFromPoints([new THREE.Vector3(0, 0, 0)]); const hidden = `${AXES[this.projection.hidden]}=${fmt(p[this.projection.hidden])}`; this.label(name, `${text} · ${hidden}`, name === 'player' ? '#ffffff' : '#a7b9cd') }
    let trace = this.points.get('trail'); if (!trace) { trace = this.point('trail', 0x72e6df, 4); (trace.material as THREE.PointsMaterial).opacity = 0.35 }
    trace.geometry.setFromPoints(trail.map(p => this.pos(p)))
    for (const o of level.obstacles) { const key = `obstacle-${o.id}`; let mesh = this.root.getObjectByName(key) as THREE.LineSegments | undefined; if (!mesh) { const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)); mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xb462b4, transparent: true, opacity: 0.5 })); mesh.name = key; this.root.add(mesh) } const k = this.projection.keep; mesh.position.set((o.min[k[0]] + o.max[k[0]]) / 2, (o.min[k[1]] + o.max[k[1]]) / 2, (o.min[k[2]] + o.max[k[2]]) / 2); mesh.scale.set(o.max[k[0]] - o.min[k[0]], o.max[k[1]] - o.min[k[1]], o.max[k[2]] - o.min[k[2]]); const visible = level.player[this.projection.hidden] >= o.min[this.projection.hidden] - 1.5 && level.player[this.projection.hidden] <= o.max[this.projection.hidden] + 1.5; (mesh.material as THREE.LineBasicMaterial).opacity = visible ? (crashed ? 0.9 : 0.62) : 0.12 }
  }
  render() { const rect = this.canvas.getBoundingClientRect(); const w = Math.max(1, rect.width), h = Math.max(1, rect.height); this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); const target = this.pan; this.camera.position.set(target.x + Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance, target.y + Math.sin(this.pitch) * this.distance, target.z + Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance); this.camera.lookAt(target); this.renderer.render(this.scene, this.camera); for (const [name, el] of this.labels) { const obj = this.points.get(name); if (!obj) continue; const p = obj.position.clone(); p.project(this.camera); const x = (p.x * 0.5 + 0.5) * w, y = (-p.y * 0.5 + 0.5) * h; el.style.transform = `translate(${x}px,${y}px)`; el.style.display = p.z < 1 ? 'block' : 'none' } }
}

class App {
  private level = randomLevel()
  private readonly views: Viewport[] = []
  private readonly keys = new Set<string>()
  private trail: V4[] = []
  private trailVisible = true
  private checkpointReached = false
  private crashed = false
  private won = false
  private expanded = -1
  private lastSafe: V4 = [...this.level.start]
  private readonly root: HTMLElement
  private coordEl!: HTMLElement
  private distanceEl!: HTMLElement
  private statusEl!: HTMLElement
  private gateEl!: HTMLElement
  private seedEl!: HTMLElement
  private hintEl!: HTMLElement
  constructor() { this.root = document.querySelector('#app')!; this.renderShell(); this.bind(); this.newGame(); requestAnimationFrame(this.frame) }
  private renderShell() {
    this.root.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-mark">✦</span><div><strong>QUADPOINT <i>4D</i></strong><small>随机空间导航实验台</small></div></div><div class="run-state"><span class="live-dot"></span><span id="status">准备生成</span><span class="divider"></span><span id="seed">RUN —</span></div><div class="actions"><button id="new-game" class="primary">↻ 新局</button><button id="layout-btn">▦ 四视图</button><button id="trail-btn">⌁ 轨迹</button></div></header><main><aside class="hud"><section class="hud-block"><div class="eyebrow">PLAYER POINT / P</div><div id="coords" class="coords">(0.00, 0.00, 0.00, 0.00)</div><div class="axis-legend"><span><b class="a">a</b> W / S</span><span><b class="b">b</b> A / D</span><span><b class="c">c</b> Q / E</span><span><b class="d">d</b> R / F</span></div></section><section class="hud-block metric"><div><span>四维距离 / DISTANCE</span><strong id="distance">0.00</strong></div><div><span>移动点数 / TRAIL</span><strong id="trail-count">0</strong></div></section><section class="hud-block"><div class="eyebrow">MISSION GATES</div><div id="gate" class="gate">门禁检查中</div><div class="checkpoint"><span class="checkpoint-dot"></span><span>检查点 C</span><em id="checkpoint">未经过</em></div></section><section class="hud-block rules"><div class="eyebrow">操作提示</div><p>拖拽旋转 · 右键平移<br>滚轮缩放 · 双击视图放大</p><p class="muted">本局结束后不保存任何状态。点击“新局”即可重新随机生成。</p></section><div id="hint" class="hint">沿安全路径寻找检查点，再让四维坐标接近 T。</div></aside><section class="stage"><div id="views" class="views"></div><div class="stage-footer"><span><b class="axis-chip a-bg">a</b> 橙红</span><span><b class="axis-chip b-bg">b</b> 青绿</span><span><b class="axis-chip c-bg">c</b> 靛蓝</span><span><b class="axis-chip d-bg">d</b> 金黄</span><span class="legend-key obstacle-key"></span>4D 障碍切片</div></section></main><footer class="footer"><span>每局随机生成 · 保证存在可通行路径</span><span>QuadPoint 4D / build 01</span></footer>`
    this.coordEl = document.querySelector('#coords')!; this.distanceEl = document.querySelector('#distance')!; this.statusEl = document.querySelector('#status')!; this.gateEl = document.querySelector('#gate')!; this.seedEl = document.querySelector('#seed')!; this.hintEl = document.querySelector('#hint')!
    const views = document.querySelector('#views')!
    PROJECTIONS.forEach((projection, i) => { const panel = document.createElement('article'); panel.className = 'view-panel'; panel.innerHTML = `<div class="view-head"><span>${projection.title}</span><small>隐藏 ${AXES[projection.hidden]}</small></div><div class="view-canvas"></div>`; views.appendChild(panel); const viewport = new Viewport(panel.querySelector('.view-canvas')!, projection, () => this.expand(i)); this.views.push(viewport) })
  }
  private bind() { document.querySelector('#trail-btn')!.addEventListener('click', () => { this.trailVisible = !this.trailVisible; document.querySelector('#trail-btn')!.textContent = this.trailVisible ? '⌁ 轨迹' : '⌁ 隐藏轨迹' }); window.addEventListener('keydown', e => { if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF'].includes(e.code)) { e.preventDefault(); this.keys.add(e.code) } if (e.code === 'Escape') this.expand(-1) }); window.addEventListener('keyup', e => this.keys.delete(e.code)); document.querySelector('#new-game')!.addEventListener('click', () => this.newGame()); document.querySelector('#layout-btn')!.addEventListener('click', () => this.expand(this.expanded >= 0 ? -1 : 0)); }
  private expand(index: number) { this.expanded = index; document.querySelector('#views')!.classList.toggle('single-view', index >= 0); this.views.forEach((v, i) => v.setExpanded(i === index)) }
  private newGame() { this.level = randomLevel(); this.trail = [[...this.level.start]]; this.lastSafe = [...this.level.start]; this.checkpointReached = false; this.crashed = false; this.won = false; this.statusEl.textContent = '探索中'; this.seedEl.textContent = `RUN ${Math.random().toString(36).slice(2, 8).toUpperCase()}`; this.hintEl.textContent = `门禁轴 ${AXES[this.level.gateAxis]} ∈ [${fmt(this.level.gateMin)}, ${fmt(this.level.gateMax)}] · 先找到青绿色检查点`; }
  private move(dt: number) { if (this.won) return; const dir: V4 = [0, 0, 0, 0]; const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); const speed = MOVE_SPEED * (fast ? 1.8 : 1); if (this.keys.has('KeyW')) dir[0] += 1; if (this.keys.has('KeyS')) dir[0] -= 1; if (this.keys.has('KeyD')) dir[1] += 1; if (this.keys.has('KeyA')) dir[1] -= 1; if (this.keys.has('KeyE')) dir[2] += 1; if (this.keys.has('KeyQ')) dir[2] -= 1; if (this.keys.has('KeyR')) dir[3] += 1; if (this.keys.has('KeyF')) dir[3] -= 1; const mag = Math.hypot(...dir); if (!mag) return; const candidate = dir.map(n => n / mag * speed * dt) as V4; let next = [0, 1, 2, 3].reduce((p, i) => add(p, i, candidate[i]), [...this.level.player] as V4); next = next.map(n => clamp(n, -8, 8)) as V4; if (this.level.obstacles.some(o => insideObstacle(next, o))) { this.crashed = true; this.level.player = [...this.lastSafe]; this.statusEl.textContent = '撞入障碍 · 已退回安全点'; this.hintEl.textContent = '点落入了 4D 障碍区域。换一个隐藏轴切片继续寻找路径。'; return } this.crashed = false; this.level.player = next; this.lastSafe = [...next]; if (distance4(next, this.level.checkpoint) < CHECK_RADIUS) { this.checkpointReached = true; this.hintEl.textContent = '检查点已激活。现在寻找终点 T。' } if (this.checkpointReached && next[this.level.gateAxis] >= this.level.gateMin && next[this.level.gateAxis] <= this.level.gateMax && distance4(next, this.level.target) < GOAL_RADIUS) { this.won = true; this.statusEl.textContent = '已抵达终点'; this.hintEl.textContent = '送点完成。点击“新局”生成完全不同的四维世界。' } if (distance4(next, this.lastSafe) > 0.02) this.trail.push([...next]); }
  private frame = () => { this.move(STEP); const d = distance4(this.level.player, this.level.target); this.coordEl.textContent = `(${this.level.player.map(fmt).join(', ')})`; this.distanceEl.textContent = d.toFixed(2); document.querySelector('#trail-count')!.textContent = String(this.trail.length); document.querySelector('#checkpoint')!.textContent = this.checkpointReached ? '已激活' : '未经过'; this.gateEl.textContent = `${AXES[this.level.gateAxis]} ∈ [${fmt(this.level.gateMin)}, ${fmt(this.level.gateMax)}]`; this.gateEl.className = `gate ${this.checkpointReached ? 'open' : ''}`; this.views.forEach(v => { v.sync(this.level, this.trailVisible ? this.trail : [], this.checkpointReached, this.crashed); v.render() }); requestAnimationFrame(this.frame) }
}

new App()
