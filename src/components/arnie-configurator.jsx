'use client'

/**
 * ARNIE.M — Modular Configurator
 *
 * Dependencies (install these):
 *   npm install @react-three/fiber @react-three/drei three react-grid-layout
 *
 * Architecture:
 *   - react-grid-layout runs headless as the layout/collision engine
 *   - 3D drag input maps to grid rows/cols, then layout is compacted
 *   - Resulting grid layout is written back to 3D unit positions
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";
import ReactGridLayout from "react-grid-layout";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const BIRCH      = "#D4B896";
const BIRCH_DARK = "#B8956A";
const BIRCH_EDGE = "#C4A47C";
const HOOK_COLOR = "#8B6914";
const FRAME_D    = 0.36;
const RAIL_W     = 0.045;

// Fixed 10-row grid — never changes
const GRID_ROWS  = 10;
// Unit heights in grid rows
const UNIT_DEFS = {
  DESK:  { label: "Desk Unit",  icon: "🖥", rows: 1, price: 285, color: "#C8A96E" },
  DOOR:  { label: "Door Unit",  icon: "🚪", rows: 1, price: 195, color: "#C8A96E" },
  SHELF: { label: "Open Shelf", icon: "📋", rows: 1, price: 125, color: "#C8A96E" },
  PEG:   { label: "Pegboard",   icon: "⬜", rows: 1, price: 155, color: "#C8A96E" },
};

const FRAME_PRICES = { base: 320, legs: 85 };

// ─── STORE ────────────────────────────────────────────────────────────────────
function makeStore(init) {
  let state = init;
  const subs = new Set();
  const notify = () => subs.forEach(fn => fn(state));
  return {
    get: () => state,
    set: patch => { state = { ...state, ...patch }; notify(); },
    sub: fn => { subs.add(fn); return () => subs.delete(fn); },
  };
}

let _id = 1;
const store = makeStore({
  // frames: x is auto-computed from index; width/height drive 3D scene
  frames: [
    { id: "f0", width: 0.9, height: 2.1, legs: false },
  ],
  // units: col = frame index, row = grid row from top (0=top slot)
  // row is the TOP edge of the unit in the grid
  units: [],
  sel: null,
});

function useStore() {
  const [s, set] = useState(store.get());
  useEffect(() => store.sub(set), []);
  return s;
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────
const A = {
  addFrame() {
    const { frames } = store.get();
    store.set({ frames: [...frames, { id: `f${_id++}`, width: 0.9, height: 2.1, legs: false }] });
  },
  removeFrame(id) {
    const { frames, units } = store.get();
    if (frames.length <= 1) return;
    const idx = frames.findIndex(f => f.id === id);
    store.set({
      frames: frames.filter(f => f.id !== id),
      // Remove units in this frame; shift others
      units: units
        .filter(u => u.frameId !== id)
        .map(u => {
          const uIdx = frames.findIndex(f => f.id === u.frameId);
          return uIdx > idx ? { ...u } : u;
        }),
    });
  },
  patchFrame(id, patch) {
    const { frames, units } = store.get();
    const nextFrames = frames.map(f => f.id === id ? { ...f, ...patch } : f);
    store.set({ frames: nextFrames });
  },
  // Add a unit: col = frame index, row = grid row (0 = top of frame)
  addUnit(type, frameId, row) {
    const { frames, units } = store.get();
    const frame = frames.find(f => f.id === frameId);
    if (!frame) return false;
    const clampedRow = Math.max(0, Math.min(GRID_ROWS - UNIT_DEFS[type].rows, row));
    const newUnit = { id: `u${_id++}`, type, frameId, row: clampedRow, open: false };
    store.set({ units: [...units, newUnit] });
    return true;
  },
  // Move existing unit to new frame+row (called from 3D drag)
  moveUnit(unitId, newFrameId, newRow) {
    const { frames, units } = store.get();
    const unit = units.find(u => u.id === unitId);
    const frameIndex = frames.findIndex(f => f.id === newFrameId);
    if (!unit || frameIndex < 0) return;
    const clampedRow = Math.max(0, Math.min(GRID_ROWS - UNIT_DEFS[unit.type].rows, newRow));
    const nextUnits = units.map(u => u.id === unitId ? { ...u, frameId: newFrameId, row: clampedRow } : u);
    store.set({ units: nextUnits });
  },
  removeUnit(id) {
    const { units } = store.get();
    store.set({ units: units.filter(u => u.id !== id), sel: null });
  },
  toggleOpen(id) {
    const { units } = store.get();
    store.set({ units: units.map(u => u.id === id ? { ...u, open: !u.open } : u) });
  },
  select(id) { store.set({ sel: id }); },
};

// Helpers
// The slot height in world-space is derived from frame height spread over GRID_ROWS
function slotH(frame) {
  return frame.height / GRID_ROWS;
}
// Convert grid row → 3D world Y (centre of unit, in metres from floor)
// row 0 = top slot, row GRID_ROWS-1 = bottom slot
function rowToWorldY(row, type, frame) {
  const sh = slotH(frame);
  const uh = UNIT_DEFS[type].rows * sh;
  const topOfUnit = frame.height - row * sh; // metres from floor
  return topOfUnit - uh / 2; // centre
}

// Convert world-space localY (metres from floor) → grid row (top edge)
function localYToRow(localY, type, frame) {
  const sh = slotH(frame);
  const uh = UNIT_DEFS[type].rows * sh;
  const rawRow = Math.round((frame.height - (localY + uh / 2)) / sh);
  return Math.max(0, Math.min(GRID_ROWS - UNIT_DEFS[type].rows, rawRow));
}

// Build a react-grid-layout layout from store units.
// All items are marked static so RGL never moves them — the store is authoritative.
function buildLayout(frames, units) {
  return units.map(u => ({
    i: u.id,
    x: Math.max(0, frames.findIndex(f => f.id === u.frameId)),
    y: Math.min(u.row, GRID_ROWS - UNIT_DEFS[u.type].rows),
    w: 1,
    h: UNIT_DEFS[u.type].rows,
    static: true, // prevents RGL from pushing items beyond GRID_ROWS
  }));
}


// ─── 3D HELPERS ───────────────────────────────────────────────────────────────
function Ply({ w, h, d, col = BIRCH, alpha = 1, ...p }) {
  return (
    <mesh castShadow receiveShadow {...p}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={col} roughness={0.75} metalness={0}
        transparent={alpha < 1} opacity={alpha} />
    </mesh>
  );
}

// ─── 3D FRAME ─────────────────────────────────────────────────────────────────
function Frame3D({ frame, frameX }) {
  const { width, height, legs } = frame;
  const hookCount = Math.floor(height / 0.15);
  const hooks = Array.from({ length: hookCount }, (_, i) => height / 2 - i * 0.15 - 0.075);

  return (
    <group position={[frameX, height / 2, 0]}>
      <Ply w={RAIL_W} h={height} d={RAIL_W} col={BIRCH_EDGE} position={[-(width/2)+RAIL_W/2, 0, 0]} />
      <Ply w={RAIL_W} h={height} d={RAIL_W} col={BIRCH_EDGE} position={[width/2-RAIL_W/2, 0, 0]} />
      {hooks.map((hy, i) => (
        <group key={i}>
          <Ply w={0.05} h={0.012} d={0.05} col={HOOK_COLOR} position={[-(width/2)+RAIL_W+0.025, hy, 0.025]} />
          <Ply w={0.05} h={0.012} d={0.05} col={HOOK_COLOR} position={[width/2-RAIL_W-0.025, hy, 0.025]} />
        </group>
      ))}
      <Html position={[0, height/2+0.14, 0]} center>
        <div style={{
          background: "rgba(212,184,150,0.92)", border: "1px solid #B8956A",
          borderRadius: 4, padding: "2px 8px", fontSize: 10,
          fontFamily: "monospace", color: "#4A3520", whiteSpace: "nowrap",
          pointerEvents: "none",
        }}>
          {Math.round(width * 100)}×{Math.round(height * 100)} cm
        </div>
      </Html>
      {legs && [-1, 1].flatMap(sx => [-1, 1].map(sz => (
        <Ply key={`${sx}${sz}`} w={0.045} h={0.35} d={0.045} col={BIRCH_DARK}
          position={[sx*(width/2-0.06), -height/2-0.175, sz*(FRAME_D/2-0.04)]} />
      )))}
    </group>
  );
}

// ─── 3D UNIT ──────────────────────────────────────────────────────────────────
function Unit3D({ unit, frame, frameX, isSelected, onStartDrag, isDragging, draggingAny }) {
  const { type, row, open } = unit;
  const uh = unitH(type);
  const uw = frame.width - RAIL_W * 2 - 0.01;
  const worldY = rowToWorldY(row, type, frame);
  const def = UNIT_DEFS[type];
  const openRef = useRef(0);
  const dragStartRef = useRef(null);
  const dragArmedRef = useRef(false);
  const dragActiveRef = useRef(false);

  useFrame((_, dt) => {
    openRef.current += ((open ? 1 : 0) - openRef.current) * Math.min(1, dt * 7);
  });

  return (
    <group position={[frameX, worldY, 0]}>
      <mesh castShadow receiveShadow
        raycast={draggingAny || isDragging ? () => null : undefined}
        onClick={e => { e.stopPropagation(); A.select(unit.id); }}
        onDoubleClick={e => { e.stopPropagation(); A.toggleOpen(unit.id); }}
        onPointerDown={e => {
          e.stopPropagation();
          dragStartRef.current = { x: e.clientX, y: e.clientY };
          dragArmedRef.current = true;
        }}
        onPointerMove={e => {
          if (!dragArmedRef.current || dragActiveRef.current) return;
          const start = dragStartRef.current;
          if (!start) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (dx * dx + dy * dy > 16) {
            dragActiveRef.current = true;
            onStartDrag(unit.id);
          }
        }}
        onPointerUp={e => {
          e.stopPropagation();
          dragArmedRef.current = false;
          dragActiveRef.current = false;
          dragStartRef.current = null;
        }}>
        <boxGeometry args={[uw, uh - 0.01, FRAME_D - 0.02]} />
        <meshStandardMaterial
          color={isSelected ? "#E8C87A" : BIRCH}
          roughness={0.72} metalness={0}
          emissive={isSelected ? "#FFB300" : "#000"}
          emissiveIntensity={isSelected ? 0.1 : 0} />
      </mesh>
      {type === "DESK"  && <DeskFace3D  uw={uw} uh={uh} openRef={openRef} />}
      {type === "DOOR"  && <DoorFace3D  uw={uw} uh={uh} openRef={openRef} />}
      {type === "SHELF" && <ShelfFace3D uw={uw} uh={uh} />}
      {type === "PEG"   && <PegFace3D   uw={uw} uh={uh} />}
      {isSelected && (
        <Html position={[uw / 2 + 0.08, 0, 0]} center>
          <div style={panelStyle}>
            <div style={{ fontSize:9, color:"#F5D78E", marginBottom:5, letterSpacing:1 }}>
              {def.label.toUpperCase()}
            </div>
            <button style={panelBtn("#D4B896")}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); A.toggleOpen(unit.id); }}>
              {open ? "Close" : "Open"}
            </button>
            <button style={panelBtn("#EF4444")}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); A.removeUnit(unit.id); }}>
              Delete
            </button>
          </div>
        </Html>
      )}
    </group>
  );
}

function DeskFace3D({ uw, uh, openRef }) {
  const leafRef = useRef();
  useFrame(() => { if (leafRef.current) leafRef.current.rotation.x = -openRef.current * Math.PI / 2; });
  return (
    <group position={[0, -uh/2, FRAME_D/2]}>
      <mesh ref={leafRef} position={[0, 0, 0.22]}>
        <boxGeometry args={[uw-0.02, 0.018, 0.44]} />
        <meshStandardMaterial color={BIRCH_DARK} roughness={0.65} />
      </mesh>
    </group>
  );
}

function DoorFace3D({ uw, uh, openRef }) {
  const lRef = useRef(), rRef = useRef();
  const hw = uw / 2 - 0.008;
  useFrame(() => {
    if (lRef.current) lRef.current.rotation.y =  openRef.current * Math.PI * 0.4;
    if (rRef.current) rRef.current.rotation.y = -openRef.current * Math.PI * 0.4;
  });
  return (
    <>
      <group position={[-uw/4, 0, FRAME_D/2]}>
        <mesh ref={lRef} position={[-hw/2, 0, 0]}>
          <boxGeometry args={[hw, uh-0.02, 0.016]} />
          <meshStandardMaterial color={BIRCH} roughness={0.7} />
        </mesh>
      </group>
      <group position={[uw/4, 0, FRAME_D/2]}>
        <mesh ref={rRef} position={[hw/2, 0, 0]}>
          <boxGeometry args={[hw, uh-0.02, 0.016]} />
          <meshStandardMaterial color={BIRCH} roughness={0.7} />
        </mesh>
      </group>
      <Ply w={0.008} h={0.06} d={0.008} col={HOOK_COLOR} position={[-0.04, 0, FRAME_D/2+0.01]} />
      <Ply w={0.008} h={0.06} d={0.008} col={HOOK_COLOR} position={[ 0.04, 0, FRAME_D/2+0.01]} />
    </>
  );
}
function ShelfFace3D({ uw }) {
  return <Ply w={uw-0.02} h={0.014} d={FRAME_D-0.04} col={BIRCH_DARK} />;
}
function PegFace3D({ uw, uh }) {
  const cols = Math.max(1, Math.floor((uw-0.06)/0.07));
  const rows = Math.max(1, Math.floor((uh-0.06)/0.07));
  return (
    <>
      {Array.from({length:rows},(_,r) => Array.from({length:cols},(_,c) => (
        <mesh key={`${r}-${c}`} position={[-(uw/2)+0.04+c*0.07, -(uh/2)+0.04+r*0.07, FRAME_D/2-0.004]}>
          <cylinderGeometry args={[0.006,0.006,0.04,8]} />
          <meshStandardMaterial color={BIRCH_EDGE} />
        </mesh>
      )))}
    </>
  );
}

// ─── 3D SCENE  ─────────────────────────────────────────────────────
function Scene3D({ draggingUnitId, onStartDragUnit, onDragOverFrame, onDropOnFrame }) {
  const s = useStore();

  // Compute frame X positions (centred on origin)
  const totalWidth = s.frames.reduce((sum, f) => sum + f.width, 0) + (s.frames.length - 1) * 0.07;
  let cx = -totalWidth / 2;
  const frameXs = s.frames.map(f => { const x = cx + f.width / 2; cx += f.width + 0.07; return x; });

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[4,8,5]} intensity={1.4} castShadow
        shadow-mapSize={[2048,2048]}
        shadow-camera-left={-5} shadow-camera-right={5}
        shadow-camera-top={5}  shadow-camera-bottom={-1} shadow-camera-far={22} />
      <directionalLight position={[-3,4,2]} intensity={0.3} />
      <mesh receiveShadow rotation={[-Math.PI/2,0,0]}>
        <planeGeometry args={[18,12]} />
        <meshStandardMaterial color="#F5F0EB" roughness={0.9} />
      </mesh>
      <mesh receiveShadow position={[0,1.6,-0.55]}>
        <planeGeometry args={[18,5]} />
        <meshStandardMaterial color="#FAFAF8" roughness={1} />
      </mesh>

      {s.frames.map((frame, i) => (
        <Frame3D key={frame.id} frame={frame} frameX={frameXs[i]} />
      ))}
      {draggingUnitId && s.frames.map((frame, i) => (
        <DropPlane3D
          key={`${frame.id}-drop`}
          frame={frame}
          frameX={frameXs[i]}
          onDrag={onDragOverFrame}
          onDrop={onDropOnFrame}
        />
      ))}
      {s.units.map(unit => {
        const fi = s.frames.findIndex(f => f.id === unit.frameId);
        const frame = s.frames[fi];
        if (!frame) return null;
        return (
          <Unit3D key={unit.id} unit={unit} frame={frame}
            frameX={frameXs[fi]} isSelected={s.sel === unit.id}
            onStartDrag={onStartDragUnit}
            isDragging={draggingUnitId === unit.id}
            draggingAny={Boolean(draggingUnitId)} />
        );
      })}

      <OrbitControls makeDefault
        enabled={!draggingUnitId}
        minPolarAngle={0.15} maxPolarAngle={Math.PI/2.05}
        minAzimuthAngle={-Math.PI/2.2} maxAzimuthAngle={Math.PI/2.2}
        minDistance={1.2} maxDistance={8}
        target={[0,1.05,0]} enablePan={false} />
    </>
  );
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function Sidebar() {
  const s = useStore();
  const unitCounts = s.units.reduce((a, u) => ({ ...a, [u.type]: (a[u.type]||0)+1 }), {});
  const unitTotal  = Object.entries(unitCounts).reduce((t,[k,v]) => t + UNIT_DEFS[k].price*v, 0);
  const frameTotal = s.frames.reduce((t,f) => t + FRAME_PRICES.base + (f.legs?FRAME_PRICES.legs:0), 0);

  return (
    <div style={sideStyle}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#D4B896", letterSpacing: 3 }}>ARNIE.M</div>
        <div style={{ fontSize: 9, color: "#8B6914", letterSpacing: 2 }}>MODULAR CONFIGURATOR</div>
      </div>

      <SL>MODULES</SL>
      <div style={{ fontSize: 8, color: "#5A4030", marginBottom: 8, lineHeight: 1.5 }}>
        Click to add to Frame 1 (drag in 3D to reposition)
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 18 }}>
        {Object.entries(UNIT_DEFS).map(([type, def]) => (
          <div key={type}
            onClick={() => {
              const frame = s.frames[0];
              A.addUnit(type, frame.id, 0);
            }}
            style={modCardStyle(false)}>
            <div style={{ fontSize: 22, marginBottom: 3 }}>{def.icon}</div>
            <div style={{ fontSize: 10, color: "#D4B896", fontWeight: 600 }}>{def.label}</div>
            <div style={{ fontSize: 9, color: "#8B6914", marginTop: 1 }}>£{def.price}</div>
          </div>
        ))}
      </div>

      <SL>FRAMES</SL>
      {s.frames.map((f,i) => <FrameCtrl key={f.id} frame={f} index={i} total={s.frames.length} />)}
      <button onClick={A.addFrame} style={addFBtnStyle}>+ Add Frame</button>

      <div style={{ flex: 1, minHeight: 12 }} />

      <div style={{ borderTop: "1px solid rgba(212,184,150,0.25)", paddingTop: 12 }}>
        <SL>BUILD SUMMARY</SL>
        {s.frames.map((f,i) => (
          <BRow key={f.id}
            label={`Frame ${i+1} (${Math.round(f.width*100)}×${Math.round(f.height*100)}cm${f.legs?" +legs":""})`}
            price={FRAME_PRICES.base+(f.legs?FRAME_PRICES.legs:0)} />
        ))}
        {Object.entries(unitCounts).map(([t,c]) => (
          <BRow key={t} label={`${c}× ${UNIT_DEFS[t].label}`} price={UNIT_DEFS[t].price*c} />
        ))}
        <div style={{ display:"flex", justifyContent:"space-between",
          borderTop:"1px solid rgba(212,184,150,0.3)", paddingTop:8, marginTop:6,
          color:"#E8D5A3", fontSize:13, fontWeight:700 }}>
          <span>TOTAL</span><span>£{frameTotal+unitTotal}</span>
        </div>
        <button style={quotBtnStyle}>REQUEST QUOTE →</button>
      </div>
    </div>
  );
}

function FrameCtrl({ frame, index, total }) {
  return (
    <div style={fCtrlStyle}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:7 }}>
        <span style={{ fontSize:11, color:"#D4B896" }}>Frame {index+1}</span>
        {total > 1 &&
          <button onClick={() => A.removeFrame(frame.id)}
            style={{ background:"transparent", border:"none", color:"#EF4444", cursor:"pointer", fontSize:14 }}>✕</button>}
      </div>
      <Slider label="Width"  value={frame.width}  min={0.6} max={1.2} step={0.05} fmt={v=>`${Math.round(v*100)}cm`} onChange={v=>A.patchFrame(frame.id,{width:v})} />
      <Slider label="Height" value={frame.height} min={1.5} max={2.4} step={0.01}  fmt={v=>`${Math.round(v*100)}cm`} onChange={v=>A.patchFrame(frame.id,{height:v})} />
      <label style={{ display:"flex", gap:6, fontSize:10, color:"#B8956A", cursor:"pointer", marginTop:4, alignItems:"center" }}>
        <input type="checkbox" checked={frame.legs} onChange={e=>A.patchFrame(frame.id,{legs:e.target.checked})} style={{ accentColor:"#D4B896" }} />
        Legs (+£{FRAME_PRICES.legs})
      </label>
    </div>
  );
}

function Slider({ label, value, min, max, step, fmt, onChange }) {
  return (
    <div style={{ marginBottom:6 }}>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#8B6914", marginBottom:2 }}>
        <span>{label}</span><span style={{ color:"#D4B896" }}>{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width:"100%", accentColor:"#D4B896" }} />
    </div>
  );
}

const SL = ({ children }) => <div style={{ fontSize:9, letterSpacing:2, color:"#B8956A", marginBottom:8 }}>{children}</div>;
const BRow = ({ label, price }) => (
  <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#C4A47C", marginBottom:4 }}>
    <span>{label}</span><span>£{price}</span>
  </div>
);

// ─── STYLES ───────────────────────────────────────────────────────────────────
const sideStyle = {
  width: 242, background: "linear-gradient(180deg,#1A120B,#231810)",
  borderRight: "1px solid rgba(212,184,150,0.18)",
  display: "flex", flexDirection: "column", padding: 16, gap: 0,
  overflowY: "auto", fontFamily: "'Courier New',monospace",
};
const modCardStyle = active => ({
  background: active ? "rgba(212,184,150,0.22)" : "rgba(212,184,150,0.07)",
  border: `1px solid ${active ? "#D4B896" : "rgba(212,184,150,0.18)"}`,
  borderRadius: 8, padding: "10px 8px", cursor: "grab",
  transition: "all 0.15s", textAlign: "center", userSelect: "none",
});
const addFBtnStyle = {
  background: "transparent", border: "1px dashed rgba(212,184,150,0.28)",
  color: "#B8956A", borderRadius: 6, padding: "8px", cursor: "pointer",
  fontFamily: "monospace", fontSize: 11, marginBottom: 12, marginTop: 4, width: "100%",
};
const quotBtnStyle = {
  width: "100%", marginTop: 10, background: "#D4B896", border: "none",
  color: "#1A120B", padding: "10px", borderRadius: 6,
  fontFamily: "monospace", fontWeight: 700, fontSize: 12, cursor: "pointer", letterSpacing: 1,
};
const fCtrlStyle = {
  background: "rgba(212,184,150,0.05)", border: "1px solid rgba(212,184,150,0.14)",
  borderRadius: 6, padding: 10, marginBottom: 8,
};
const panelStyle = {
  background:"rgba(18,12,6,0.93)", border:"1px solid #F59E0B",
  borderRadius:8, padding:"8px 10px", display:"flex",
  flexDirection:"column", gap:5, minWidth:94, fontFamily:"monospace",
};
const panelBtn = col => ({
  background:"transparent", border:`1px solid ${col}`, color:col,
  borderRadius:4, padding:"4px 0", fontSize:10, cursor:"pointer",
  fontFamily:"monospace", width:"100%",
});

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [draggingUnitId, setDraggingUnitId] = useState(null);
  const s = useStore();

  const handleStartDragUnit = useCallback((id) => {
    A.select(id);
    setDraggingUnitId(id);
  }, []);

  const handleDragOverFrame = useCallback((frameId, localY) => {
    if (!draggingUnitId || localY == null) return;
    const { frames, units } = store.get();
    const frame = frames.find(f => f.id === frameId);
    const unit = units.find(u => u.id === draggingUnitId);
    if (!frame || !unit) return;
    const targetRow = localYToRow(localY, unit.type, frame);
    A.moveUnit(draggingUnitId, frameId, targetRow);
  }, [draggingUnitId]);

  const handleDropOnFrame = useCallback((frameId, localY) => {
    if (!draggingUnitId) return;
    handleDragOverFrame(frameId, localY);
    setDraggingUnitId(null);
  }, [draggingUnitId, handleDragOverFrame]);

  useEffect(() => {
    const up = () => setDraggingUnitId(null);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  return (
    <div style={{ display:"flex", width:"100vw", height:"100vh", background:"#1A120B", overflow:"hidden" }}>
      <Sidebar />

      {/* RGL Background Engine — fixed 10-row grid */}
      <div style={{ position: "absolute", top: -9999, left: -9999, visibility: "hidden" }}>
        <ReactGridLayout
          layout={buildLayout(s.frames, s.units)}
          cols={Math.max(1, s.frames.length)}
          rowHeight={44}
          maxRows={GRID_ROWS}
          width={Math.max(1, s.frames.length) * 100}
          onLayoutChange={A.syncLayout}
          compactType={null}
          preventCollision={false}
          isDraggable={false}
          isResizable={false}
          useCSSTransforms={false}
          measureBeforeMount={false}
        >
          {s.units.map((u) => (
            <div key={u.id} />
          ))}
        </ReactGridLayout>
      </div>

      <div style={{ flex:1, position:"relative" }}>
        <Canvas shadows
          camera={{ position:[0,1.5,4.5], fov:42 }}
          style={{ background:"linear-gradient(170deg,#F5F0EB,#EDE8E3)" }}
          onClick={() => { if (!draggingUnitId) A.select(null); }}>
          <Scene3D
            draggingUnitId={draggingUnitId}
            onStartDragUnit={handleStartDragUnit}
            onDragOverFrame={handleDragOverFrame}
            onDropOnFrame={handleDropOnFrame}
          />
        </Canvas>
        {/* Overlay hint */}
        <div style={{
          position:"absolute", bottom:14, right:14,
          background:"rgba(18,12,6,0.82)", border:"1px solid rgba(212,184,150,0.2)",
          borderRadius:8, padding:"9px 13px",
          fontFamily:"monospace", fontSize:9, color:"#8B6914", lineHeight:2,
          pointerEvents:"none",
        }}>
          <div style={{ color:"#D4B896", marginBottom:2, fontWeight:700 }}>CONTROLS</div>
          <div>Click module card → add to Frame 1</div>
          <div>Click unit → select (gold outline)</div>
          <div>Drag unit → move / change frame</div>
          <div>Double-click unit → open/close</div>
          <div>Selected unit → Delete button</div>
          <div>Scene: drag to orbit · scroll to zoom</div>
        </div>
      </div>
    </div>
  );
}

function DropPlane3D({ frame, frameX, onDrag, onDrop }) {
  const { width, height, id } = frame;
  const handleMove = useCallback((e) => {
    e.stopPropagation();
    if (e.buttons !== 1 && e.pointerType !== "touch") return;
    const localY = Math.max(0, Math.min(height, e.point.y));
    onDrag(id, localY);
  }, [id, height, onDrag]);

  const handleUp = useCallback((e) => {
    e.stopPropagation();
    const localY = Math.max(0, Math.min(height, e.point.y));
    onDrop(id, localY);
  }, [id, height, onDrop]);

  return (
    <mesh position={[frameX, height / 2, 0.02]}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerLeave={() => onDrag(id, null)}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}
