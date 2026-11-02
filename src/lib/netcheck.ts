// Diagnostic only. Gathers ICE candidates from two public STUN servers on one
// socket and compares the public port each reports. Different ports mean a
// "symmetric" NAT, where a direct peer-to-peer link usually cannot form
// without a relay. Nothing here is sent anywhere except the STUN requests
// WebRTC would make anyway; results stay in the page.
export type NetVerdict = 'checking' | 'ok' | 'strict' | 'none' | 'unsupported'

export function checkNetwork(): Promise<NetVerdict> {
  return new Promise(resolve => {
    if (typeof RTCPeerConnection === 'undefined') return resolve('unsupported')
    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] })
    } catch { return resolve('unsupported') }
    const ports = new Set<string>()
    let any = false
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try { pc.close() } catch { /* ignore */ }
      resolve(!any ? 'none' : ports.size > 1 ? 'strict' : 'ok')
    }
    pc.onicecandidate = e => {
      if (!e.candidate) return finish()
      const c = e.candidate
      if (c.type === 'srflx') { any = true; if (c.port != null) ports.add(String(c.port)) }
    }
    pc.createDataChannel('probe')
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => finish())
    setTimeout(finish, 6000)
  })
}
