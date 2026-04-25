/**
 * ConstraintSystem.tsx
 *
 * Reads Blender constraint data from glTF userData and applies
 * them every frame in React Three Fiber.
 *
 * Usage:
 *   <ConstraintScene url="/scene.glb" />
 *
 * Supported constraints:
 *   COPY_LOCATION, COPY_ROTATION, COPY_SCALE, COPY_TRANSFORMS,
 *   LIMIT_LOCATION, LIMIT_ROTATION, LIMIT_SCALE,
 *   TRACK_TO, DAMPED_TRACK, LOCKED_TRACK,
 *   CHILD_OF, FLOOR, TRANSFORM
 */
'use client'

import { useEffect, useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AxesFlags {
  x: boolean;
  y: boolean;
  z: boolean;
}

interface TargetRef {
  object: string;
  bone: string | null;
}

interface BaseConstraint {
  type: string;
  name: string;
  enabled: boolean;
  influence: number;
}

interface CopyLocationConstraint extends BaseConstraint {
  type: "COPY_LOCATION";
  target: TargetRef;
  use: AxesFlags;
  invert: AxesFlags;
  use_offset: boolean;
  owner_space: string;
  target_space: string;
}

interface CopyRotationConstraint extends BaseConstraint {
  type: "COPY_ROTATION";
  target: TargetRef;
  use: AxesFlags;
  invert: AxesFlags;
  use_offset: boolean;
  mix_mode: string;
  owner_space: string;
  target_space: string;
}

interface CopyScaleConstraint extends BaseConstraint {
  type: "COPY_SCALE";
  target: TargetRef;
  use: AxesFlags;
  use_offset: boolean;
  power: number;
  owner_space: string;
  target_space: string;
}

interface CopyTransformsConstraint extends BaseConstraint {
  type: "COPY_TRANSFORMS";
  target: TargetRef;
  mix_mode: string;
  owner_space: string;
  target_space: string;
}

interface LimitLocationConstraint extends BaseConstraint {
  type: "LIMIT_LOCATION";
  use_min: AxesFlags;
  use_max: AxesFlags;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  owner_space: string;
}

interface LimitRotationConstraint extends BaseConstraint {
  type: "LIMIT_ROTATION";
  use_limit: AxesFlags;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  owner_space: string;
}

interface LimitScaleConstraint extends BaseConstraint {
  type: "LIMIT_SCALE";
  use_min: AxesFlags;
  use_max: AxesFlags;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  owner_space: string;
}

interface TrackToConstraint extends BaseConstraint {
  type: "TRACK_TO";
  target: TargetRef;
  track_axis: string;
  up_axis: string;
  owner_space: string;
  target_space: string;
}

interface DampedTrackConstraint extends BaseConstraint {
  type: "DAMPED_TRACK";
  target: TargetRef;
  track_axis: string;
}

interface LockedTrackConstraint extends BaseConstraint {
  type: "LOCKED_TRACK";
  target: TargetRef;
  track_axis: string;
  lock_axis: string;
}

interface ChildOfConstraint extends BaseConstraint {
  type: "CHILD_OF";
  target: TargetRef;
  use_location: AxesFlags;
  use_rotation: AxesFlags;
  use_scale: AxesFlags;
}

interface FloorConstraint extends BaseConstraint {
  type: "FLOOR";
  target: TargetRef;
  floor_location: string;
  offset: number;
  use_rotation: boolean;
}

interface TransformConstraint extends BaseConstraint {
  type: "TRANSFORM";
  target: TargetRef;
  map_from: string;
  map_to: string;
  from_min_x: number; from_max_x: number;
  from_min_y: number; from_max_y: number;
  from_min_z: number; from_max_z: number;
  to_min_x: number; to_max_x: number;
  to_min_y: number; to_max_y: number;
  to_min_z: number; to_max_z: number;
}

type AnyConstraint =
  | CopyLocationConstraint | CopyRotationConstraint | CopyScaleConstraint
  | CopyTransformsConstraint | LimitLocationConstraint | LimitRotationConstraint
  | LimitScaleConstraint | TrackToConstraint | DampedTrackConstraint
  | LockedTrackConstraint | ChildOfConstraint | FloorConstraint
  | TransformConstraint;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const _pos = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();

const DEG2RAD = Math.PI / 180;

/** Resolve a TargetRef to a live Three.js Object3D */
function resolveTarget(
  ref: TargetRef,
  nodeMap: Map<string, THREE.Object3D>
): THREE.Object3D | null {
  const obj = nodeMap.get(ref.object);
  if (!obj) return null;
  if (ref.bone) {
    let bone: THREE.Object3D | null = null;
    obj.traverse((child) => {
      if (!bone && child.name === ref.bone) bone = child;
    });
    return bone;
  }
  return obj;
}

/** Map Blender track_axis string to a unit vector */
function trackAxisVector(axis: string): THREE.Vector3 {
  switch (axis) {
    case "TRACK_X":  return new THREE.Vector3(1, 0, 0);
    case "TRACK_Y":  return new THREE.Vector3(0, 1, 0);
    case "TRACK_Z":  return new THREE.Vector3(0, 0, 1);
    case "TRACK_NEGATIVE_X": return new THREE.Vector3(-1, 0, 0);
    case "TRACK_NEGATIVE_Y": return new THREE.Vector3(0, -1, 0);
    case "TRACK_NEGATIVE_Z": return new THREE.Vector3(0, 0, -1);
    default: return new THREE.Vector3(0, 0, 1);
  }
}

/** Map Blender up_axis string to a unit vector */
function upAxisVector(axis: string): THREE.Vector3 {
  switch (axis) {
    case "UP_X": return new THREE.Vector3(1, 0, 0);
    case "UP_Y": return new THREE.Vector3(0, 1, 0);
    case "UP_Z": return new THREE.Vector3(0, 0, 1);
    default: return new THREE.Vector3(0, 1, 0);
  }
}

/** Linearly remap value from [inMin, inMax] to [outMin, outMax] */
function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);
}

// ─── Constraint applicators ───────────────────────────────────────────────────

function applyCopyLocation(
  owner: THREE.Object3D,
  c: CopyLocationConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  tgt.getWorldPosition(_pos);

  const inv = c.invert;
  if (inv.x) _pos.x *= -1;
  if (inv.y) _pos.y *= -1;
  if (inv.z) _pos.z *= -1;

  const inf = c.influence;

  if (c.use_offset) {
    if (c.use.x) owner.position.x += _pos.x * inf;
    if (c.use.y) owner.position.y += _pos.y * inf;
    if (c.use.z) owner.position.z += _pos.z * inf;
  } else {
    // Convert world pos to parent local space
    const parentInv = new THREE.Matrix4();
    if (owner.parent) parentInv.copy(owner.parent.matrixWorld).invert();
    _pos.applyMatrix4(parentInv);

    if (c.use.x) owner.position.x = THREE.MathUtils.lerp(owner.position.x, _pos.x, inf);
    if (c.use.y) owner.position.y = THREE.MathUtils.lerp(owner.position.y, _pos.y, inf);
    if (c.use.z) owner.position.z = THREE.MathUtils.lerp(owner.position.z, _pos.z, inf);
  }
}

function applyCopyRotation(
  owner: THREE.Object3D,
  c: CopyRotationConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  tgt.getWorldQuaternion(_rot);
  _euler.setFromQuaternion(_rot);

  const inf = c.influence;
  const ownerEuler = new THREE.Euler().copy(owner.rotation);

  if (c.invert.x) _euler.x *= -1;
  if (c.invert.y) _euler.y *= -1;
  if (c.invert.z) _euler.z *= -1;

  if (c.use_offset) {
    if (c.use.x) owner.rotation.x += _euler.x * inf;
    if (c.use.y) owner.rotation.y += _euler.y * inf;
    if (c.use.z) owner.rotation.z += _euler.z * inf;
  } else {
    if (c.use.x) owner.rotation.x = THREE.MathUtils.lerp(ownerEuler.x, _euler.x, inf);
    if (c.use.y) owner.rotation.y = THREE.MathUtils.lerp(ownerEuler.y, _euler.y, inf);
    if (c.use.z) owner.rotation.z = THREE.MathUtils.lerp(ownerEuler.z, _euler.z, inf);
  }
}

function applyCopyScale(
  owner: THREE.Object3D,
  c: CopyScaleConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  tgt.getWorldScale(_scale);

  const inf = c.influence;
  const power = c.power ?? 1;

  const sx = Math.pow(_scale.x, power);
  const sy = Math.pow(_scale.y, power);
  const sz = Math.pow(_scale.z, power);

  if (c.use_offset) {
    if (c.use.x) owner.scale.x *= THREE.MathUtils.lerp(1, sx, inf);
    if (c.use.y) owner.scale.y *= THREE.MathUtils.lerp(1, sy, inf);
    if (c.use.z) owner.scale.z *= THREE.MathUtils.lerp(1, sz, inf);
  } else {
    if (c.use.x) owner.scale.x = THREE.MathUtils.lerp(owner.scale.x, sx, inf);
    if (c.use.y) owner.scale.y = THREE.MathUtils.lerp(owner.scale.y, sy, inf);
    if (c.use.z) owner.scale.z = THREE.MathUtils.lerp(owner.scale.z, sz, inf);
  }
}

function applyCopyTransforms(
  owner: THREE.Object3D,
  c: CopyTransformsConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  const inf = c.influence;
  tgt.getWorldPosition(_pos);
  tgt.getWorldQuaternion(_rot);
  tgt.getWorldScale(_scale);

  // Convert to local space
  if (owner.parent) {
    const parentInv = new THREE.Matrix4().copy(owner.parent.matrixWorld).invert();
    _pos.applyMatrix4(parentInv);
    const parentQuat = new THREE.Quaternion();
    owner.parent.getWorldQuaternion(parentQuat);
    _rot.premultiply(parentQuat.invert());
  }

  owner.position.lerp(_pos, inf);
  owner.quaternion.slerp(_rot, inf);
  owner.scale.lerp(_scale, inf);
}

function applyLimitLocation(owner: THREE.Object3D, c: LimitLocationConstraint) {
  const p = owner.position;
  if (c.use_min.x) p.x = Math.max(p.x, c.min.x);
  if (c.use_max.x) p.x = Math.min(p.x, c.max.x);
  if (c.use_min.y) p.y = Math.max(p.y, c.min.y);
  if (c.use_max.y) p.y = Math.min(p.y, c.max.y);
  if (c.use_min.z) p.z = Math.max(p.z, c.min.z);
  if (c.use_max.z) p.z = Math.min(p.z, c.max.z);
}

function applyLimitRotation(owner: THREE.Object3D, c: LimitRotationConstraint) {
  const r = owner.rotation;
  if (c.use_limit.x) r.x = THREE.MathUtils.clamp(r.x, c.min.x * DEG2RAD, c.max.x * DEG2RAD);
  if (c.use_limit.y) r.y = THREE.MathUtils.clamp(r.y, c.min.y * DEG2RAD, c.max.y * DEG2RAD);
  if (c.use_limit.z) r.z = THREE.MathUtils.clamp(r.z, c.min.z * DEG2RAD, c.max.z * DEG2RAD);
}

function applyLimitScale(owner: THREE.Object3D, c: LimitScaleConstraint) {
  const s = owner.scale;
  if (c.use_min.x) s.x = Math.max(s.x, c.min.x);
  if (c.use_max.x) s.x = Math.min(s.x, c.max.x);
  if (c.use_min.y) s.y = Math.max(s.y, c.min.y);
  if (c.use_max.y) s.y = Math.min(s.y, c.max.y);
  if (c.use_min.z) s.z = Math.max(s.z, c.min.z);
  if (c.use_max.z) s.z = Math.min(s.z, c.max.z);
}

function applyTrackTo(
  owner: THREE.Object3D,
  c: TrackToConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  tgt.getWorldPosition(_pos);
  owner.getWorldPosition(_dir);
  _dir.subVectors(_pos, _dir).normalize();

  const trackVec = trackAxisVector(c.track_axis);
  const upVec = upAxisVector(c.up_axis);

  const m = new THREE.Matrix4();
  m.lookAt(new THREE.Vector3(), _dir, upVec);

  const targetQuat = new THREE.Quaternion().setFromRotationMatrix(m);
  owner.quaternion.slerp(targetQuat, c.influence);
}

function applyDampedTrack(
  owner: THREE.Object3D,
  c: DampedTrackConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  tgt.getWorldPosition(_pos);
  owner.getWorldPosition(_dir);
  _dir.subVectors(_pos, _dir).normalize();

  const targetQuat = new THREE.Quaternion().setFromUnitVectors(
    trackAxisVector(c.track_axis),
    _dir
  );
  owner.quaternion.slerp(targetQuat, c.influence);
}

function applyLockedTrack(
  owner: THREE.Object3D,
  c: LockedTrackConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  tgt.getWorldPosition(_pos);
  owner.getWorldPosition(_dir);
  _dir.subVectors(_pos, _dir);

  // Zero out the locked axis component
  const lockAxis = trackAxisVector(c.lock_axis.replace("LOCK_", "TRACK_"));
  _dir.addScaledVector(lockAxis, -_dir.dot(lockAxis)).normalize();

  const targetQuat = new THREE.Quaternion().setFromUnitVectors(
    trackAxisVector(c.track_axis),
    _dir
  );
  owner.quaternion.slerp(targetQuat, c.influence);
}

function applyChildOf(
  owner: THREE.Object3D,
  c: ChildOfConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  tgt.updateWorldMatrix(true, false);
  _mat.copy(tgt.matrixWorld);
  _mat.decompose(_pos, _rot, _scale);

  const inf = c.influence;
  if (c.use_location.x) owner.position.x = THREE.MathUtils.lerp(owner.position.x, _pos.x, inf);
  if (c.use_location.y) owner.position.y = THREE.MathUtils.lerp(owner.position.y, _pos.y, inf);
  if (c.use_location.z) owner.position.z = THREE.MathUtils.lerp(owner.position.z, _pos.z, inf);

  if (c.use_rotation.x || c.use_rotation.y || c.use_rotation.z) {
    owner.quaternion.slerp(_rot, inf);
  }

  if (c.use_scale.x) owner.scale.x = THREE.MathUtils.lerp(owner.scale.x, _scale.x, inf);
  if (c.use_scale.y) owner.scale.y = THREE.MathUtils.lerp(owner.scale.y, _scale.y, inf);
  if (c.use_scale.z) owner.scale.z = THREE.MathUtils.lerp(owner.scale.z, _scale.z, inf);
}

function applyFloor(
  owner: THREE.Object3D,
  c: FloorConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  tgt.getWorldPosition(_pos);
  const floorY = _pos.y + c.offset;

  if (c.floor_location === "FLOOR_NEGATIVE_Y" || c.floor_location === "FLOOR_Y") {
    if (owner.position.y < floorY) owner.position.y = floorY;
  } else if (c.floor_location === "FLOOR_NEGATIVE_X" || c.floor_location === "FLOOR_X") {
    if (owner.position.x < _pos.x + c.offset) owner.position.x = _pos.x + c.offset;
  } else if (c.floor_location === "FLOOR_NEGATIVE_Z" || c.floor_location === "FLOOR_Z") {
    if (owner.position.z < _pos.z + c.offset) owner.position.z = _pos.z + c.offset;
  }
}

function applyTransform(
  owner: THREE.Object3D,
  c: TransformConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  const tgt = resolveTarget(c.target, nodeMap);
  if (!tgt) return;

  // Read source value from target
  let srcX = 0, srcY = 0, srcZ = 0;
  if (c.map_from === "LOCATION") {
    tgt.getWorldPosition(_pos);
    srcX = _pos.x; srcY = _pos.y; srcZ = _pos.z;
  } else if (c.map_from === "ROTATION") {
    tgt.getWorldQuaternion(_rot);
    _euler.setFromQuaternion(_rot);
    srcX = _euler.x; srcY = _euler.y; srcZ = _euler.z;
  } else if (c.map_from === "SCALE") {
    tgt.getWorldScale(_scale);
    srcX = _scale.x; srcY = _scale.y; srcZ = _scale.z;
  }

  const toX = remap(srcX, c.from_min_x, c.from_max_x, c.to_min_x, c.to_max_x);
  const toY = remap(srcY, c.from_min_y, c.from_max_y, c.to_min_y, c.to_max_y);
  const toZ = remap(srcZ, c.from_min_z, c.from_max_z, c.to_min_z, c.to_max_z);

  const inf = c.influence;
  if (c.map_to === "LOCATION") {
    owner.position.x = THREE.MathUtils.lerp(owner.position.x, toX, inf);
    owner.position.y = THREE.MathUtils.lerp(owner.position.y, toY, inf);
    owner.position.z = THREE.MathUtils.lerp(owner.position.z, toZ, inf);
  } else if (c.map_to === "ROTATION") {
    owner.rotation.x = THREE.MathUtils.lerp(owner.rotation.x, toX, inf);
    owner.rotation.y = THREE.MathUtils.lerp(owner.rotation.y, toY, inf);
    owner.rotation.z = THREE.MathUtils.lerp(owner.rotation.z, toZ, inf);
  } else if (c.map_to === "SCALE") {
    owner.scale.x = THREE.MathUtils.lerp(owner.scale.x, toX, inf);
    owner.scale.y = THREE.MathUtils.lerp(owner.scale.y, toY, inf);
    owner.scale.z = THREE.MathUtils.lerp(owner.scale.z, toZ, inf);
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

export function applyConstraint(
  owner: THREE.Object3D,
  c: AnyConstraint,
  nodeMap: Map<string, THREE.Object3D>
) {
  if (!c.enabled) return;

  switch (c.type) {
    case "COPY_LOCATION":    return applyCopyLocation(owner, c, nodeMap);
    case "COPY_ROTATION":    return applyCopyRotation(owner, c, nodeMap);
    case "COPY_SCALE":       return applyCopyScale(owner, c, nodeMap);
    case "COPY_TRANSFORMS":  return applyCopyTransforms(owner, c, nodeMap);
    case "LIMIT_LOCATION":   return applyLimitLocation(owner, c);
    case "LIMIT_ROTATION":   return applyLimitRotation(owner, c);
    case "LIMIT_SCALE":      return applyLimitScale(owner, c);
    case "TRACK_TO":         return applyTrackTo(owner, c, nodeMap);
    case "DAMPED_TRACK":     return applyDampedTrack(owner, c, nodeMap);
    case "LOCKED_TRACK":     return applyLockedTrack(owner, c, nodeMap);
    case "CHILD_OF":         return applyChildOf(owner, c, nodeMap);
    case "FLOOR":            return applyFloor(owner, c, nodeMap);
    case "TRANSFORM":        return applyTransform(owner, c, nodeMap);
    default:
      console.warn("[ConstraintSystem] Unknown constraint type:", (c as any).type);
  }
}

// ─── Scene component ──────────────────────────────────────────────────────────

interface ConstraintSceneProps {
  url: string;
}

export function ConstraintScene({ url }: ConstraintSceneProps) {
  const { scene } = useGLTF(url);

  /**
   * Build two maps:
   *   nodeMap   — name → Object3D (all nodes, for target lookup)
   *   constMap  — Object3D → parsed constraints[]
   */
  const { nodeMap, constMap } = useMemo(() => {
    const nodeMap = new Map<string, THREE.Object3D>();
    const constMap = new Map<THREE.Object3D, AnyConstraint[]>();

    scene.traverse((obj) => {
      nodeMap.set(obj.name, obj);

      const raw = (obj.userData as any).constraints;
      if (!raw) return;

      try {
        const parsed: AnyConstraint[] = typeof raw === "string"
          ? JSON.parse(raw)
          : raw;
        if (parsed.length > 0) {
          constMap.set(obj, parsed);
        }
      } catch (e) {
        console.warn(`[ConstraintSystem] Failed to parse constraints on "${obj.name}":`, e);
      }
    });

    return { nodeMap, constMap };
  }, [scene]);

  // Apply all constraints every frame
  useFrame(() => {
    // Update world matrices before reading positions
    scene.updateWorldMatrix(true, true);

    constMap.forEach((constraints, owner) => {
      for (const c of constraints) {
        applyConstraint(owner, c, nodeMap);
      }
    });
  });

  return <primitive object={scene} />;
}

