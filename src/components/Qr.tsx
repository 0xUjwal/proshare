import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'

export function Qr({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) {
      QRCode.toCanvas(ref.current, value, { width: 168, margin: 1, color: { dark: '#0b0b12', light: '#ffffff' } })
    }
  }, [value])
  return <canvas ref={ref} className="rounded-xl bg-white p-1" width={168} height={168} />
}
