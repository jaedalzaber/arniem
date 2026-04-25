'use client'

import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { FrameModel } from './unit_frame'
import { applyConstraint } from '../lib/ConstraintSystem'

type FrameWithConstraintsProps = {
  targetHeight: number
  axis: 'XZ' | 'XY'
  position: [number, number, number]
  onMeasured?: (baseHeight: number, scaledWidth: number) => void
}

export function FrameWithConstraints({ targetHeight, axis, position, onMeasured }: FrameWithConstraintsProps) {
  const groupRef = useRef<THREE.Group>(null)
  const nodeMap = useRef<Map<string, THREE.Object3D>>(new Map())
  const [baseHeight, setBaseHeight] = useState<number | null>(null)
  const [baseWidth, setBaseWidth] = useState<number | null>(null)
  const [baseCenter, setBaseCenter] = useState<THREE.Vector3 | null>(null)

  useEffect(() => {
    if (!groupRef.current) return
    groupRef.current.traverse((obj) => {
      nodeMap.current.set(obj.name, obj)
      if (obj.userData?.name) {
        nodeMap.current.set(obj.userData.name, obj)
      }
    })
  }, [])

  useEffect(() => {
    let tries = 0
    let raf = 0
    const measure = () => {
      const group = groupRef.current
      if (!group) return
      group.updateWorldMatrix(true, true)
      const box = new THREE.Box3().setFromObject(group)
      const size = new THREE.Vector3()
      const center = new THREE.Vector3()
      box.getSize(size)
      box.getCenter(center)
      const scale = group.scale.x || 1
      const measuredHeight = (axis === 'XZ' ? size.z : size.y) / scale
      const measuredWidth = size.x / scale
      if (measuredHeight > 0.0001 && measuredWidth > 0.0001) {
        setBaseHeight(measuredHeight)
        setBaseWidth(measuredWidth)
        setBaseCenter(center.clone().multiplyScalar(1 / scale))
        const uniformScale = targetHeight / measuredHeight
        onMeasured?.(measuredHeight, measuredWidth * uniformScale)
        return
      }
      tries += 1
      if (tries < 10) raf = requestAnimationFrame(measure)
    }
    raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [axis, onMeasured, targetHeight])

  useFrame(() => {
    if (!groupRef.current) return
    const map = nodeMap.current

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
  })

  const scale = baseHeight ? targetHeight / baseHeight : 1
  const scaledCenter = baseCenter
    ? new THREE.Vector3(baseCenter.x * scale, baseCenter.y * scale, baseCenter.z * scale)
    : new THREE.Vector3()
  const anchoredPos: [number, number, number] = [
    position[0] - scaledCenter.x,
    position[1] - scaledCenter.y,
    position[2] - scaledCenter.z,
  ]
  const rotation: [number, number, number] = axis === 'XY' ? [-Math.PI / 2, 0, 0] : [0, 0, 0]

  return (
    <group
      ref={groupRef}
      scale={[scale, scale, scale]}
      position={anchoredPos}
      rotation={rotation}
    >
      <FrameModel />
    </group>
  )
}
