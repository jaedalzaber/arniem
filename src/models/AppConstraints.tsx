'use client'

// AppConstraints.tsx
import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import { EffectComposer, SSAO } from '@react-three/postprocessing'
import { Suspense, useEffect, useRef } from 'react'
import * as THREE from 'three'
import GridSystem from '../lib/Grid/GridSystem'


// ─── Constraint logic (same as ConstraintSystem.tsx) ─────────────────────────
// paste or import your applyConstraint + helpers here, or import from the file:
import { applyConstraint } from '../lib/ConstraintSystem'
import { ModelFrame } from './unit_frame'
import { ModelDesk } from './unit_desk'
import { ModelLargeDoor } from './unit_large_door'
import { ModelLargeSmall } from './unit_large_small'
import { ModelOpenSmall } from './unit_open_small'
import { ModelPanelSmall } from './unit_panel_small'
import { ModelPegBoard } from './unit_pegboard'
import { ModelSmallDoor } from './unit_small_door'
import { ModelSmallPanel } from './unit_small_panel'


// ─── Wrapper that adds constraints + custom animation on top of Model ─────────
function ModelsWithConstraints() {
  const groupRef = useRef<THREE.Group>(null)

  // After the model mounts, build the nodeMap from the group's subtree
  const nodeMap = useRef<Map<string, THREE.Object3D>>(new Map())

  useEffect(() => {
    if (!groupRef.current) return
    groupRef.current.traverse((obj) => {
      // gltfjsx uses the `name` prop — Three.js sets obj.name from it
      nodeMap.current.set(obj.name, obj)
      // also index by userData.name (Blender dot-names like "Empty.004")
      if (obj.userData?.name) {
        nodeMap.current.set(obj.userData.name, obj)
      }
    })
  }, [])

  useFrame(() => {
    if (!groupRef.current) return
    const map = nodeMap.current

    // ── 1. Apply all userData constraints ──────────────────────────
    groupRef.current.traverse((obj) => {
      const raw = obj.userData?.constraints
      if (!raw) return
      try {
        const constraints = typeof raw === 'string' ? JSON.parse(raw) : raw
        for (const c of constraints) {
          applyConstraint(obj, c, map)
        }
      } catch (e) {
        console.warn('constraint parse error', obj.name, e)
      }
    })

    // ── 2. Your custom animations on named nodes ───────────────────
    const cBoxSx = map.get('c_scalx001')

    // if (cBoxSx) {
    //   // example: oscillate the whole box group on X scale
    //   const scale = 1 + Math.sin(Date.now() * 0.001) * 0.2
    //   cBoxSx.scale.x = scale
    // }

  })

  return (
    <group ref={groupRef}>
      <ModelFrame/>
      <ModelSmallPanel/>
    </group>
  )
}

// FrameWithConstraints moved to src/models/FrameWithConstraints.tsx

// ─── App ──────────────────────────────────────────────────────────────────────
export default function AppConstraints() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <GridSystem />

      {/* <Canvas camera={{ position: [0, 0.5, 2], fov: 50 }}>
        <ambientLight intensity={8} />
        <directionalLight position={[5, 5, 5]} intensity={5}/> 
        <Suspense fallback={null}>
          <ModelsWithConstraints />
        </Suspense>
        <EffectComposer enableNormalPass>
          <SSAO
            samples={64}
            radius={0.1}
            intensity={2}
            bias={0.025}
            luminanceInfluence={0.5}
          />
        </EffectComposer>
        <OrbitControls />
      </Canvas> */}
    </div>
  )
}
