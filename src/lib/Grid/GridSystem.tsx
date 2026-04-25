'use client'

import { Html, OrbitControls } from '@react-three/drei'
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { animated, config as springConfig, useSpring } from '@react-spring/three'
import { Suspense, useCallback, useEffect, useMemo, useRef, useReducer, useState, type ComponentType } from 'react'
import type { CSSProperties } from 'react'
import * as THREE from 'three'
import { Button3D } from '@/components/3d/Button3d'
import { applyConstraint } from '@/lib/ConstraintSystem'
import { ModelDesk } from '@/models/unit_desk'
import { ModelFrame } from '@/models/unit_frame'
import { ModelLargeDoor } from '@/models/unit_large_door'
import { ModelLargeSmall } from '@/models/unit_large_small'
import { ModelOpenSmall } from '@/models/unit_open_small'
import { ModelPegBoard } from '@/models/unit_pegboard'
import { ModelSmallDoor } from '@/models/unit_small_door'
import { ModelSmallPanel } from '@/models/unit_small_panel'
import { EffectComposer, SSAO } from '@react-three/postprocessing'

// ─── Types ────────────────────────────────────────────────────────────────────

type GridConfig = {
    cols: number
    rows: number
    cellW: number
    cellH: number
    originX: number
    originY: number
    axis: 'XZ' | 'XY'
    lockHorizontal: boolean
    lockVertical: boolean
}

type ModelKey =
    | 'frame'
    | 'desk'
    | 'largeDoor'
    | 'largeSmall'
    | 'openSmall'
    | 'pegboard'
    | 'smallDoor'
    | 'smallPanel'

type Offset = { x: number; y: number; z: number }

type GridItem = {
    id: string
    col: number
    row: number
    w: number
    h: number
    label: string
    color: string
    modelKey: ModelKey
    offset?: Offset
    frameId?: string
}

type PaletteItem = {
    id: string
    w: number
    h: number
    label: string
    color: string
    modelKey: ModelKey
    offset?: Offset
    image?: string
}

type Cell = { col: number; row: number }
type Rect = { col: number; row: number; w: number; h: number }

type DragState =
    | { type: 'from-palette'; item: PaletteItem; currentCell?: Cell; hitPoint?: THREE.Vector3 }
    | {
        type: 'reposition'
        itemId: string
        origin: Cell
        offset: { x: number; z: number }
        currentCell?: Cell
        hitPoint?: THREE.Vector3
        delta: { x: number; z: number }
    }

type GhostInfo = { rect: Rect; valid: boolean }

type State = {
    gridConfig: GridConfig
    items: GridItem[]
    drag: DragState | null
    history: GridItem[][]
    debug: boolean
    lastExport?: string
    selectedId: string | null
    colAdds: { left: number; right: number }
    modelOffset: Offset
}

type Action =
    | { type: 'SET_GRID_CONFIG'; patch: Partial<GridConfig> }
    | { type: 'PLACE_ITEM'; item: GridItem }
    | { type: 'MOVE_ITEMS'; items: GridItem[] }
    | { type: 'ADD_COL_LEFT' }
    | { type: 'ADD_COL_RIGHT' }
    | { type: 'REMOVE_COL_LEFT' }
    | { type: 'REMOVE_COL_RIGHT' }
    | { type: 'SET_DRAG'; drag: DragState | null }
    | { type: 'UNDO' }
    | { type: 'TOGGLE_DEBUG' }
    | { type: 'SET_EXPORT'; payload: string }
    | { type: 'SET_SELECTED'; id: string | null }
    | { type: 'SET_MODEL_OFFSET'; patch: Partial<State['modelOffset']> }

// ─── Constants ────────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 50
const MIN_COLS = 1
const MAX_COLS = 6
const ITEM_HEIGHT = 0.175
const FRAME_HEIGHT_CELLS = 10
const FRAME_Z_OFFSET = -0.08
const GRID_Z_OFFSET = 0

const ALL_DIRS = [
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
]

const combineOffset = (base: Offset, extra?: Offset): Offset => ({
    x: base.x + (extra?.x ?? 0),
    y: base.y + (extra?.y ?? 0),
    z: base.z + (extra?.z ?? 0),
})

const CLICK_DRAG_THRESHOLD_PX = 6

const DEFAULT_CONFIG: GridConfig = {
    cols: 1,
    rows: 10,
    cellW: 1,
    cellH: 0.175,
    originX: 0,
    originY: 0,
    axis: 'XY',
    lockHorizontal: true,
    lockVertical: false,
}

const MODEL_COMPONENTS: Record<ModelKey, ComponentType<any>> = {
    frame: ModelFrame,
    desk: ModelDesk,
    largeDoor: ModelLargeDoor,
    largeSmall: ModelLargeSmall,
    openSmall: ModelOpenSmall,
    pegboard: ModelPegBoard,
    smallDoor: ModelSmallDoor,
    smallPanel: ModelSmallPanel,
}

const isToggleAnimModel = (modelKey: ModelKey) =>
    modelKey === 'desk' || modelKey === 'smallDoor' || modelKey === 'largeDoor'

const isScaleControlNode = (obj: THREE.Object3D) => {
    const n = (obj.userData?.name ?? obj.name ?? '').toLowerCase()
    return n.startsWith('c_scalex') || n.startsWith('c_scalx')
}

const FOOT_NODE_NAMES: Partial<Record<ModelKey, string[]>> = {
    largeDoor: ['m_foot_l002', 'm_foot_r002'],
    smallDoor: ['m_foot_l001', 'm_foot_r001'],
    openSmall: ['m_foot_l', 'm_foot_r'],
}

const PALETTE: PaletteItem[] = [
    { id: 'unit-small-panel', modelKey: 'smallPanel', w: 1, h: 2, label: 'Small Panel', color: '#f59e0b' },
    { id: 'unit-large-small', modelKey: 'largeSmall', w: 1, h: 4, label: 'Large Panel', color: '#ef4444' },
    { id: 'unit-pegboard', modelKey: 'pegboard', w: 1, h: 4, label: 'Pegboard', color: '#8b5cf6' },
    { id: 'unit-desk', modelKey: 'desk', w: 1, h: 4, label: 'Desk', color: '#64748b' },
    { id: 'unit-open-small', modelKey: 'openSmall', w: 1, h: 2, label: 'Small Open Cabinate', color: '#22c55e', offset: { x: 0, y: -.13, z: 0.0 } },
    { id: 'unit-small-door', modelKey: 'smallDoor', w: 1, h: 2, label: 'Small Door Cabinet', color: '#0ea5e9', offset: { x: 0, y: -.13, z: 0.0 } },
    { id: 'unit-large-door', modelKey: 'largeDoor', w: 1, h: 4, label: 'Large Door Cabinet', color: '#f43f5e', offset: { x: 0, y: -.13, z: 0.0 } },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const palettePreviewSrc = (item: PaletteItem) => {
    if (item.image) return item.image
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="140" viewBox="0 0 220 140">
    <rect x="10" y="12" width="200" height="96" rx="10" fill="${item.color}"/>
    <rect x="16" y="18" width="188" height="84" rx="8" fill="rgba(255,255,255,0.18)"/>
    <text x="20" y="128" font-size="14" fill="#0f172a" font-family="system-ui,sans-serif">${item.label}</text>
  </svg>`
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const getColumnWidth = (cfg: GridConfig, col: number, columnWidths: Record<number, number>) =>
    columnWidths[col] ?? cfg.cellW

const spanWidth = (cfg: GridConfig, col: number, w: number, columnWidths: Record<number, number>) => {
    let total = 0
    for (let i = 0; i < w; i++) total += getColumnWidth(cfg, col + i, columnWidths)
    return total
}

const totalGridWidth = (cfg: GridConfig, columnWidths: Record<number, number>) =>
    spanWidth(cfg, 0, cfg.cols, columnWidths)

const columnStartX = (cfg: GridConfig, col: number, columnWidths: Record<number, number>) =>
    cfg.originX + spanWidth(cfg, 0, col, columnWidths)

const worldToCell = (x: number, y: number, cfg: GridConfig, columnWidths: Record<number, number>): Cell => {
    let col = 0
    let cursor = cfg.originX
    for (; col < cfg.cols; col++) {
        const w = getColumnWidth(cfg, col, columnWidths)
        if (x < cursor + w) break
        cursor += w
    }
    return {
        col: clamp(col, 0, cfg.cols - 1),
        row: clamp(Math.floor((y - cfg.originY) / cfg.cellH), 0, cfg.rows - 1),
    }
}

const itemCenter = (col: number, row: number, w: number, h: number, cfg: GridConfig, columnWidths: Record<number, number>) => ({
    x: columnStartX(cfg, col, columnWidths) + spanWidth(cfg, col, w, columnWidths) / 2,
    y: cfg.originY + row * cfg.cellH + (h * cfg.cellH) / 2,
})

const inBounds = (r: Rect, cfg: GridConfig) =>
    r.col >= 0 && r.row >= 0 && r.col + r.w <= cfg.cols && r.row + r.h <= cfg.rows

const rectsOverlap = (a: Rect, b: Rect) =>
    a.col < b.col + b.w && a.col + a.w > b.col && a.row < b.row + b.h && a.row + a.h > b.row

const buildOccupancy = (items: GridItem[], cfg: GridConfig, ignoreId?: string) => {
    const map: (string | null)[][] = Array.from({ length: cfg.rows }, () => Array(cfg.cols).fill(null))
    for (const item of items) {
        if (ignoreId && item.id === ignoreId) continue
        for (let r = 0; r < item.h; r++)
            for (let c = 0; c < item.w; c++) {
                const rr = item.row + r, cc = item.col + c
                if (rr >= 0 && rr < cfg.rows && cc >= 0 && cc < cfg.cols) map[rr][cc] = item.id
            }
    }
    return map
}

const removeItemAndChildren = (items: GridItem[], rootId: string) => {
    const ids = new Set<string>()
    const queue = [rootId]
    while (queue.length) {
        const id = queue.pop()!
        if (ids.has(id)) continue
        ids.add(id)
        for (const item of items) if (item.frameId === id) queue.push(item.id)
    }
    return items.filter(item => !ids.has(item.id))
}

// ─── Push resolver ────────────────────────────────────────────────────────────

type PosMap = Map<string, Rect>

function allowedDirs(cfg: GridConfig) {
    return ALL_DIRS.filter(d => {
        if (cfg.lockHorizontal && d.dc !== 0) return false
        if (cfg.lockVertical && d.dr !== 0) return false
        return true
    })
}

function nearestFreeRect(rect: Rect, posMap: PosMap, skipId: string, cfg: GridConfig): Rect | null {
    const visited = new Set<string>()
    const queue: Rect[] = [{ ...rect }]
    const key = (r: Rect) => `${r.col},${r.row}`
    const dirs = allowedDirs(cfg)
    if (dirs.length === 0) return null

    while (queue.length) {
        const candidate = queue.shift()!
        const k = key(candidate)
        if (visited.has(k)) continue
        visited.add(k)
        if (!inBounds(candidate, cfg)) continue
        let blocked = false
        for (const [id, r] of posMap) {
            if (id === skipId) continue
            if (rectsOverlap(candidate, r)) { blocked = true; break }
        }
        if (!blocked) return candidate
        for (const { dc, dr } of dirs) {
            const next: Rect = { col: candidate.col + dc, row: candidate.row + dr, w: rect.w, h: rect.h }
            if (!visited.has(key(next))) queue.push(next)
        }
    }
    return null
}

function noOverlaps(posMap: PosMap, target: Rect): boolean {
    const entries = Array.from(posMap.entries())
    for (const [, r] of entries) if (rectsOverlap(target, r)) return false
    for (let i = 0; i < entries.length; i++)
        for (let j = i + 1; j < entries.length; j++)
            if (rectsOverlap(entries[i][1], entries[j][1])) return false
    return true
}

function buildResult(items: GridItem[], dragId: string, target: Rect, posMap: PosMap, incomingItem?: GridItem): GridItem[] {
    const result = items.map(item => {
        if (item.id === dragId) return { ...item, col: target.col, row: target.row }
        const r = posMap.get(item.id)
        if (!r) return item
        return r.col === item.col && r.row === item.row ? item : { ...item, col: r.col, row: r.row }
    })
    if (incomingItem) result.push({ ...incomingItem, col: target.col, row: target.row })
    return result
}

function resolveDisplace(
    items: GridItem[],
    dragId: string,
    target: Rect,
    cfg: GridConfig,
    dragDelta: { x: number; z: number },
    incomingItem?: GridItem,
): GridItem[] | null {
    const baseMap: PosMap = new Map()
    for (const item of items) {
        if (item.id === dragId) continue
        baseMap.set(item.id, { col: item.col, row: item.row, w: item.w, h: item.h })
    }

    const immediateBlockers = Array.from(baseMap.entries()).filter(([, r]) => rectsOverlap(target, r))
    if (immediateBlockers.length === 0) return buildResult(items, dragId, target, baseMap, incomingItem)

    const dx = dragDelta.x, dz = dragDelta.z
    const dirScore = ({ dc, dr }: { dc: number; dr: number }) =>
        (dc !== 0 && Math.sign(dc) === Math.sign(dx) ? -2 : 0) +
        (dr !== 0 && Math.sign(dr) === Math.sign(dz) ? -2 : 0)
    const dirs = allowedDirs(cfg)
    if (dirs.length === 0) return null
    const orderedDirs = [...dirs].sort((a, b) => dirScore(a) - dirScore(b))

    for (const primaryDir of orderedDirs) {
        const attempt = new Map(baseMap)
        const queue: { id: string; depth: number }[] = immediateBlockers.map(([id]) => ({ id, depth: 0 }))
        let failed = false

        while (queue.length && !failed) {
            const { id: bid, depth } = queue.shift()!
            if (depth > 10) { failed = true; break }
            const bRect = attempt.get(bid)
            if (!bRect) continue

            let pusher: Rect | null = rectsOverlap(bRect, target) ? target : null
            if (!pusher) {
                for (const [oid, or] of attempt) {
                    if (oid !== bid && rectsOverlap(bRect, or)) { pusher = or; break }
                }
            }
            if (!pusher) continue

            let placed = false
            const dirsToTry = [primaryDir, ...orderedDirs.filter(d => d !== primaryDir)]

            for (const dir of dirsToTry) {
                let nc = bRect.col, nr = bRect.row
                if (dir.dc > 0) nc = pusher.col + pusher.w
                if (dir.dc < 0) nc = pusher.col - bRect.w
                if (dir.dr > 0) nr = pusher.row + pusher.h
                if (dir.dr < 0) nr = pusher.row - bRect.h

                const moved: Rect = { col: nc, row: nr, w: bRect.w, h: bRect.h }
                if (!inBounds(moved, cfg)) continue

                const secondary: string[] = []
                for (const [oid, or] of attempt) {
                    if (oid !== bid && rectsOverlap(moved, or)) secondary.push(oid)
                }
                attempt.set(bid, moved)
                for (const sid of secondary) {
                    if (!queue.find(q => q.id === sid)) queue.push({ id: sid, depth: depth + 1 })
                }
                placed = true
                break
            }

            if (!placed) {
                const free = nearestFreeRect(bRect, attempt, bid, cfg)
                if (!free) { failed = true; break }
                attempt.set(bid, free)
            }
        }

        if (failed) continue
        if (noOverlaps(attempt, target)) return buildResult(items, dragId, target, attempt, incomingItem)
    }
    return null
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

const pushHistory = (h: GridItem[][], items: GridItem[]) =>
    [items.map(i => ({ ...i })), ...h].slice(0, HISTORY_LIMIT)

const reducer = (state: State, action: Action): State => {
    switch (action.type) {
        case 'SET_GRID_CONFIG': {
            const next = { ...state.gridConfig, ...action.patch }
            if (action.patch.cols !== undefined) next.cols = clamp(action.patch.cols, MIN_COLS, MAX_COLS)
            return {
                ...state,
                gridConfig: next,
                colAdds: action.patch.cols !== undefined ? { left: 0, right: 0 } : state.colAdds,
            }
        }
        case 'PLACE_ITEM':
            return { ...state, history: pushHistory(state.history, state.items), items: [...state.items, action.item] }
        case 'MOVE_ITEMS':
            return { ...state, history: pushHistory(state.history, state.items), items: action.items }
        case 'ADD_COL_LEFT': {
            if (state.gridConfig.cols >= MAX_COLS) return state
            return {
                ...state,
                history: pushHistory(state.history, state.items),
                items: state.items.map(item => ({ ...item, col: item.col + 1 })),
                colAdds: { ...state.colAdds, left: state.colAdds.left + 1 },
                gridConfig: {
                    ...state.gridConfig,
                    cols: state.gridConfig.cols + 1,
                    originX: state.gridConfig.originX - state.gridConfig.cellW,
                },
            }
        }
        case 'ADD_COL_RIGHT': {
            if (state.gridConfig.cols >= MAX_COLS) return state
            return {
                ...state,
                history: pushHistory(state.history, state.items),
                colAdds: { ...state.colAdds, right: state.colAdds.right + 1 },
                gridConfig: { ...state.gridConfig, cols: state.gridConfig.cols + 1 },
            }
        }
        case 'REMOVE_COL_LEFT': {
            if (state.gridConfig.cols <= MIN_COLS || state.colAdds.left <= 0) return state
            return {
                ...state,
                history: pushHistory(state.history, state.items),
                items: state.items
                    .filter(item => item.col > 0 && item.col + item.w - 1 > 0)
                    .map(item => ({ ...item, col: item.col - 1 })),
                colAdds: { ...state.colAdds, left: state.colAdds.left - 1 },
                gridConfig: {
                    ...state.gridConfig,
                    cols: state.gridConfig.cols - 1,
                    originX: state.gridConfig.originX + state.gridConfig.cellW,
                },
            }
        }
        case 'REMOVE_COL_RIGHT': {
            if (state.gridConfig.cols <= MIN_COLS || state.colAdds.right <= 0) return state
            const lastCol = state.gridConfig.cols - 1
            return {
                ...state,
                history: pushHistory(state.history, state.items),
                items: state.items.filter(item => item.col + item.w - 1 < lastCol),
                colAdds: { ...state.colAdds, right: state.colAdds.right - 1 },
                gridConfig: { ...state.gridConfig, cols: state.gridConfig.cols - 1 },
            }
        }
        case 'UNDO': {
            if (!state.history.length) return state
            const [prev, ...rest] = state.history
            return { ...state, items: prev, history: rest }
        }
        case 'SET_DRAG': return { ...state, drag: action.drag }
        case 'TOGGLE_DEBUG': return { ...state, debug: !state.debug }
        case 'SET_EXPORT': return { ...state, lastExport: action.payload }
        case 'SET_SELECTED': return { ...state, selectedId: action.id }
        case 'SET_MODEL_OFFSET': return { ...state, modelOffset: { ...state.modelOffset, ...action.patch } }
        default: return state
    }
}

const initialState: State = {
    gridConfig: DEFAULT_CONFIG,
    items: [{ id: 'unit-a', col: 0, row: 0, w: 1, h: 2, label: 'Small Panel 1×2', color: '#f59e0b', modelKey: 'smallPanel' }],
    drag: null, history: [], debug: false, selectedId: null,
    colAdds: { left: 0, right: 0 },
    modelOffset: { x: 0, y: 0, z: 0 },
}

// ─── Ghost / preview ──────────────────────────────────────────────────────────

function computeGhost(state: State): GhostInfo | null {
    const { drag, items, gridConfig } = state
    if (!drag?.currentCell) return null
    if (drag.type === 'reposition' &&
        drag.currentCell.col === drag.origin.col &&
        drag.currentCell.row === drag.origin.row) return null

    const base = drag.type === 'from-palette' ? drag.item : items.find(i => i.id === drag.itemId)
    if (!base) return null
    const rect: Rect = { col: drag.currentCell.col, row: drag.currentCell.row, w: base.w, h: base.h }
    if (!inBounds(rect, gridConfig)) return { rect, valid: false }

    const dragId = drag.type === 'reposition' ? drag.itemId : '__new__'
    const relevant = drag.type === 'reposition' ? items.filter(i => i.id !== drag.itemId) : items
    if (!relevant.some(i => rectsOverlap(rect, i))) return { rect, valid: true }

    const delta = drag.type === 'reposition' ? drag.delta : { x: 0, z: 0 }
    const incomingItem = drag.type === 'from-palette'
        ? {
            id: dragId,
            col: rect.col,
            row: rect.row,
            w: rect.w,
            h: rect.h,
            label: drag.item.label,
            color: drag.item.color,
            modelKey: drag.item.modelKey,
            offset: drag.item.offset,
        }
        : undefined

    return { rect, valid: resolveDisplace(items, dragId, rect, gridConfig, delta, incomingItem) !== null }
}

function computePreview(state: State): GridItem[] | null {
    const { drag, items, gridConfig } = state
    if (!drag?.currentCell) return null
    if (drag.type === 'reposition' &&
        drag.currentCell.col === drag.origin.col &&
        drag.currentCell.row === drag.origin.row) return null

    const base = drag.type === 'from-palette' ? drag.item : items.find(i => i.id === drag.itemId)
    if (!base) return null
    const rect: Rect = { col: drag.currentCell.col, row: drag.currentCell.row, w: base.w, h: base.h }
    if (!inBounds(rect, gridConfig)) return null

    const dragId = drag.type === 'reposition' ? drag.itemId : '__preview__'
    const delta = drag.type === 'reposition' ? drag.delta : { x: 0, z: 0 }
    const incoming = drag.type === 'from-palette'
        ? {
            id: dragId,
            col: rect.col,
            row: rect.row,
            w: rect.w,
            h: rect.h,
            label: drag.item.label,
            color: drag.item.color,
            modelKey: drag.item.modelKey,
            offset: drag.item.offset,
        }
        : undefined

    return resolveDisplace(items, dragId, rect, gridConfig, delta, incoming)
}

// ─── Grid lines ───────────────────────────────────────────────────────────────

const GridLines = ({ config, columnWidths }: { config: GridConfig; columnWidths: Record<number, number> }) => {
    const geometry = useMemo(() => {
        const verts: number[] = []
        const W = totalGridWidth(config, columnWidths), H = config.rows * config.cellH
        if (config.axis === 'XZ') {
            let x = config.originX
            for (let c = 0; c <= config.cols; c++) {
                verts.push(x, 0, config.originY, x, 0, config.originY + H)
                if (c < config.cols) x += getColumnWidth(config, c, columnWidths)
            }
            for (let r = 0; r <= config.rows; r++) {
                const z = config.originY + r * config.cellH
                verts.push(config.originX, 0, z, config.originX + W, 0, z)
            }
        } else {
            let x = config.originX
            for (let c = 0; c <= config.cols; c++) {
                verts.push(x, config.originY, GRID_Z_OFFSET, x, config.originY + H, GRID_Z_OFFSET)
                if (c < config.cols) x += getColumnWidth(config, c, columnWidths)
            }
            for (let r = 0; r <= config.rows; r++) {
                const y = config.originY + r * config.cellH
                verts.push(config.originX, y, GRID_Z_OFFSET, config.originX + W, y, GRID_Z_OFFSET)
            }
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
        return geo
    }, [config, columnWidths])
    return (
        <lineSegments geometry={geometry}>
            <lineBasicMaterial color="#f1f1f1" toneMapped={false} />
        </lineSegments>
    )
}

// ─── Camera ───────────────────────────────────────────────────────────────────

const CameraRig = ({ config, columnWidths }: { config: GridConfig; columnWidths: Record<number, number> }) => {
    const { camera } = useThree()
    const target = useMemo<[number, number, number]>(() => {
        const W = totalGridWidth(config, columnWidths), H = config.rows * config.cellH
        if (config.axis === 'XZ') {
            return [config.originX + W / 2, 0, config.originY + H / 2]
        } else {
            return [config.originX + W / 2, config.originY + H / 2, 0]
        }
    }, [config, columnWidths])

    const desiredPos = useMemo<[number, number, number]>(() => {
        const W = totalGridWidth(config, columnWidths), H = config.rows * config.cellH
        if (config.axis === 'XZ') {
            return [config.originX + W / 2, 8, config.originY + H * 1.4]
        }
        return [config.originX + W / 2, config.originY + H / 2, Math.max(W, H) * 1.6]
    }, [config, columnWidths])

    useFrame((_, delta) => {
        camera.position.x = THREE.MathUtils.damp(camera.position.x, desiredPos[0], 6, delta)
        camera.position.y = THREE.MathUtils.damp(camera.position.y, desiredPos[1], 6, delta)
        camera.position.z = THREE.MathUtils.damp(camera.position.z, desiredPos[2], 6, delta)

        camera.lookAt(target[0], target[1], target[2])
    })

    return null
}

const CameraTargetAnimator = ({
    controlsRef,
    target,
    animateKey,
}: {
    controlsRef: React.MutableRefObject<any>
    target: [number, number, number]
    animateKey: number
}) => {
    const desired = useRef(new THREE.Vector3(target[0], target[1], target[2]))
    const animateUntilRef = useRef(0)

    useEffect(() => {
        desired.current.set(target[0], target[1], target[2])
    }, [target])

    useEffect(() => {
        animateUntilRef.current = performance.now() + 450
    }, [animateKey])

    useFrame((_, delta) => {
        const controls = controlsRef.current
        if (!controls) return
        const t = controls.target as THREE.Vector3
        const shouldAnimate = performance.now() < animateUntilRef.current

        if (shouldAnimate) {
            t.x = THREE.MathUtils.damp(t.x, desired.current.x, 7, delta)
            t.y = THREE.MathUtils.damp(t.y, desired.current.y, 7, delta)
            t.z = THREE.MathUtils.damp(t.z, desired.current.z, 7, delta)
        } else {
            t.copy(desired.current)
        }
        controls.update()
    })

    return null
}

// ─── UnitModel ────────────────────────────────────────────────────────────────
//
// Renders the model at its natural glTF scale (no scaling applied).
// Measures the bounding box in GROUP LOCAL space to correctly center the model
// regardless of where the parent group sits in world space.
//
// Why local space? box.expandByObject() returns WORLD-space coords. If we used
// those directly for offsets, we'd double-subtract the parent's world position.
// Converting all 8 bbox corners through group.matrixWorld.invert() gives coords
// relative to the group's own origin — independent of parent placement.

const UnitModel = ({ modelKey, axis, offset, isToggled, showFeet, cellScaleX }: {
    modelKey: ModelKey
    axis: GridConfig['axis']
    offset: Offset
    isToggled: boolean
    showFeet: boolean
    cellScaleX: number
}) => {
    const groupRef = useRef<THREE.Group>(null)
    const nodeMap = useRef<Map<string, THREE.Object3D>>(new Map())
    const [localCenter, setLocalCenter] = useState<THREE.Vector3 | null>(null)
    const [localMin, setLocalMin] = useState<THREE.Vector3 | null>(null)
    const baseRotationsRef = useRef<Map<string, THREE.Euler>>(new Map())
    const scaleNodesRef = useRef<THREE.Object3D[]>([])
    const baseScaleXRef = useRef<Map<string, number>>(new Map())

    const ModelComponent = MODEL_COMPONENTS[modelKey]

    useEffect(() => {
        if (!groupRef.current) return
        nodeMap.current.clear()
        baseRotationsRef.current.clear()
        baseScaleXRef.current.clear()
        scaleNodesRef.current = []
        groupRef.current.traverse(obj => {
            nodeMap.current.set(obj.name, obj)
            if (obj.userData?.name) nodeMap.current.set(obj.userData.name, obj)
            if (isScaleControlNode(obj)) {
                scaleNodesRef.current.push(obj)
                baseScaleXRef.current.set(obj.uuid, obj.scale.x)
            }
        })
    }, [modelKey])

    useEffect(() => {
        const names = FOOT_NODE_NAMES[modelKey]
        if (!names?.length) return
        for (const name of names) {
            const node = nodeMap.current.get(name)
            if (node) node.visible = showFeet
        }
    }, [modelKey, showFeet])

    useEffect(() => {
        for (const node of scaleNodesRef.current) {
            const baseScaleX = baseScaleXRef.current.get(node.uuid) ?? node.scale.x
            node.scale.x = baseScaleX * cellScaleX
        }
    }, [cellScaleX, modelKey])

    useEffect(() => {
        let tries = 0, raf = 0

        const measure = () => {
            const group = groupRef.current
            if (!group) return
            group.updateWorldMatrix(true, true)

            const worldBox = new THREE.Box3()
            worldBox.makeEmpty()
            group.traverse(obj => { if ((obj as THREE.Mesh).isMesh) worldBox.expandByObject(obj) })

            if (worldBox.isEmpty()) {
                if (++tries < 20) raf = requestAnimationFrame(measure)
                return
            }

            // Transform all 8 corners to group LOCAL space
            const invWorld = group.matrixWorld.clone().invert()
            const localBox = new THREE.Box3()
            const { min, max } = worldBox
                ;[
                    [min.x, min.y, min.z], [max.x, min.y, min.z],
                    [min.x, max.y, min.z], [max.x, max.y, min.z],
                    [min.x, min.y, max.z], [max.x, min.y, max.z],
                    [min.x, max.y, max.z], [max.x, max.y, max.z],
                ].forEach(([x, y, z]) =>
                    localBox.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(invWorld))
                )

            const size = new THREE.Vector3()
            localBox.getSize(size)
            if (size.x < 1e-5 || size.y < 1e-5 || size.z < 1e-5) {
                if (++tries < 20) raf = requestAnimationFrame(measure)
                return
            }

            const center = new THREE.Vector3()
            localBox.getCenter(center)
            setLocalCenter(center.clone())
            setLocalMin(localBox.min.clone())
        }

        raf = requestAnimationFrame(measure)
        return () => cancelAnimationFrame(raf)
    }, [axis, modelKey, cellScaleX])

    useFrame((_, delta) => {
        if (!groupRef.current) return
        groupRef.current.traverse(obj => {
            const raw = obj.userData?.constraints
            if (!raw) return
            try {
                const constraints = typeof raw === 'string' ? JSON.parse(raw) : raw
                for (const c of constraints) applyConstraint(obj, c, nodeMap.current)
            } catch { /* ignore */ }
        })

        if (!isToggleAnimModel(modelKey)) return

        const ensureBaseRotation = (name: string) => {
            const map = baseRotationsRef.current
            if (map.has(name)) return
            const node = nodeMap.current.get(name)
            if (!node) return
            map.set(name, node.rotation.clone())
        }

        const dampRotation = (name: string, axisKey: 'x' | 'y' | 'z', openDelta: number, closedOffset = 0) => {
            ensureBaseRotation(name)
            const node = nodeMap.current.get(name)
            const base = baseRotationsRef.current.get(name)
            if (!node || !base) return

            const closed = base[axisKey] + closedOffset
            const target = isToggled ? closed + openDelta : closed
            node.rotation[axisKey] = THREE.MathUtils.damp(node.rotation[axisKey], target, 10, delta)
        }

        if (modelKey === 'desk') {
            dampRotation('c_rotator_desk', 'x', Math.PI * 0.45)
            return
        }

        if (modelKey === 'largeDoor') {
            dampRotation('c_rotator_dl_r', 'y', Math.PI / 1.6, -3 * Math.PI / 4)
            dampRotation('c_rotator_ld_l', 'y', - Math.PI / 1.7, 3 * Math.PI / 4)
            return
        }

        if (modelKey === 'smallDoor') {
            dampRotation('c_rotator_dl_r.001', 'y', -1.05)
            dampRotation('c_rotator_ld_l.001', 'y', 1.05)
        }
    })

    const center = localCenter ?? new THREE.Vector3()
    const min = localMin ?? new THREE.Vector3()

    // Center the model horizontally and vertically; flush the front/bottom face
    const finalPos: [number, number, number] = axis === 'XY'
        ? [-center.x + offset.x, -center.y + offset.y, -min.z + offset.z]
        : [-center.x + offset.x, -min.y + offset.y, -center.z + offset.z]

    return (
        <group ref={groupRef} position={finalPos}>
            <ModelComponent />
        </group>
    )
}

// ─── GridItemMesh ─────────────────────────────────────────────────────────────

type ItemMeshProps = {
    item: GridItem
    config: GridConfig
    isDragging: boolean
    dragCell?: Cell
    isSelected: boolean
    isOutOfBounds: boolean
    onPointerDown: (item: GridItem, e: ThreeEvent<PointerEvent>) => void
    onSelect: (id: string) => void
    onDoubleClick: (id: string) => void
    onDelete: (id: string) => void
    onToggleAnimation: (item: GridItem) => void
    showBox: boolean
    modelOffset: Offset
    isToggled: boolean
    columnWidths: Record<number, number>
    baseCellWidth: number
    immediatePosition: boolean
}

const GridItemMesh = ({
    item, config, isDragging, dragCell, isSelected, isOutOfBounds,
    onPointerDown, onSelect, onDoubleClick, onDelete, onToggleAnimation, showBox, modelOffset, isToggled, columnWidths, baseCellWidth, immediatePosition,
}: ItemMeshProps) => {
    const dc = dragCell ?? { col: item.col, row: item.row }
    const c = itemCenter(dc.col, dc.row, item.w, item.h, config, columnWidths)
    const lift = isDragging ? 0.35 : 0
    const pos: [number, number, number] = config.axis === 'XZ'
        ? [c.x, lift, c.y]
        : [c.x, c.y, lift + GRID_Z_OFFSET]
    const width = spanWidth(config, dc.col, item.w, columnWidths)
    const halfW = (width - 0.06) / 2
    const halfH = (item.h * config.cellH - 0.06) / 2
    const boxW = width - 0.06
    const boxH = item.h * config.cellH - 0.06
    const showFeet = Boolean(FOOT_NODE_NAMES[item.modelKey]) && dc.row === 0
    const columnWidth = columnWidths[dc.col] ?? baseCellWidth
    const cellScaleX = columnWidth / baseCellWidth

    const { position, scale } = useSpring({
        position: pos,
        scale: isDragging ? 1.05 : 1,
        config: isDragging ? springConfig.stiff : springConfig.gentle,
        immediate: key => key === 'position' && !isDragging && immediatePosition,
    })
    const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
    const movedRef = useRef(false)

    return (
        <animated.group
            position={position}
            scale={scale}
            onPointerDown={e => {
                e.stopPropagation()
                pointerDownRef.current = { x: e.clientX, y: e.clientY }
                movedRef.current = false
                onSelect(item.id)
                onPointerDown(item, e)
            }}
            onPointerMove={e => {
                const start = pointerDownRef.current
                if (!start) return
                if (Math.abs(e.clientX - start.x) > CLICK_DRAG_THRESHOLD_PX || Math.abs(e.clientY - start.y) > CLICK_DRAG_THRESHOLD_PX) {
                    movedRef.current = true
                }
            }}
            onPointerUp={e => {
                if (!movedRef.current && isToggleAnimModel(item.modelKey)) onToggleAnimation(item)
                pointerDownRef.current = null
                movedRef.current = false
            }}
            onDoubleClick={e => { e.stopPropagation(); onDoubleClick(item.id) }}
        >
            {/* Debug / out-of-bounds indicator box */}
            <mesh
                castShadow
                receiveShadow
                position={config.axis === 'XZ' ? [0, ITEM_HEIGHT / 2, 0] : [0, 0, ITEM_HEIGHT / 2]}
            >
                <boxGeometry args={
                    config.axis === 'XZ'
                        ? [boxW, ITEM_HEIGHT, boxH]
                        : [boxW, boxH, ITEM_HEIGHT]
                } />
                <meshStandardMaterial
                    transparent
                    opacity={showBox ? (isOutOfBounds ? 0.25 : 0.12) : 0}
                    color={isOutOfBounds ? '#f59e0b' : item.color}
                    depthWrite={false}
                />
            </mesh>

            {/* Actual model — no scaling, just centered */}
            <Suspense fallback={null}>
                <UnitModel
                    modelKey={item.modelKey}
                    axis={config.axis}
                    offset={combineOffset(modelOffset, item.offset)}
                    isToggled={isToggled}
                    showFeet={showFeet}
                    cellScaleX={cellScaleX}
                />
            </Suspense>

            {/* Delete button when selected */}
            {isSelected && (
                <Html
                    position={config.axis === 'XZ'
                        ? [halfW, ITEM_HEIGHT / 2 + 0.08, boxH / 2]
                        : [halfW, halfH, ITEM_HEIGHT / 2 + 0.08]
                    }
                    center
                    distanceFactor={8}
                    occlude={false}
                    pointerEvents="auto"
                >
                    <button
                        type="button"
                        style={S.deleteBtn}
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); onDelete(item.id) }}
                    >
                        ×
                    </button>
                </Html>
            )}
        </animated.group>
    )
}

const ColumnFrameMesh = ({
    col,
    config,
    modelOffset,
    columnWidths,
    enterFrom,
    animToken,
    animateCol,
    animMode,
}: {
    col: number
    config: GridConfig
    modelOffset: Offset
    columnWidths: Record<number, number>
    enterFrom: 'left' | 'right'
    animToken: number
    animateCol: number | null
    animMode: 'idle' | 'add' | 'remove'
}) => {
    const c = itemCenter(col, 0, 1, FRAME_HEIGHT_CELLS, config, columnWidths)
    const pos: [number, number, number] = config.axis === 'XZ'
        ? [c.x, 0, c.y]
        : [c.x, c.y, GRID_Z_OFFSET]
    const cellScaleX = getColumnWidth(config, col, columnWidths) / config.cellW
    const offset = 0.45
    const fromPos: [number, number, number] = enterFrom === 'left'
        ? [pos[0] - offset, pos[1], pos[2]]
        : [pos[0] + offset, pos[1], pos[2]]
    const prevAnimTokenRef = useRef(animToken)
    const shouldAnimate = animMode === 'remove' || (animMode === 'add' && animateCol !== null && col === animateCol)
    const shouldReset = shouldAnimate && animToken > 0 && prevAnimTokenRef.current !== animToken
    useEffect(() => { prevAnimTokenRef.current = animToken }, [animToken])
    const { position, scale } = useSpring({
        from: animMode === 'add'
            ? { position: fromPos, scale: [0.94, 1, 1] as [number, number, number] }
            : { position: pos, scale: [1, 1, 1] as [number, number, number] },
        position: pos,
        scale: [1, 1, 1] as [number, number, number],
        config: springConfig.gentle,
        reset: shouldReset,
        immediate: !shouldAnimate || animToken === 0,
    })

    return (
        <animated.group position={position} scale={scale}>
            <Suspense fallback={null}>
                <UnitModel
                    modelKey="frame"
                    axis={config.axis}
                    offset={{ ...modelOffset, z: modelOffset.z + FRAME_Z_OFFSET }}
                    isToggled={false}
                    showFeet={false}
                    cellScaleX={cellScaleX}
                />
            </Suspense>
        </animated.group>
    )
}

// ─── Ghost ────────────────────────────────────────────────────────────────────

const GhostItem = ({ rect, config, valid, columnWidths }: { rect: Rect; config: GridConfig; valid: boolean; columnWidths: Record<number, number> }) => {
    const c = itemCenter(rect.col, rect.row, rect.w, rect.h, config, columnWidths)
    const width = spanWidth(config, rect.col, rect.w, columnWidths)
    const pos: [number, number, number] = config.axis === 'XZ'
        ? [c.x, ITEM_HEIGHT / 2 + 0.02, c.y]
        : [c.x, c.y, ITEM_HEIGHT / 2 + 0.02 + GRID_Z_OFFSET]
    return (
        <mesh position={pos}>
            <boxGeometry args={
                config.axis === 'XZ'
                    ? [width - 0.06, ITEM_HEIGHT - 0.05, rect.h * config.cellH - 0.06]
                    : [width - 0.06, rect.h * config.cellH - 0.06, ITEM_HEIGHT - 0.05]
            } />
            <meshStandardMaterial color={valid ? '#22c55e' : '#ef4444'} transparent opacity={0.38} />
        </mesh>
    )
}

// ─── Raycast plane ────────────────────────────────────────────────────────────

const GridPlane = ({ config, onMove, onUp, columnWidths }: {
    config: GridConfig
    onMove: (e: ThreeEvent<PointerEvent>) => void
    onUp: (e: ThreeEvent<PointerEvent>) => void
    columnWidths: Record<number, number>
}) => {
    const W = totalGridWidth(config, columnWidths), H = config.rows * config.cellH
    const pos: [number, number, number] = config.axis === 'XZ'
        ? [config.originX + W / 2, 0.001, config.originY + H / 2]
        : [config.originX + W / 2, config.originY + H / 2, 0.001 + GRID_Z_OFFSET]
    const rot: [number, number, number] = config.axis === 'XZ' ? [-Math.PI / 2, 0, 0] : [0, 0, 0]
    return (
        <mesh position={pos} rotation={rot} onPointerMove={onMove} onPointerUp={onUp}>
            <planeGeometry args={[W, H]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
    )
}

// ─── Debug overlay ────────────────────────────────────────────────────────────

const DebugOverlay = ({ occupancy, drag, ghost, config }: {
    occupancy: (string | null)[][]
    drag: DragState | null
    ghost: GhostInfo | null
    config: GridConfig
}) => (
    <div style={S.debugPanel}>
        <div style={S.debugTitle}>Debug</div>
        <div style={S.debugSection}>
            <div style={S.debugLabel}>Drag</div>
            <pre style={S.debugCode}>{JSON.stringify(drag ? {
                type: drag.type, cell: drag.currentCell,
                delta: drag.type === 'reposition' ? drag.delta : undefined,
            } : null, null, 2)}</pre>
        </div>
        <div style={S.debugSection}>
            <div style={S.debugLabel}>Ghost</div>
            <pre style={S.debugCode}>{ghost ? JSON.stringify({ valid: ghost.valid, rect: ghost.rect }, null, 2) : 'null'}</pre>
        </div>
        <div style={S.debugSection}>
            <div style={S.debugLabel}>Occupancy</div>
            <div style={S.occGrid}>
                {Array.from({ length: config.rows }, (_, row) => (
                    <div key={row} style={{ ...S.occRow, gridTemplateColumns: `repeat(${config.cols}, 1fr)` }}>
                        {Array.from({ length: config.cols }, (_, col) => {
                            const val = occupancy[row]?.[col]
                            const hit = ghost
                                && col >= ghost.rect.col && col < ghost.rect.col + ghost.rect.w
                                && row >= ghost.rect.row && row < ghost.rect.row + ghost.rect.h
                            return (
                                <span key={col} style={{
                                    ...S.occCell,
                                    background: hit
                                        ? (ghost.valid ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)')
                                        : 'transparent',
                                    color: val ? '#f8fafc' : 'rgba(148,163,184,0.4)',
                                }}>
                                    {val ? val.slice(0, 4) : '·'}
                                </span>
                            )
                        })}
                    </div>
                ))}
            </div>
        </div>
    </div>
)

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function GridSystem() {
    const [state, dispatch] = useReducer(reducer, initialState)
    const [toggledItems, setToggledItems] = useState<Record<string, boolean>>({})
    const [columnWidths, setColumnWidths] = useState<Record<number, number>>({})
    const [frameEnterFrom, setFrameEnterFrom] = useState<'left' | 'right'>('left')
    const [frameAnimToken, setFrameAnimToken] = useState(0)
    const [frameAnimateCol, setFrameAnimateCol] = useState<number | null>(null)
    const [frameAnimMode, setFrameAnimMode] = useState<'idle' | 'add' | 'remove'>('idle')
    const [layoutAnimToken, setLayoutAnimToken] = useState(0)
    const [isResizingColumns, setIsResizingColumns] = useState(false)
    const stateRef = useRef(state)
    stateRef.current = state
    const controlsRef = useRef<any>(null)
    const resizeTimeoutRef = useRef<number | null>(null)
    const dropHandledRef = useRef(false)
    const dragCardRef = useRef<HTMLDivElement>(null)
    const dragPointerRef = useRef<{ x: number; y: number } | null>(null)

    const occupancy = useMemo(() =>
        buildOccupancy(state.items, state.gridConfig,
            state.drag?.type === 'reposition' ? state.drag.itemId : undefined),
        [state.items, state.gridConfig, state.drag])

    const ghost = useMemo(() => computeGhost(state), [state])
    const previewItems = useMemo(() => computePreview(state), [state])
    const previewMap = useMemo(() => {
        if (!previewItems) return null
        const map = new Map<string, Cell>()
        for (const item of previewItems) map.set(item.id, { col: item.col, row: item.row })
        return map
    }, [previewItems])

    const handleToggleAnimation = useCallback((item: GridItem) => {
        if (!isToggleAnimModel(item.modelKey)) return
        setToggledItems(prev => ({ ...prev, [item.id]: !prev[item.id] }))
    }, [])

    const handleAddColumnLeft = useCallback(() => {
        setFrameAnimMode('add')
        setFrameEnterFrom('right')
        setFrameAnimateCol(0)
        setFrameAnimToken(t => t + 1)
        setLayoutAnimToken(t => t + 1)
        dispatch({ type: 'ADD_COL_LEFT' })
    }, [])

    const handleAddColumnRight = useCallback(() => {
        setFrameAnimMode('add')
        setFrameEnterFrom('left')
        setFrameAnimateCol(stateRef.current.gridConfig.cols)
        setFrameAnimToken(t => t + 1)
        setLayoutAnimToken(t => t + 1)
        dispatch({ type: 'ADD_COL_RIGHT' })
    }, [])

    const handleRemoveColumnLeft = useCallback(() => {
        setFrameAnimMode('remove')
        setFrameAnimateCol(null)
        setFrameAnimToken(t => t + 1)
        setLayoutAnimToken(t => t + 1)
        dispatch({ type: 'REMOVE_COL_LEFT' })
    }, [])

    const handleRemoveColumnRight = useCallback(() => {
        setFrameAnimMode('remove')
        setFrameAnimateCol(null)
        setFrameAnimToken(t => t + 1)
        setLayoutAnimToken(t => t + 1)
        dispatch({ type: 'REMOVE_COL_RIGHT' })
    }, [])

    useEffect(() => {
        if (frameAnimMode === 'idle') return
        const t = window.setTimeout(() => setFrameAnimMode('idle'), 520)
        return () => window.clearTimeout(t)
    }, [frameAnimMode, frameAnimToken, layoutAnimToken])

    const selectedItem = useMemo(
        () => state.items.find(i => i.id === state.selectedId) ?? null,
        [state.items, state.selectedId],
    )
    const activeColumn = selectedItem?.col ?? 0
    const activeColumnWidth = columnWidths[activeColumn] ?? state.gridConfig.cellW

    // ── Handlers ──────────────────────────────────────────────────────────────

    const handleItemPointerDown = useCallback((item: GridItem, e: ThreeEvent<PointerEvent>) => {
        const { gridConfig } = stateRef.current
        const hit = e.point
        const ay = gridConfig.axis === 'XZ' ? hit.z : hit.y
        const colStart = columnStartX(gridConfig, item.col, columnWidths)
        const rowStart = item.row * gridConfig.cellH
        dispatch({
            type: 'SET_DRAG', drag: {
                type: 'reposition', itemId: item.id,
                origin: { col: item.col, row: item.row },
                offset: {
                    x: hit.x - colStart,
                    z: ay - rowStart,
                },
                currentCell: { col: item.col, row: item.row },
                delta: { x: 0, z: 0 },
                hitPoint: hit.clone(),
            }
        })
    }, [columnWidths])

    const handlePlaneMove = useCallback((e: ThreeEvent<PointerEvent>) => {
        const { drag, gridConfig } = stateRef.current
        if (!drag) return
        e.stopPropagation()
        const pt = e.point
        const ay = gridConfig.axis === 'XZ' ? pt.z : pt.y

        if (drag.type === 'from-palette') {
            dispatch({ type: 'SET_DRAG', drag: { ...drag, currentCell: worldToCell(pt.x, ay, gridConfig, columnWidths), hitPoint: pt.clone() } })
            return
        }
        const ax = pt.x - drag.offset.x
        const az = ay - drag.offset.z
        const cell = worldToCell(ax, az, gridConfig, columnWidths)
        dispatch({
            type: 'SET_DRAG', drag: {
                ...drag, currentCell: cell, hitPoint: pt.clone(),
                delta: { x: cell.col - drag.origin.col, z: cell.row - drag.origin.row },
            }
        })
    }, [columnWidths])

    const commitDrop = useCallback(() => {
        const { drag, items, gridConfig } = stateRef.current
        if (!drag?.currentCell) return

        if (drag.type === 'from-palette') {
            const rect: Rect = { col: drag.currentCell.col, row: drag.currentCell.row, w: drag.item.w, h: drag.item.h }
            if (!inBounds(rect, gridConfig)) return
            const newId = `unit-${Date.now()}`
            const newItem: GridItem = {
                id: newId,
                ...rect,
                label: drag.item.label,
                color: drag.item.color,
                modelKey: drag.item.modelKey,
                offset: drag.item.offset,
            }
            const hasOverlap = items.some(i => rectsOverlap(rect, i))
            if (!hasOverlap) {
                dispatch({ type: 'PLACE_ITEM', item: newItem })
            } else {
                const resolved = resolveDisplace(items, newId, rect, gridConfig, { x: 0, z: 0 }, newItem)
                if (resolved) dispatch({ type: 'MOVE_ITEMS', items: resolved })
                else return
            }
            dispatch({ type: 'SET_SELECTED', id: newId })
            return
        }

        const item = items.find(i => i.id === drag.itemId)
        if (!item) return
        const target: Rect = { col: drag.currentCell.col, row: drag.currentCell.row, w: item.w, h: item.h }
        if (!inBounds(target, gridConfig)) return

        const others = items.filter(i => i.id !== drag.itemId)
        const hasOverlap = others.some(i => rectsOverlap(target, i))

        if (!hasOverlap) {
            if (target.col !== item.col || target.row !== item.row)
                dispatch({ type: 'MOVE_ITEMS', items: items.map(i => i.id === item.id ? { ...i, ...target } : i) })
            return
        }

        const resolved = resolveDisplace(items, drag.itemId, target, gridConfig, drag.delta)
        if (resolved) dispatch({ type: 'MOVE_ITEMS', items: resolved })
    }, [])

    const handlePlaneUp = useCallback((e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation()
        dropHandledRef.current = true
        commitDrop()
        dispatch({ type: 'SET_DRAG', drag: null })
    }, [commitDrop])

    // Global pointer-up safety net
    useEffect(() => {
        const onUp = () => {
            if (!stateRef.current.drag) { dropHandledRef.current = false; return }
            if (!dropHandledRef.current) dispatch({ type: 'SET_DRAG', drag: null })
            dropHandledRef.current = false
        }
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => { window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp) }
    }, [])

    // Ctrl+Z undo
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault(); dispatch({ type: 'UNDO' })
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    useEffect(() => () => {
        if (resizeTimeoutRef.current) window.clearTimeout(resizeTimeoutRef.current)
    }, [])

    // Drag card follows pointer
    useEffect(() => {
        if (state.drag?.type !== 'from-palette') return
        const update = (x: number, y: number) => {
            const el = dragCardRef.current
            if (el) { el.style.left = `${x}px`; el.style.top = `${y}px` }
        }
        const initial = dragPointerRef.current
        if (initial) update(initial.x, initial.y)
        const handleMove = (e: PointerEvent) => update(e.clientX, e.clientY)
        window.addEventListener('pointermove', handleMove)
        return () => window.removeEventListener('pointermove', handleMove)
    }, [state.drag?.type])

    // ── Derived layout values ─────────────────────────────────────────────────

    const W = totalGridWidth(state.gridConfig, columnWidths)
    const D = state.gridConfig.rows * state.gridConfig.cellH

    const center: [number, number, number] = state.gridConfig.axis === 'XZ'
        ? [state.gridConfig.originX + W / 2, 0, state.gridConfig.originY + D / 2]
        : [state.gridConfig.originX + W / 2, state.gridConfig.originY + D / 2, GRID_Z_OFFSET]

    const camPos: [number, number, number] = state.gridConfig.axis === 'XZ'
        ? [state.gridConfig.originX + W / 2, 8, state.gridConfig.originY + D * 1.4]
        : [state.gridConfig.originX + W / 2, state.gridConfig.originY + D / 2, Math.max(W, D) * 1.6]

    const btnSize: [number, number, number] = [0.65, 0.65, 0.1]
    const btnMargin = 0.2
    const btnGap = 0.35

    const leftBtnPos: [number, number, number] = state.gridConfig.axis === 'XZ'
        ? [state.gridConfig.originX - .5, 0.15, state.gridConfig.originY + D / 2]
        : [state.gridConfig.originX - .5, state.gridConfig.originY + D / 2, 0.15]
    const rightBtnPos: [number, number, number] = state.gridConfig.axis === 'XZ'
        ? [state.gridConfig.originX + W + .5, 0.15, state.gridConfig.originY + D / 2]
        : [state.gridConfig.originX + W + .5, state.gridConfig.originY + D / 2, 0.15]
    const leftBtnPosDown: [number, number, number] = state.gridConfig.axis === 'XZ'
        ? [leftBtnPos[0], leftBtnPos[1], leftBtnPos[2] - btnGap]
        : [leftBtnPos[0], leftBtnPos[1] - btnGap, leftBtnPos[2]]
    const rightBtnPosDown: [number, number, number] = state.gridConfig.axis === 'XZ'
        ? [rightBtnPos[0], rightBtnPos[1], rightBtnPos[2] - btnGap]
        : [rightBtnPos[0], rightBtnPos[1] - btnGap, rightBtnPos[2]]


    const handleExport = () => {
        const p = JSON.stringify({ gridConfig: state.gridConfig, items: state.items }, null, 2)
        dispatch({ type: 'SET_EXPORT', payload: p })
        navigator.clipboard?.writeText(p).catch(() => { })
    }

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div style={S.shell}>

            {/* ── Sidebar ── */}
            <div style={S.sidebar}>
                <div style={S.sidebarHeader}>
                    <div style={S.brandTitle}>Arnie.M </div>
                    <div style={S.brandSub}>3D Furniture Layout</div>
                </div>

                <div style={S.sectionTitle}>Grid</div>
                <label style={S.fieldLabel}>
                    Cell Width (Column {activeColumn + 1})
                    <input
                        type="range"
                        min={state.gridConfig.cellW * 0.6}
                        max={state.gridConfig.cellW * 1.6}
                        step={0.01}
                        value={activeColumnWidth}
                        onChange={e => {
                            const value = Number(e.currentTarget.value)
                            setColumnWidths(prev => ({ ...prev, [activeColumn]: value }))
                            setIsResizingColumns(true)
                            if (resizeTimeoutRef.current) window.clearTimeout(resizeTimeoutRef.current)
                            resizeTimeoutRef.current = window.setTimeout(() => {
                                setIsResizingColumns(false)
                                resizeTimeoutRef.current = null
                            }, 140)
                        }}
                    />
                </label>
                <div style={S.sectionTitle}>Palette</div>
                <div style={S.paletteGrid}>
                    {PALETTE.map(item => (
                        <button key={item.id} type="button"
                            style={{ ...S.paletteCard, borderLeftColor: item.color }}
                            onPointerDown={e => {
                                dragPointerRef.current = { x: e.clientX, y: e.clientY }
                                dispatch({ type: 'SET_DRAG', drag: { type: 'from-palette', item } })
                            }}
                        >
                            <span style={S.paletteLabel}>{item.label}</span>
                            <span style={S.paletteMeta}>{item.w}×{item.h}</span>
                        </button>
                    ))}
                </div>

                <div style={S.actionRow}>
                    <button style={S.btn} onClick={() => dispatch({ type: 'UNDO' })}>↩ Undo</button>
                    <button style={S.btn} onClick={handleExport}>⬆ Save</button>
                </div>
                <button style={S.btnGhost} onClick={() => dispatch({ type: 'TOGGLE_DEBUG' })}>
                    {state.debug ? 'Hide Debug' : 'Show Debug'}
                </button>
                {state.lastExport && <textarea readOnly style={S.exportBox} value={state.lastExport} />}
                <div style={S.hint}>Double-click to remove · Ctrl+Z undo</div>
            </div>

            {/* ── Canvas ── */}
            <div style={S.canvasWrap}>
                <Canvas shadows camera={{ position: camPos, fov: 42 }} style={S.canvas}
                    onPointerMissed={() => dispatch({ type: 'SET_SELECTED', id: null })}>
                    <CameraTargetAnimator controlsRef={controlsRef} target={center} animateKey={layoutAnimToken} />
                    <ambientLight intensity={5} />
                    {/* <directionalLight position={[10, 20, 10]} intensity={1.1} castShadow /> */}
                    {/* GridLines hidden by request */}

                    <Button3D position={leftBtnPos} size={btnSize} textureUrl="/graph_plus.png"
                        tooltip="Add column left" onClick={handleAddColumnLeft}
                        colors={{ base: '#EAEAEA', hover: '#4E4E4E', pressed: '#818181' }} margin={btnMargin} />
                    <Button3D position={rightBtnPos} size={btnSize} textureUrl="/graph_plus.png"
                        tooltip="Add column right" onClick={handleAddColumnRight}
                        colors={{ base: '#EAEAEA', hover: '#4E4E4E', pressed: '#818181' }} margin={btnMargin} />
                    <Button3D position={leftBtnPosDown} size={btnSize} textureUrl="/graph_minus.png"
                        tooltip="Remove column left" onClick={handleRemoveColumnLeft}
                        colors={{ base: '#EAEAEA', hover: '#ef4444', pressed: '#b91c1c' }} margin={btnMargin} />
                    <Button3D position={rightBtnPosDown} size={btnSize} textureUrl="/graph_minus.png"
                        tooltip="Remove column right" onClick={handleRemoveColumnRight}
                        colors={{ base: '#EAEAEA', hover: '#ef4444', pressed: '#b91c1c' }} margin={btnMargin} />

                    {Array.from({ length: state.gridConfig.cols }, (_, col) => (
                        <ColumnFrameMesh
                            key={`frame-col-${col}`}
                            col={col}
                            config={state.gridConfig}
                            modelOffset={state.modelOffset}
                            columnWidths={columnWidths}
                            enterFrom={frameEnterFrom}
                            animToken={frameAnimToken}
                            animateCol={frameAnimateCol}
                            animMode={frameAnimMode}
                        />
                    ))}

                    {/* <EffectComposer enableNormalPass>
                        <SSAO
                            samples={64}
                            radius={0.2}
                            intensity={1}
                            bias={0.025}
                            luminanceInfluence={0.1}
                        />
                    </EffectComposer> */}

                    {state.items.map(item => {
                        const isDragging = state.drag?.type === 'reposition' && state.drag.itemId === item.id
                        const previewCell = previewMap?.get(item.id)
                        return (
                            <GridItemMesh key={item.id} item={item} config={state.gridConfig}
                                isDragging={isDragging}
                                dragCell={isDragging ? state.drag?.currentCell : previewCell}
                                isSelected={state.selectedId === item.id}
                                isOutOfBounds={!inBounds(item, state.gridConfig)}
                                showBox={state.debug}
                                modelOffset={state.modelOffset}
                                isToggled={Boolean(toggledItems[item.id])}
                                columnWidths={columnWidths}
                                baseCellWidth={state.gridConfig.cellW}
                                immediatePosition={isResizingColumns}
                                onPointerDown={handleItemPointerDown}
                                onSelect={id => dispatch({ type: 'SET_SELECTED', id })}
                                onDoubleClick={id => dispatch({ type: 'MOVE_ITEMS', items: removeItemAndChildren(state.items, id) })}
                                onDelete={id => {
                                    dispatch({ type: 'MOVE_ITEMS', items: removeItemAndChildren(state.items, id) })
                                    dispatch({ type: 'SET_SELECTED', id: null })
                                }}
                                onToggleAnimation={handleToggleAnimation}
                            />
                        )
                    })}
                    {ghost && <GhostItem rect={ghost.rect} config={state.gridConfig} valid={ghost.valid} columnWidths={columnWidths} />}
                    <GridPlane config={state.gridConfig} onMove={handlePlaneMove} onUp={handlePlaneUp} columnWidths={columnWidths} />

                    <OrbitControls ref={controlsRef} enabled={!state.drag}
                        minPolarAngle={0.05} maxPolarAngle={Math.PI - 0.05} minDistance={3} maxDistance={30} />
                </Canvas>

                {/* Drag card that follows the pointer */}
                {state.drag?.type === 'from-palette' && (
                    <div ref={dragCardRef} style={S.dragCard}>
                        <img
                            src={palettePreviewSrc(state.drag.item)}
                            alt={state.drag.item.label}
                            style={S.dragCardImage}
                        />
                        <div style={S.dragCardLabel}>{state.drag.item.label}</div>
                    </div>
                )}

                {state.debug && (
                    <DebugOverlay occupancy={occupancy} drag={state.drag} ghost={ghost} config={state.gridConfig} />
                )}
            </div>
        </div>
    )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S: Record<string, CSSProperties> = {
    shell: { display: 'grid', gridTemplateColumns: '280px 1fr', height: '100vh', background: '#ffffff', color: '#0f172a', fontFamily: 'system-ui,sans-serif' },
    sidebar: { padding: '20px 18px', borderRight: '1px solid #e2e8f0', background: '#ffffff', display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' },
    sidebarHeader: { paddingBottom: 8, borderBottom: '1px solid #e2e8f0', marginBottom: 4 },
    brandTitle: { fontSize: 18, fontWeight: 700, letterSpacing: 1.5, color: '#ff9d62' },
    brandSub: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: '#64748b' },
    sectionTitle: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: '#475569', marginTop: 6 },
    fieldLabel: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: '#475569' },
    numInput: { padding: '6px 8px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#ffffff', color: '#0f172a', fontSize: 13 },
    paletteGrid: { display: 'flex', flexDirection: 'column', gap: 8 },
    paletteCard: { borderRadius: 10, padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderLeft: '3px solid #0f172a', textAlign: 'left', cursor: 'grab', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#0f172a' },
    paletteLabel: { fontSize: 13, fontWeight: 600 },
    paletteMeta: { fontSize: 11, color: '#64748b' },
    actionRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
    btn: { padding: '9px', borderRadius: 8, border: '1px solid #0284c7', background: '#0ea5e9', color: '#ffffff', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    btnGhost: { padding: '9px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#ffffff', color: '#334155', cursor: 'pointer', fontSize: 12 },
    exportBox: { marginTop: 4, minHeight: 100, fontSize: 10, padding: 8, borderRadius: 8, border: '1px solid #cbd5e1', background: '#ffffff', color: '#334155', resize: 'vertical' },
    hint: { fontSize: 10, color: '#64748b', marginTop: 'auto', paddingTop: 8 },
    canvasWrap: { position: 'relative' },
    canvas: { width: '100%', height: '100%' },
    dragCard: { position: 'fixed', left: 0, top: 0, transform: 'translate(-50%, 14px)', pointerEvents: 'none', zIndex: 20, width: 160, background: 'rgba(255,255,255,0.98)', border: '1px solid #cbd5e1', borderRadius: 12, padding: 8, color: '#0f172a', boxShadow: '0 12px 30px rgba(2,6,23,0.16)' },
    dragCardImage: { width: '100%', height: 90, objectFit: 'cover', borderRadius: 8, background: '#f1f5f9' },
    dragCardLabel: { marginTop: 6, fontSize: 11, fontWeight: 600, textAlign: 'center', color: '#0f172a' },
    deleteBtn: { width: 8, height: 8, borderRadius: 999, border: '1px solid #94a3b8', background: '#ffffff', color: '#0f172a', fontSize: 8, lineHeight: '4px', cursor: 'pointer', boxShadow: '0 6px 16px rgba(2,6,23,0.18)' },
    debugPanel: { position: 'absolute', right: 16, top: 16, width: 260, background: 'rgba(255,255,255,0.96)', color: '#0f172a', padding: 14, borderRadius: 12, fontSize: 10, fontFamily: 'monospace', maxHeight: '85vh', overflowY: 'auto', border: '1px solid #cbd5e1' },
    debugTitle: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 10, color: '#0ea5e9' },
    debugSection: { marginBottom: 12 },
    debugLabel: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: '#475569', marginBottom: 4 },
    debugCode: { margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 },
    occGrid: { display: 'grid', gap: 2 },
    occRow: { display: 'grid', gap: 2 },
    occCell: { border: '1px solid #e2e8f0', padding: '2px 3px', textAlign: 'center', fontSize: 9, borderRadius: 2 },
}
