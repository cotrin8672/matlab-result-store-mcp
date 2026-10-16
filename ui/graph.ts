export type GraphNode = {
  id: string;
  scheme: string;
  row_id: string;
  keys: Record<string, unknown>;
  key_labels: Record<string, string>;
  initial_ref: { scheme: string; row_id: string } | null;
  matched: boolean;
};
export type GraphEdge = { source: string; target: string; matched: boolean };
export type GraphData = { nodes: GraphNode[]; edges: GraphEdge[]; total: number; truncated: boolean };
type Point = { x: number; y: number };
type NodeView = { data: GraphNode; dot: SVGCircleElement };
type EdgeView = { data: GraphEdge; group: SVGGElement };
const namespace = 'http://www.w3.org/2000/svg';
const edgeID = (edge: GraphEdge) => JSON.stringify([edge.source, edge.target]);
let nextGraphID = 0;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(namespace, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}
function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  result = Math.imul(result ^ result >>> 16, 0x85ebca6b); result = Math.imul(result ^ result >>> 13, 0xc2b2ae35);
  result ^= result >>> 16;
  return result >>> 0;
}

// A seeded spanning forest keeps neighboring results close. Local grid repulsion
// is bounded to 12 samples per cell, so even coincident nodes cannot make it quadratic.
function layout(graph: GraphData): Map<string, Point> {
  const count = graph.nodes.length, indices = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const neighbors = Array.from({ length: count }, () => [] as number[]), incoming = new Uint32Array(count);
  const edges: [number, number][] = [];
  for (const edge of graph.edges) {
    const source = indices.get(edge.source), target = indices.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    neighbors[source].push(target); neighbors[target].push(source); incoming[target]++; edges.push([source, target]);
  }
  const x = new Float64Array(count), y = new Float64Array(count), angles = new Float64Array(count);
  const visited = new Uint8Array(count), depth = new Uint32Array(count), component = new Uint32Array(count), components: number[][] = [];
  const roots = [...graph.nodes.keys()].sort((a, b) => Number(incoming[a] > 0) - Number(incoming[b] > 0));
  for (const root of roots) {
    if (visited[root]) continue;
    const nodes = [root], group = components.length; components.push(nodes); visited[root] = 1;
    angles[root] = hash(graph.nodes[root].id) / 4294967296 * Math.PI * 2;
    for (let cursor = 0; cursor < nodes.length; cursor++) {
      const parent = nodes[cursor]; component[parent] = group;
      const children = neighbors[parent].filter(index => !visited[index]);
      children.forEach((child, i) => {
        if (visited[child]) return;
        visited[child] = 1; nodes.push(child);
        const spread = parent === root ? Math.PI * 2 : Math.min(Math.PI * 1.3, children.length * .8);
        depth[child] = depth[parent] + 1;
        const bend = depth[child] <= 64 ? (hash(graph.nodes[child].id) / 4294967296 - .5) * .18 : .65 / Math.sqrt(depth[child] - 63);
        const angle = angles[parent] + (children.length > 6 ? i * 2.399963 : children.length > 1 ? spread * ((i + .5) / children.length - .5) : bend);
        const length = children.length > 6 ? 36 + 14 * Math.sqrt(i + .5) : 36;
        angles[child] = angle; x[child] = x[parent] + Math.cos(angle) * length; y[child] = y[parent] + Math.sin(angle) * length;
      });
    }
  }
  const vx = new Float64Array(count), vy = new Float64Array(count), fx = new Float64Array(count), fy = new Float64Array(count);
  const steps = count > 2000 ? 32 : 64, cellSize = 44;
  for (let step = 0; step < steps; step++) {
    fx.fill(0); fy.fill(0);
    for (const [source, target] of edges) {
      const dx = x[target] - x[source], dy = y[target] - y[source], distance = Math.hypot(dx, dy) || 1;
      const rest = 36 + Math.max(0, Math.sqrt(Math.max(neighbors[source].length, neighbors[target].length)) - 2) * 9;
      const force = (distance - rest) / distance * .09;
      fx[source] += dx * force; fy[source] += dy * force; fx[target] -= dx * force; fy[target] -= dy * force;
    }
    const cells = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      if (!neighbors[i].length) continue;
      const key = `${component[i]}:${Math.floor(x[i] / cellSize)}:${Math.floor(y[i] / cellSize)}`;
      const bucket = cells.get(key); if (bucket) bucket.push(i); else cells.set(key, [i]);
    }
    for (let i = 0; i < count; i++) {
      if (!neighbors[i].length) continue;
      const cx = Math.floor(x[i] / cellSize), cy = Math.floor(y[i] / cellSize);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const bucket = cells.get(`${component[i]}:${cx + a}:${cy + b}`); if (!bucket) continue;
        const samples = Math.min(12, bucket.length), stride = Math.max(1, Math.floor(bucket.length / samples));
        for (let k = 0; k < samples; k++) {
          const j = bucket[(i * 17 + step * 7 + k * stride) % bucket.length]; if (j === i) continue;
          let dx = x[i] - x[j], dy = y[i] - y[j], distance = Math.hypot(dx, dy);
          if (distance >= cellSize) continue;
          if (distance < .001) { const angle = ((i + 1) * (j + 1) % 997) * Math.PI * 2 / 997; dx = Math.cos(angle) * (i < j ? 1 : -1); dy = Math.sin(angle) * (i < j ? 1 : -1); distance = 1; }
          const force = (cellSize - distance) / distance * .15;
          fx[i] += dx * force; fy[i] += dy * force;
        }
      }
      vx[i] = vx[i] * .65 + fx[i] - x[i] * .0005; vy[i] = vy[i] * .65 + fy[i] - y[i] * .0005;
    }
    const cooling = 1 - step / steps * .7;
    for (let i = 0; i < count; i++) {
      const speed = Math.hypot(vx[i], vy[i]), factor = Math.min(1, 7 / (speed || 1)) * cooling;
      x[i] += vx[i] * factor; y[i] += vy[i] * factor;
    }
  }
  const isolated = components.filter(nodes => nodes.length === 1).flat();
  isolated.forEach((node, i) => { const radius = 23 * Math.sqrt(i); x[node] = Math.cos(i * 2.399963) * radius; y[node] = Math.sin(i * 2.399963) * radius; });
  const groups = components.filter(nodes => nodes.length > 1); if (isolated.length) groups.push(isolated);
  const boxes = groups.map(nodes => {
    let cx = 0, cy = 0; for (const i of nodes) { cx += x[i]; cy += y[i]; } cx /= nodes.length; cy /= nodes.length;
    let xx = 0, xy = 0, yy = 0; for (const i of nodes) { const dx = x[i] - cx, dy = y[i] - cy; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
    const angle = .5 * Math.atan2(2 * xy, xx - yy), cos = Math.cos(angle), sin = Math.sin(angle);
    for (const i of nodes) { const dx = x[i] - cx, dy = y[i] - cy; x[i] = dx * cos + dy * sin; y[i] = dy * cos - dx * sin; }
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const i of nodes) { left = Math.min(left, x[i]); right = Math.max(right, x[i]); top = Math.min(top, y[i]); bottom = Math.max(bottom, y[i]); }
    return { nodes, left, top, width: right - left + 80, height: bottom - top + 80 };
  }).sort((a, b) => b.height - a.height);
  const width = Math.max(1, ...boxes.map(box => box.width), Math.sqrt(boxes.reduce((sum, box) => sum + box.width * box.height, 0)) * 1.25);
  let left = 0, top = 0, rowHeight = 0;
  for (const box of boxes) {
    if (left && left + box.width > width) { left = 0; top += rowHeight; rowHeight = 0; }
    for (const i of box.nodes) { x[i] += left - box.left + 40; y[i] += top - box.top + 40; }
    left += box.width; rowHeight = Math.max(rowHeight, box.height);
  }
  return new Map(graph.nodes.map((node, i) => [node.id, { x: x[i], y: y[i] }]));
}

const styles = `
.result-graph-container{position:relative;overflow:hidden;min-height:160px}
.result-graph{display:block;width:100%;height:100%;touch-action:none;user-select:none;cursor:grab;color:var(--color-text-primary,CanvasText);--graph-accent:light-dark(#007f99,#20c7e7)}
.result-graph.dragging{cursor:grabbing}.result-graph .graph-edge{cursor:pointer;outline:none}
.result-graph .graph-edge-line{stroke:currentColor;stroke-width:1;stroke-opacity:.25;fill:none;marker-end:var(--graph-arrow);vector-effect:non-scaling-stroke;transition:stroke .16s,stroke-opacity .16s,filter .16s}
.result-graph .graph-arrow{fill:currentColor;fill-opacity:.45}.result-graph .graph-arrow-active{fill:var(--graph-accent);fill-opacity:1}
.result-graph .graph-edge-hit{stroke:transparent;stroke-width:12;fill:none;vector-effect:non-scaling-stroke;pointer-events:stroke}
.result-graph .graph-node{r:var(--graph-dot-radius,3.6px);fill:currentColor;fill-opacity:.65;stroke:transparent;stroke-width:0;vector-effect:non-scaling-stroke;cursor:pointer;outline:none;transition:fill .16s,fill-opacity .16s,opacity .16s,stroke .16s,stroke-width .16s,filter .16s}
.result-graph .is-path.graph-node,.result-graph .is-current.graph-node,.result-graph .is-hot.graph-node{fill:var(--graph-accent);fill-opacity:1}
.result-graph .graph-edge.is-path .graph-edge-line{stroke:var(--graph-accent);stroke-opacity:.8;marker-end:var(--graph-arrow-active)}
.result-graph .graph-edge.is-hot .graph-edge-line,.result-graph .graph-edge:focus-visible .graph-edge-line{stroke:var(--graph-accent);stroke-opacity:1;marker-end:var(--graph-arrow-active);filter:drop-shadow(0 0 3px var(--graph-accent))}
.result-graph .is-hot.graph-node{filter:drop-shadow(0 0 3px var(--graph-accent))}
.result-graph .is-current.graph-node,.result-graph .graph-node:focus-visible{stroke:var(--graph-accent);stroke-width:6;stroke-opacity:.25;fill:var(--graph-accent);fill-opacity:1}
.result-graph .is-muted{opacity:.28;cursor:default}.result-graph .graph-edge.is-muted{opacity:.4}
.result-graph .graph-flow{fill:none;stroke:var(--graph-accent);stroke-width:1.7;stroke-dasharray:3 21;vector-effect:non-scaling-stroke;pointer-events:none;filter:drop-shadow(0 0 2px var(--graph-accent));opacity:0;transition:opacity .18s}
.result-graph .graph-flow.is-active{opacity:.25;animation:result-graph-flow 1.8s linear infinite}.result-graph .graph-hover-flow.is-active{opacity:.55}
@keyframes result-graph-flow{to{stroke-dashoffset:-24}}
.result-graph-tooltip{position:absolute;z-index:4;pointer-events:none;max-width:min(340px,calc(100% - 16px));max-height:calc(100% - 16px);overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 system-ui,sans-serif;color:var(--color-text-primary,CanvasText);background:var(--color-background-primary,Canvas);border:1px solid var(--color-border-secondary,#8886);border-radius:6px;padding:7px 9px;box-shadow:0 3px 14px #0003}
.result-graph-tooltip[hidden]{display:none}@media(prefers-reduced-motion:reduce){.result-graph .graph-node,.result-graph .graph-edge-line,.result-graph .graph-flow{transition:none}.result-graph .graph-flow.is-active{animation:none;stroke-dasharray:none}}`;

export class ResultGraph {
  private svg = svg('svg', { role: 'group', tabindex: '0', 'aria-label': '保存結果の初期値参照グラフ。ドラッグで移動、ホイールで拡大縮小。' });
  private stage = svg('g');
  private arrows: SVGMarkerElement[] = [];
  private pathFlow = svg('path');
  private hoverFlow = svg('path');
  private tooltip = document.createElement('div');
  private nodes = new Map<string, NodeView>();
  private edges = new Map<string, EdgeView>();
  private positions = new Map<string, Point>();
  private path = new Set<string>();
  private current?: string;
  private hotNode?: string;
  private hotEdge?: EdgeView;
  private width = 1;
  private height = 1;
  private camera = { x: 0, y: 0, scale: 1 };
  private fitted = false;
  private fitScale = 1;
  private drag?: { pointer: number; x: number; y: number; moved: boolean };
  private suppressClick = false;
  private observer: ResizeObserver;
  private host: HTMLElement;
  private callbacks: { onNode(node: GraphNode): void; onEdge(edge: GraphEdge): void };

  constructor(host: HTMLElement, callbacks: { onNode(node: GraphNode): void; onEdge(edge: GraphEdge): void }) {
    this.host = host; this.callbacks = callbacks;
    host.classList.add('result-graph-container'); this.svg.classList.add('result-graph');
    const style = document.createElement('style'); style.textContent = styles;
    this.pathFlow.classList.add('graph-flow'); this.hoverFlow.classList.add('graph-flow', 'graph-hover-flow');
    const definitions = svg('defs'), prefix = `result-graph-${++nextGraphID}`;
    for (const suffix of ['arrow', 'arrow-active']) {
      const marker = svg('marker', { id: `${prefix}-${suffix}`, viewBox: '0 0 10 10', orient: 'auto', markerUnits: 'userSpaceOnUse', refY: '5' });
      const shape = svg('path', { d: 'M0 1L10 5L0 9Z' }); shape.classList.add(`graph-${suffix}`); marker.append(shape); definitions.append(marker); this.arrows.push(marker);
      this.svg.style.setProperty(`--graph-${suffix}`, `url(#${prefix}-${suffix})`);
    }
    this.tooltip.className = 'result-graph-tooltip'; this.tooltip.hidden = true; this.tooltip.setAttribute('role', 'tooltip');
    this.svg.append(definitions, this.stage); host.append(style, this.svg, this.tooltip);
    this.svg.addEventListener('wheel', event => { event.preventDefault(); this.zoomAt(Math.exp(-event.deltaY * .0015), event.clientX, event.clientY); }, { passive: false });
    this.svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; this.suppressClick = false;
    });
    this.svg.addEventListener('pointermove', event => {
      const drag = this.drag; if (!drag || drag.pointer !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) { this.svg.setPointerCapture(event.pointerId); this.svg.classList.add('dragging'); this.clearHover(); }
      drag.moved = true; this.camera.x -= dx / this.camera.scale; this.camera.y -= dy / this.camera.scale;
      drag.x = event.clientX; drag.y = event.clientY; this.paintCamera();
    });
    const release = (event: PointerEvent) => {
      if (this.drag?.pointer !== event.pointerId) return;
      this.suppressClick = this.drag.moved; this.drag = undefined; this.svg.classList.remove('dragging');
      if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
    };
    this.svg.addEventListener('pointerup', release); this.svg.addEventListener('pointercancel', release);
    this.svg.addEventListener('pointerleave', () => this.clearHover());
    this.svg.addEventListener('keydown', event => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoom(1.25); }
      else if (event.key === '-') { event.preventDefault(); this.zoom(.8); }
      else if (event.key === '0') { event.preventDefault(); this.fit(); }
      else if (event.target === this.svg && event.key.startsWith('Arrow')) {
        event.preventDefault(); const amount = 40 / this.camera.scale;
        this.camera.x += event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
        this.camera.y += event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0; this.paintCamera();
      } else if (event.key === 'Escape') this.clearHover();
    });
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); this.resize();
  }

  setData(graph: GraphData) {
    const same = graph.nodes.length === this.nodes.size && graph.nodes.every(node => this.nodes.has(node.id)) &&
      graph.edges.length === this.edges.size && graph.edges.every(edge => this.edges.has(edgeID(edge)));
    this.clearHover();
    if (same) {
      for (const node of graph.nodes) { const view = this.nodes.get(node.id)!; view.data = node; this.describeNode(view); }
      for (const edge of graph.edges) this.edges.get(edgeID(edge))!.data = edge;
    } else {
      this.positions = layout(graph); this.nodes.clear(); this.edges.clear();
      const edgeLayer = svg('g'), nodeLayer = svg('g');
      for (const edge of graph.edges) {
        const source = this.positions.get(edge.source), target = this.positions.get(edge.target); if (!source || !target) continue;
        const group = svg('g', { role: 'button', 'aria-label': `${edge.source} → ${edge.target}`, tabindex: '-1' }); group.classList.add('graph-edge');
        for (const name of ['graph-edge-line', 'graph-edge-hit']) {
          const line = svg('line', { x1: source.x, y1: source.y, x2: target.x, y2: target.y }); line.classList.add(name); group.append(line);
        }
        const view = { data: edge, group }; this.edges.set(edgeID(edge), view); edgeLayer.append(group);
        group.addEventListener('pointerenter', () => { if (this.enabledEdge(view) && !this.drag?.moved) this.hoverEdge(view); });
        group.addEventListener('pointerleave', () => { if (this.hotEdge === view) this.clearHover(); });
        group.addEventListener('focus', () => { if (this.enabledEdge(view)) this.hoverEdge(view); });
        group.addEventListener('blur', () => this.clearHover());
        group.addEventListener('click', () => { if (!this.suppressClick && this.enabledEdge(view)) this.callbacks.onEdge(view.data); });
        group.addEventListener('keydown', event => this.navigate(event, view));
      }
      for (const node of graph.nodes) {
        const point = this.positions.get(node.id)!;
        const dot = svg('circle', { cx: point.x, cy: point.y, r: 3.6, role: 'button', tabindex: '-1' }); dot.classList.add('graph-node');
        const view = { data: node, dot }; this.nodes.set(node.id, view); nodeLayer.append(dot); this.describeNode(view);
        dot.addEventListener('pointerenter', event => { if (!this.drag?.moved) this.hoverNode(view, event); });
        dot.addEventListener('pointermove', event => { if (this.hotNode === view.data.id) this.positionTooltip(event.clientX, event.clientY); });
        dot.addEventListener('pointerleave', () => { if (this.hotNode === view.data.id) this.clearHover(); });
        dot.addEventListener('focus', () => { if (view.data.matched) this.hoverNode(view); });
        dot.addEventListener('blur', () => this.clearHover());
        dot.addEventListener('click', () => { if (!this.suppressClick && view.data.matched) this.callbacks.onNode(view.data); });
        dot.addEventListener('keydown', event => this.navigate(event, view));
      }
      this.stage.replaceChildren(edgeLayer, this.pathFlow, this.hoverFlow, nodeLayer); this.fitted = false;
    }
    this.setSelection([...this.path], this.current); this.resize();
  }

  setSelection(pathIDs: readonly string[], currentID?: string) {
    this.path = new Set(pathIDs); this.current = currentID;
    const firstNode = this.nodes.get(currentID ?? '')?.data.matched ? currentID : [...this.nodes.values()].find(view => view.data.matched)?.data.id;
    for (const [id, view] of this.nodes) {
      view.dot.classList.toggle('is-muted', !view.data.matched); view.dot.classList.toggle('is-path', this.path.has(id)); view.dot.classList.toggle('is-current', id === currentID);
      view.dot.setAttribute('aria-disabled', String(!view.data.matched)); view.dot.setAttribute('aria-pressed', String(id === currentID)); view.dot.setAttribute('tabindex', id === firstNode ? '0' : '-1');
    }
    let firstEdge = true; const flow: string[] = [];
    for (const view of this.edges.values()) {
      const enabled = this.enabledEdge(view); view.group.classList.toggle('is-muted', !enabled);
      const inPath = this.path.has(view.data.source) && this.path.has(view.data.target); view.group.classList.toggle('is-path', inPath);
      if (enabled && inPath) flow.push(this.edgePath(view.data));
      view.group.setAttribute('aria-disabled', String(!enabled)); view.group.setAttribute('tabindex', firstEdge && enabled ? '0' : '-1'); if (enabled) firstEdge = false;
    }
    this.pathFlow.setAttribute('d', flow.join('')); this.pathFlow.classList.toggle('is-active', !!flow.length);
  }

  resize() {
    const width = this.host.clientWidth, height = this.host.clientHeight; if (!width || !height) return;
    this.width = width; this.height = height; if (!this.fitted) this.fit(); else this.paintCamera();
  }
  fit() {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const point of this.positions.values()) { left = Math.min(left, point.x); right = Math.max(right, point.x); top = Math.min(top, point.y); bottom = Math.max(bottom, point.y); }
    if (!this.positions.size) { left = top = -50; right = bottom = 50; }
    this.camera = { x: (left + right) / 2, y: (top + bottom) / 2, scale: Math.min(this.width / Math.max(100, right - left + 48), this.height / Math.max(100, bottom - top + 48)) };
    this.fitScale = this.camera.scale; this.fitted = true; this.paintCamera(); this.clearHover();
  }
  zoom(factor: number) {
    const rect = this.svg.getBoundingClientRect(); this.zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  destroy() {
    this.observer.disconnect(); this.host.replaceChildren(); this.host.classList.remove('result-graph-container');
  }

  private enabledEdge(view: EdgeView) { return view.data.matched && !!this.nodes.get(view.data.source)?.data.matched && !!this.nodes.get(view.data.target)?.data.matched; }
  private describeNode(view: NodeView) {
    view.dot.setAttribute('aria-label', `${view.data.scheme} / RowId ${view.data.row_id}; ${Object.entries(view.data.key_labels).map(([key, value]) => `${key}: ${value}`).join('; ')}`);
  }
  private paintCamera() {
    const { x, y, scale } = this.camera; const width = this.width / scale, height = this.height / scale;
    this.svg.setAttribute('viewBox', `${x - width / 2} ${y - height / 2} ${width} ${height}`);
    this.svg.style.setProperty('--graph-dot-radius', `${3.6 / scale}px`);
    for (const arrow of this.arrows) {
      arrow.setAttribute('markerWidth', String(6 / scale)); arrow.setAttribute('markerHeight', String(6 / scale));
      arrow.setAttribute('refX', '18.5');
    }
  }
  private zoomAt(factor: number, clientX: number, clientY: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const rect = this.svg.getBoundingClientRect(), previous = this.camera.scale;
    const next = Math.max(this.fitScale * .15, Math.min(Math.max(12, this.fitScale * 30), previous * factor));
    this.camera.x += (clientX - rect.left - this.width / 2) * (1 / previous - 1 / next);
    this.camera.y += (clientY - rect.top - this.height / 2) * (1 / previous - 1 / next);
    this.camera.scale = next; this.paintCamera(); this.clearHover();
  }
  private clearHover() {
    if (this.hotNode) this.nodes.get(this.hotNode)?.dot.classList.remove('is-hot');
    if (this.hotEdge) {
      this.hotEdge.group.classList.remove('is-hot'); this.nodes.get(this.hotEdge.data.source)?.dot.classList.remove('is-hot'); this.nodes.get(this.hotEdge.data.target)?.dot.classList.remove('is-hot');
    }
    this.hotNode = undefined; this.hotEdge = undefined; this.tooltip.hidden = true; this.hoverFlow.classList.remove('is-active');
  }
  private edgePath(edge: GraphEdge) { const source = this.positions.get(edge.source)!, target = this.positions.get(edge.target)!; return `M${source.x},${source.y}L${target.x},${target.y}`; }
  private hoverEdge(view: EdgeView) {
    this.clearHover(); this.hotEdge = view; view.group.classList.add('is-hot');
    this.nodes.get(view.data.source)?.dot.classList.add('is-hot'); this.nodes.get(view.data.target)?.dot.classList.add('is-hot');
    this.hoverFlow.setAttribute('d', this.edgePath(view.data)); this.hoverFlow.classList.add('is-active');
  }
  private hoverNode(view: NodeView, event?: PointerEvent) {
    this.clearHover(); this.hotNode = view.data.id; view.dot.classList.add('is-hot');
    this.tooltip.textContent = `${view.data.scheme} / RowId ${view.data.row_id}\n${Object.entries(view.data.key_labels).map(([key, value]) => `${key}  ${value}`).join('\n')}`;
    this.tooltip.hidden = false; const rect = view.dot.getBoundingClientRect(); this.positionTooltip(event?.clientX ?? rect.right, event?.clientY ?? rect.top);
  }
  private positionTooltip(clientX: number, clientY: number) {
    if (this.drag?.moved) return;
    const rect = this.host.getBoundingClientRect();
    this.tooltip.style.left = `${Math.max(8, Math.min(this.width - this.tooltip.offsetWidth - 8, clientX - rect.left + 14))}px`;
    this.tooltip.style.top = `${Math.max(8, Math.min(this.height - this.tooltip.offsetHeight - 8, clientY - rect.top + 12))}px`;
  }
  private navigate(event: KeyboardEvent, view: NodeView | EdgeView) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if ('dot' in view) { if (view.data.matched) this.callbacks.onNode(view.data); }
      else if (this.enabledEdge(view)) this.callbacks.onEdge(view.data);
    } else if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const views = 'dot' in view ? [...this.nodes.values()].filter(item => item.data.matched) : [...this.edges.values()].filter(item => this.enabledEdge(item));
      const index = views.findIndex(item => item === view), next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : Math.max(0, Math.min(views.length - 1, index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)));
      const target = views[next]; if (target) { const element = 'dot' in target ? target.dot : target.group; element.focus(); }
    }
  }
}
