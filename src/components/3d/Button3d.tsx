'use client'

import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { Html } from '@react-three/drei'
import { useLoader } from '@react-three/fiber'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// 3D button with hover/press states + white texture icon
export const Button3D = ({
  position,
  size,
  onClick,
  textureUrl,
  colors,
  margin = 0,
  tooltip,
}: {
  position: [number, number, number]
  size: [number, number, number]
  onClick: () => void
  textureUrl: string
  colors?: {
    base?: string
    hover?: string
    pressed?: string
  }
  margin?: number
  tooltip?: string
}) => {
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  const texture = useLoader(THREE.TextureLoader, textureUrl)
  const baseColor = colors?.base ?? '#0f172a'
  const hoverColor = colors?.hover ?? '#1d4ed8'
  const pressedColor = colors?.pressed ?? '#2563eb'
  const color = pressed ? pressedColor : hovered ? hoverColor : baseColor
  const shader = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: texture },
          uColor: { value: new THREE.Color(color).convertSRGBToLinear() },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            vec4 tex = texture2D(uMap, vUv);
            float alpha = tex.a;
            vec3 texColor = pow(tex.rgb, vec3(2.2));
            vec3 tinted = uColor * texColor;
            gl_FragColor = vec4(tinted, alpha);
          }
        `,
        transparent: true,
      }),
    [texture],
  )

  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
  }, [texture])

  useEffect(() => {
    shader.uniforms.uColor.value.set(color).convertSRGBToLinear()
  }, [color, shader])
  const showTooltip = Boolean(tooltip)

  return (
    <group position={position}>
      <mesh
        onPointerOver={e => { e.stopPropagation(); setHovered(true) }}
        onPointerOut={e => { e.stopPropagation(); setHovered(false); setPressed(false) }}
        onPointerDown={e => { e.stopPropagation(); setPressed(true) }}
        onPointerUp={e => { e.stopPropagation(); setPressed(false); onClick() }}
      >
        <planeGeometry args={[Math.max(0.001, size[0] - margin * 2), Math.max(0.001, size[1] - margin * 2)]} />
        <primitive object={shader} attach="material" />
      </mesh>
      {showTooltip && (
        <Html position={[0, size[1] * 0.7, 0]} center pointerEvents="none">
          <TooltipProvider>
            <Tooltip open={hovered}>
              <TooltipTrigger asChild>
                <span style={{ display: 'inline-block', width: 8, height: 8 }} />
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                {tooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Html>
      )}
    </group>
  )
}
