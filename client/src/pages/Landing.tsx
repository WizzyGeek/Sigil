import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import FreshnessLock from '../components/FreshnessLock'
import type { FreshnessScore } from '../types/protocol'

function DiamondLogo({ size = 13 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        background: 'linear-gradient(135deg,#e8cf94,#c79a4f)',
        transform: 'rotate(45deg)',
        borderRadius: 2,
        boxShadow: '0 0 14px rgba(214,176,106,0.6)',
        flexShrink: 0,
      }}
    />
  )
}

// ─── Canvas relay animation — faithful port of the design's DCLogic ───────────

function RelayCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    let W = 0, H = 0
    let rafId = 0

    interface Pt { x: number; y: number }
    interface Conn { pts: Pt[]; cum: number[]; total: number }
    interface UserNode {
      x: number; y: number; r: number
      icon: 'person' | 'monitor'
      port: { x: number; y: number; approach: 'v' | 'h' }
      pulse: { start: number; dur: number; gold: boolean } | null
    }
    interface RelayBox { cx: number; cy: number; x: number; y: number; w: number; h: number }

    let relay!: RelayBox
    let users: UserNode[] = []
    let conns: Conn[] = []

    const PAUSE = 800, TRAVEL = 1400, RFLASH = 300, EMITP = 300, ARRP = 200
    const GLOW = 0.5
    let phase: 'pause' | 'inbound' | 'outbound' = 'pause'
    let phaseStart = performance.now()
    let chosen = 0
    let relayFlash = -9999

    // Build a bent path from S to E, bending at a right-angle corner
    function buildPath(S: Pt, E: Pt, approach: 'v' | 'h'): Conn {
      const C = approach === 'v' ? { x: E.x, y: S.y } : { x: S.x, y: E.y }
      const d1 = Math.hypot(C.x - S.x, C.y - S.y), d2 = Math.hypot(E.x - C.x, E.y - C.y)
      const rad = Math.min(10, d1 * 0.5, d2 * 0.5) || 0
      const u1 = d1 > 0 ? { x: (C.x - S.x) / d1, y: (C.y - S.y) / d1 } : { x: 0, y: 0 }
      const u2 = d2 > 0 ? { x: (E.x - C.x) / d2, y: (E.y - C.y) / d2 } : { x: 0, y: 0 }
      const P1 = { x: C.x - u1.x * rad, y: C.y - u1.y * rad }
      const P2 = { x: C.x + u2.x * rad, y: C.y + u2.y * rad }
      const pts: Pt[] = [S, P1]
      for (let k = 1; k <= 6; k++) {
        const tt = k / 7, it = 1 - tt
        pts.push({ x: it*it*P1.x + 2*it*tt*C.x + tt*tt*P2.x, y: it*it*P1.y + 2*it*tt*C.y + tt*tt*P2.y })
      }
      pts.push(P2, E)
      const cum: number[] = [0]
      for (let k = 1; k < pts.length; k++)
        cum[k] = cum[k-1] + Math.hypot(pts[k].x - pts[k-1].x, pts[k].y - pts[k-1].y)
      return { pts, cum, total: cum[cum.length - 1] || 1 }
    }

    function pathAt(c: Conn, u: number): Pt {
      u = Math.max(0, Math.min(1, u))
      const s = u * c.total
      for (let k = 1; k < c.pts.length; k++) {
        if (s <= c.cum[k] || k === c.pts.length - 1) {
          const seg = (c.cum[k] - c.cum[k-1]) || 1
          const f = (s - c.cum[k-1]) / seg
          return { x: c.pts[k-1].x + (c.pts[k].x - c.pts[k-1].x)*f, y: c.pts[k-1].y + (c.pts[k].y - c.pts[k-1].y)*f }
        }
      }
      return c.pts[c.pts.length - 1]
    }

    function strokePts(pts: Pt[]) {
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y)
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y)
      ctx.stroke()
    }

    function rrect(x: number, y: number, w: number, h: number, r: number) {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r)
    }

    function build() {
      W = canvas!.parentElement?.offsetWidth ?? Math.round(window.innerWidth / 2)
      H = canvas!.parentElement?.offsetHeight ?? window.innerHeight
      W = Math.max(W, 1); H = Math.max(H, 1)
      canvas!.width = W * dpr; canvas!.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const cx0 = W / 2, cy0 = Math.max(H * 0.47, 250)
      const rw = 92, rh = 64
      relay = { cx: cx0, cy: cy0, x: cx0 - rw/2, y: cy0 - rh/2, w: rw, h: rh }

      // Dedicated ports on relay edges
      const ports: UserNode['port'][] = [
        { x: relay.cx - rw * 0.24, y: relay.y,           approach: 'v' },
        { x: relay.x + rw,         y: relay.cy - rh*0.27, approach: 'h' },
        { x: relay.x + rw,         y: relay.cy + rh*0.27, approach: 'h' },
        { x: relay.cx + rw * 0.24, y: relay.y + rh,       approach: 'v' },
        { x: relay.x,              y: relay.cy,            approach: 'h' },
      ]

      const Rx = Math.min(W * 0.34, 400), Ry = Math.min(H * 0.38, 300)
      const angs = [-112, -36, 33, 87, 182].map(d => d * Math.PI / 180)
      const icons: ('person' | 'monitor')[] = ['person', 'monitor', 'person', 'monitor', 'person']

      users = angs.map((a, i) => {
        let x = cx0 + Math.cos(a) * Rx, y = cy0 + Math.sin(a) * Ry
        x = Math.max(72, Math.min(W - 72, x))
        y = Math.max(122, Math.min(H - 60, y))
        return { x, y, r: 23, icon: icons[i], port: ports[i], pulse: null }
      })

      conns = users.map(u => buildPath({ x: u.x, y: u.y }, { x: u.port.x, y: u.port.y }, u.port.approach))
    }

    function drawPacket(conn: Conn, prog: number, dir: 'in' | 'out') {
      const uu = dir === 'in' ? prog : 1 - prog
      const pos = pathAt(conn, uu)
      const tail = pathAt(conn, dir === 'in' ? uu - 0.08 : uu + 0.08)
      const col = dir === 'in' ? '232,239,255' : '232,206,128'
      const k = dir === 'in' ? 1 : 0.6

      const rg = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 16)
      rg.addColorStop(0, `rgba(${col},${0.42 * k})`)
      rg.addColorStop(1, `rgba(${col},0)`)
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(pos.x, pos.y, 16, 0, Math.PI*2); ctx.fill()

      const lg = ctx.createLinearGradient(tail.x, tail.y, pos.x, pos.y)
      lg.addColorStop(0, `rgba(${col},0)`)
      lg.addColorStop(1, `rgba(${col},${0.6 * k})`)
      ctx.strokeStyle = lg; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(pos.x, pos.y); ctx.stroke()

      ctx.fillStyle = `rgba(255,255,255,${0.85 * k + 0.12})`
      ctx.beginPath(); ctx.arc(pos.x, pos.y, 2, 0, Math.PI*2); ctx.fill()
    }

    function drawUserIcon(u: UserNode) {
      ctx.strokeStyle = 'rgba(226,231,242,0.78)'; ctx.lineWidth = 1.4
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      if (u.icon === 'person') {
        ctx.beginPath(); ctx.arc(u.x, u.y - 6, 4.2, 0, Math.PI*2); ctx.stroke()
        ctx.beginPath(); ctx.arc(u.x, u.y + 12, 8.5, Math.PI, 2*Math.PI); ctx.stroke()
      } else {
        rrect(u.x - 9.5, u.y - 8, 19, 13, 1.6); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(u.x, u.y + 5); ctx.lineTo(u.x, u.y + 8); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(u.x - 4.5, u.y + 8); ctx.lineTo(u.x + 4.5, u.y + 8); ctx.stroke()
      }
    }

    function draw() {
      const now = performance.now()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#05050a'; ctx.fillRect(0, 0, W, H)
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'

      // Ambient warm-gold glow (always on)
      ctx.globalCompositeOperation = 'lighter'
      const amb = ctx.createRadialGradient(relay.cx, relay.cy, 0, relay.cx, relay.cy, Math.min(W, H) * 0.72)
      amb.addColorStop(0, `rgba(201,168,76,${0.14 * GLOW})`)
      amb.addColorStop(0.5, `rgba(201,168,76,${0.05 * GLOW})`)
      amb.addColorStop(1, 'rgba(201,168,76,0)')
      ctx.fillStyle = amb; ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'source-over'

      // State machine
      const t = now - phaseStart
      if (phase === 'pause') {
        if (t >= PAUSE) {
          chosen = Math.floor(Math.random() * 5)
          users[chosen].pulse = { start: now, dur: EMITP, gold: false }
          phase = 'inbound'; phaseStart = now
        }
      } else if (phase === 'inbound') {
        if (t >= TRAVEL) { relayFlash = now; phase = 'outbound'; phaseStart = now }
      } else if (phase === 'outbound') {
        if (t >= TRAVEL) {
          users.forEach(u => { u.pulse = { start: now, dur: ARRP, gold: true } })
          phase = 'pause'; phaseStart = now
        }
      }
      const inbound = phase === 'inbound', outbound = phase === 'outbound'
      const prog = (inbound || outbound) ? Math.min(1, t / TRAVEL) : 0

      // Connection paths
      conns.forEach((c, i) => {
        const on = (inbound && i === chosen) || outbound
        if (on) {
          ctx.globalCompositeOperation = 'lighter'
          ctx.strokeStyle = 'rgba(185,200,240,0.11)'; ctx.lineWidth = 5; strokePts(c.pts)
          ctx.globalCompositeOperation = 'source-over'
        }
        ctx.strokeStyle = on ? 'rgba(185,200,240,0.28)' : 'rgba(150,160,185,0.15)'
        ctx.lineWidth = on ? 1.2 : 0.8; strokePts(c.pts)
      })

      // Relay glow + body
      const flash = Math.max(0, 1 - (now - relayFlash) / RFLASH)
      ctx.globalCompositeOperation = 'lighter'
      const rg = ctx.createRadialGradient(relay.cx, relay.cy, 0, relay.cx, relay.cy, relay.w * 1.6)
      rg.addColorStop(0, `rgba(212,180,90,${0.10 + 0.3 * flash})`)
      rg.addColorStop(1, 'rgba(212,180,90,0)')
      ctx.fillStyle = rg
      ctx.fillRect(relay.cx - relay.w*1.7, relay.cy - relay.h*1.9, relay.w*3.4, relay.h*3.8)
      ctx.globalCompositeOperation = 'source-over'

      ctx.fillStyle = 'rgba(9,9,16,0.92)'; rrect(relay.x, relay.y, relay.w, relay.h, 7); ctx.fill()
      ctx.strokeStyle = `rgba(214,182,92,${0.5 + 0.5 * flash})`; ctx.lineWidth = 1.7
      rrect(relay.x, relay.y, relay.w, relay.h, 7); ctx.stroke()

      ctx.strokeStyle = `rgba(220,188,104,${0.55 + 0.4 * flash})`; ctx.lineWidth = 1.3
      for (let i = 0; i < 3; i++) {
        const yy = relay.cy - 15 + i * 15
        rrect(relay.cx - 17, yy - 4.5, 34, 9, 2); ctx.stroke()
        ctx.fillStyle = `rgba(236,210,132,${0.7 + 0.3 * flash})`
        ctx.beginPath(); ctx.arc(relay.cx - 11, yy, 1.5, 0, Math.PI*2); ctx.fill()
      }

      // Packets
      ctx.globalCompositeOperation = 'lighter'
      if (inbound) drawPacket(conns[chosen], prog, 'in')
      else if (outbound) conns.forEach(c => drawPacket(c, prog, 'out'))
      ctx.globalCompositeOperation = 'source-over'

      // User nodes
      users.forEach(u => {
        const pl = u.pulse ? Math.max(0, 1 - (now - u.pulse.start) / (u.pulse.gold ? ARRP : EMITP)) : 0
        const col = (u.pulse?.gold) ? '236,210,132' : '232,239,255'
        if (pl > 0.01) {
          ctx.globalCompositeOperation = 'lighter'
          const g = ctx.createRadialGradient(u.x, u.y, 0, u.x, u.y, u.r * 2.4)
          g.addColorStop(0, `rgba(${col},${0.45 * pl})`); g.addColorStop(1, `rgba(${col},0)`)
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(u.x, u.y, u.r*2.4, 0, Math.PI*2); ctx.fill()
          ctx.globalCompositeOperation = 'source-over'
        }
        ctx.fillStyle = 'rgba(8,8,13,0.95)'
        ctx.beginPath(); ctx.arc(u.x, u.y, u.r, 0, Math.PI*2); ctx.fill()
        ctx.strokeStyle = `rgba(192,200,216,${0.4 + 0.5 * pl})`; ctx.lineWidth = 1.2
        ctx.beginPath(); ctx.arc(u.x, u.y, u.r, 0, Math.PI*2); ctx.stroke()
        drawUserIcon(u)
      })

      rafId = requestAnimationFrame(draw)
    }

    const onResize = () => build()
    window.addEventListener('resize', onResize)
    requestAnimationFrame(() => { build(); draw() })

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    />
  )
}

// ─── Static content ────────────────────────────────────────────────────────────

const FRESHNESS_ROWS: Array<{ score: FreshnessScore; desc: string }> = [
  { score: 5, desc: 'Stake fetched moments before signing — strongest proof' },
  { score: 4, desc: 'Normal network latency — strong' },
  { score: 3, desc: 'Short delay — good' },
  { score: 2, desc: 'Stake reused across notes — weaker' },
  { score: 1, desc: 'Old stake — treat with caution' },
]

export default function Landing() {
  const navigate = useNavigate()

  useEffect(() => {
    document.documentElement.style.overflow = 'auto'
    document.body.style.overflow = 'auto'
    document.body.style.height = 'auto'
    return () => {
      document.documentElement.style.overflow = ''
      document.body.style.overflow = ''
      document.body.style.height = ''
    }
  }, [])

  return (
    <div style={{ minHeight: '100vh', fontFamily: "'Space Grotesk',system-ui,sans-serif", color: '#f4f1ea', background: '#000' }}>

      {/* Nav */}
      <nav style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 20,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 40px', height: 64,
        background: 'linear-gradient(180deg,rgba(0,0,0,0.85),rgba(0,0,0,0))',
        backdropFilter: 'blur(8px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <DiamondLogo />
          <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: 4, color: '#f4f1ea' }}>SIGIL</span>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: 'rgba(255,255,255,0.3)', letterSpacing: 0.4, marginLeft: 2 }}>
            decentralized notes protocol
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <button
            onClick={() => navigate('/app')}
            style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.6)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'JetBrains Mono',monospace" }}
            onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.9)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
          >
            Sign In
          </button>
          <button
            onClick={() => navigate('/onboarding')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 18px',
              borderRadius: 10, border: '1px solid rgba(214,176,106,0.55)',
              background: 'linear-gradient(180deg,rgba(214,176,106,0.14),rgba(214,176,106,0.05))',
              color: '#f0dcab', fontFamily: "'JetBrains Mono',monospace", fontSize: 12, letterSpacing: 0.5,
              cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(214,176,106,0.24)'; e.currentTarget.style.color = '#fbeccb' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(180deg,rgba(214,176,106,0.14),rgba(214,176,106,0.05))'; e.currentTarget.style.color = '#f0dcab' }}
          >
            GET STARTED
          </button>
        </div>
      </nav>

      {/* Hero — full viewport, split left/right */}
      <section style={{ height: '100vh', display: 'flex', flexDirection: 'row', alignItems: 'stretch' }}>

        {/* Left: content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', padding: '88px 56px 48px', overflowY: 'auto' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 15px',
            borderRadius: 100, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)',
            fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: 'rgba(255,255,255,0.45)',
            letterSpacing: 0.5, marginBottom: 38, alignSelf: 'flex-start',
            animation: 'sgFade 0.8s ease both',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#d6b06a', animation: 'sgPulse 1.9s ease-in-out infinite', boxShadow: '0 0 8px rgba(214,176,106,0.7)' }} />
            open protocol · no accounts · no servers
          </div>

          <h1 style={{
            margin: 0, fontWeight: 700, fontSize: 64, lineHeight: 1.04, letterSpacing: -2,
            color: '#f6f3ec', textWrap: 'balance' as never,
            animation: 'sgUp 0.7s cubic-bezier(0.22,1,0.36,1) 0.1s both',
          }}>
            No servers.<br />No algorithms.<br />
            <span style={{ color: 'rgba(255,255,255,0.45)' }}>Just math.</span>
          </h1>

          <p style={{
            maxWidth: 460, margin: '26px 0 0', fontSize: 17, lineHeight: 1.62, color: 'rgba(255,255,255,0.58)',
            animation: 'sgUp 0.7s cubic-bezier(0.22,1,0.36,1) 0.18s both',
          }}>
            SIGIL is a cryptographically signed, decentralized notes protocol. Every note is signed by your private key. Every identity is verified by math. No company stores your words.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 38, animation: 'sgUp 0.7s cubic-bezier(0.22,1,0.36,1) 0.26s both' }}>
            <button
              onClick={() => navigate('/onboarding')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 10, height: 52, padding: '0 28px',
                borderRadius: 13, border: '1px solid rgba(214,176,106,0.6)',
                background: 'linear-gradient(180deg,rgba(214,176,106,0.26),rgba(214,176,106,0.11))',
                color: '#f7e6bd', fontFamily: "'JetBrains Mono',monospace", fontWeight: 500, fontSize: 13, letterSpacing: 0.8,
                cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(214,176,106,0.34)'; e.currentTarget.style.boxShadow = '0 0 26px rgba(214,176,106,0.22)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(180deg,rgba(214,176,106,0.26),rgba(214,176,106,0.11))'; e.currentTarget.style.boxShadow = 'none' }}
            >
              GENERATE YOUR IDENTITY
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
            </button>
            <button
              style={{
                display: 'inline-flex', alignItems: 'center', height: 52, padding: '0 28px',
                borderRadius: 13, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.04)',
                color: 'rgba(255,255,255,0.75)', fontFamily: "'JetBrains Mono',monospace", fontSize: 13, letterSpacing: 0.8, cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#f4f1ea' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.75)' }}
            >
              READ THE PROTOCOL
            </button>
          </div>

          <p style={{ marginTop: 20, fontFamily: "'JetBrains Mono',monospace", fontSize: 11.5, color: 'rgba(255,255,255,0.28)', animation: 'sgFade 1s ease 0.5s both' }}>
            Your private key never leaves your device.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 48, flexWrap: 'wrap', animation: 'sgFade 1s ease 0.6s both' }}>
            {['0 servers store your notes', 'RSA-2048 signed, every note', 'Federated — run your own relay'].map(s => (
              <div key={s} style={{ padding: '9px 16px', borderRadius: 100, border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.03)', backdropFilter: 'blur(10px)', fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                {s}
              </div>
            ))}
          </div>
        </div>

        {/* Right: canvas */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <RelayCanvas />
        </div>
      </section>

      {/* How SIGIL Works */}
      <section id="protocol" style={{ padding: '100px 40px', background: 'rgba(255,255,255,0.018)' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <h2 style={{ textAlign: 'center', margin: '0 0 70px', fontWeight: 700, fontSize: 40, letterSpacing: -0.8, color: '#f6f3ec' }}>How SIGIL Works</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16 }}>

            {[
              {
                n: '01', title: 'Your Identity',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="8" r="5" stroke="#d6b06a" strokeWidth="1.5" /><circle cx="8" cy="8" r="2" fill="#d6b06a" opacity="0.6" /><path d="M13 8h7M17 8v3" stroke="#d6b06a" strokeWidth="1.5" strokeLinecap="round" /></svg>,
                desc: 'Generate an RSA keypair on your device. Your private key never leaves. Your public key is your fingerprint.',
                visual: <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: 'rgba(214,176,106,0.5)', animation: 'sgHashFade 3s ease-in-out infinite', wordBreak: 'break-all' }}>sha256:a3f9·8c12<br />44bd·e721...</div>,
              },
              {
                n: '02', title: 'Your Stake',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#d6b06a" strokeWidth="1.5" /><path d="M8 12l3 3 5-6" stroke="#d6b06a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
                desc: 'A registry signs your public key, issuing a short-lived stake — proof your key was valid at a specific moment in time.',
                visual: <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 100, border: '1px solid rgba(214,176,106,0.35)', background: 'rgba(214,176,106,0.06)', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: 'rgba(214,176,106,0.7)' }}>✓ ENDORSED · 14:02:31Z</div>,
              },
              {
                n: '03', title: 'Your Note',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="18" rx="2" stroke="#d6b06a" strokeWidth="1.5" /><path d="M8 8h8M8 12h8M8 16h5" stroke="#d6b06a" strokeWidth="1.5" strokeLinecap="round" /></svg>,
                desc: 'Your note and stake are wrapped into a Unified Note Token — a self-contained JWT. Anyone can verify it without a server.',
                visual: (
                  <div style={{ position: 'relative', width: 72, height: 72, margin: 'auto' }}>
                    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1px solid rgba(214,176,106,0.4)' }} />
                    <div style={{ position: 'absolute', inset: 16, borderRadius: '50%', border: '1px solid rgba(214,176,106,0.22)' }} />
                    <span style={{ position: 'absolute', top: -1, left: '50%', transform: 'translateX(-50%)', fontFamily: "'JetBrains Mono',monospace", fontSize: 7, color: 'rgba(214,176,106,0.55)', whiteSpace: 'nowrap' }}>outer.iat</span>
                    <span style={{ position: 'absolute', top: 22, left: '50%', transform: 'translateX(-50%)', fontFamily: "'JetBrains Mono',monospace", fontSize: 7, color: 'rgba(214,176,106,0.4)', whiteSpace: 'nowrap' }}>inner</span>
                  </div>
                ),
              },
              {
                n: '04', title: 'The Network',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="5" r="2.5" fill="#d6b06a" opacity="0.85" /><circle cx="4" cy="19" r="2" fill="#d6b06a" opacity="0.55" /><circle cx="20" cy="19" r="2" fill="#d6b06a" opacity="0.55" /><circle cx="12" cy="19" r="2" fill="#d6b06a" opacity="0.55" /><path d="M12 7.5L4 17M12 7.5L12 17M12 7.5L20 17" stroke="#d6b06a" strokeWidth="0.9" opacity="0.35" /></svg>,
                desc: "Brokers fan your note out to listeners. Every client independently verifies the proof. Brokers can't forge — the math won't allow it.",
                visual: <svg width="80" height="44" viewBox="0 0 80 44" fill="none"><circle cx="40" cy="8" r="3" fill="#d6b06a" opacity="0.7" /><circle cx="10" cy="38" r="2.5" fill="#d6b06a" opacity="0.45" /><circle cx="40" cy="38" r="2.5" fill="#d6b06a" opacity="0.45" /><circle cx="70" cy="38" r="2.5" fill="#d6b06a" opacity="0.45" /><line x1="40" y1="11" x2="10" y2="35" stroke="#d6b06a" strokeWidth="0.8" opacity="0.3" /><line x1="40" y1="11" x2="40" y2="35" stroke="#d6b06a" strokeWidth="0.8" opacity="0.3" /><line x1="40" y1="11" x2="70" y2="35" stroke="#d6b06a" strokeWidth="0.8" opacity="0.3" /></svg>,
              },
            ].map(({ n, title, icon, desc, visual }) => (
              <div key={n} style={{ padding: '28px 22px 26px', borderRadius: 18, background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 11, border: '1px solid rgba(214,176,106,0.3)', background: 'rgba(214,176,106,0.07)', marginBottom: 18 }}>{icon}</div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: 'rgba(214,176,106,0.6)', letterSpacing: 1, marginBottom: 10 }}>{n}</div>
                <h3 style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 17, color: '#f6f3ec' }}>{title}</h3>
                <p style={{ margin: '0 0 20px', fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.55)' }}>{desc}</p>
                {visual}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 28, padding: '22px 28px', borderRadius: 16, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(214,176,106,0.22)', boxShadow: '0 0 30px rgba(214,176,106,0.05)' }}>
            <p style={{ margin: 'auto', fontSize: 15, lineHeight: 1.65, color: 'rgba(255,255,255,0.65)', textAlign: 'center', maxWidth: 760, fontStyle: 'italic' }}>
              "Unlike traditional platforms, SIGIL servers are cryptographically incapable of lying about authorship. Your note either verifies — or it doesn't."
            </p>
          </div>
        </div>
      </section>

      {/* Why this matters */}
      <section style={{ padding: '100px 40px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <h2 style={{ textAlign: 'center', margin: '0 0 60px', fontWeight: 700, fontSize: 40, letterSpacing: -0.8, color: '#f6f3ec' }}>Why this matters</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18 }}>
            {[
              {
                title: 'You own your identity',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2l7 4v6c0 5-3.5 9-7 10C8.5 21 5 17 5 12V6l7-4z" stroke="#d6b06a" strokeWidth="1.5" strokeLinejoin="round" /></svg>,
                desc: 'Your identity is a keypair you generate. No account. No email required. No company can delete you, ban you, or hand your data to anyone. If you hold the key, you are you.',
              },
              {
                title: 'Notes are unforgeable',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M7 10V8a5 5 0 0 1 10 0v2" stroke="#d6b06a" strokeWidth="1.5" strokeLinecap="round" /><rect x="4.5" y="10" width="15" height="10" rx="2.2" stroke="#d6b06a" strokeWidth="1.5" /><path d="M9 16l2 2 4-4" stroke="#d6b06a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
                desc: 'Every note carries a cryptographic signature. Tamper with one byte and the signature breaks. There is no moderation layer that can silently edit what you said.',
              },
              {
                title: 'The network has no owner',
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#d6b06a" strokeWidth="1.5" /><path d="M2 12h20M12 2c-3 4-4 6-4 10s1 6 4 10M12 2c3 4 4 6 4 10s-1 6-4 10" stroke="#d6b06a" strokeWidth="1" opacity="0.6" /></svg>,
                desc: 'Anyone can run a relay broker. Anyone can run a registry. SIGIL is a protocol, not a platform. No company controls it. No single server can take it down.',
              },
            ].map(({ title, icon, desc }) => (
              <div key={title} style={{ padding: '30px 26px 32px', borderRadius: 18, background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 11, border: '1px solid rgba(214,176,106,0.3)', background: 'rgba(214,176,106,0.07)', marginBottom: 22 }}>{icon}</div>
                <h3 style={{ margin: '0 0 13px', fontWeight: 600, fontSize: 20, color: '#f6f3ec' }}>{title}</h3>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: 'rgba(255,255,255,0.55)' }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Cryptographic Freshness */}
      <section style={{ padding: '80px 40px 100px', background: 'rgba(255,255,255,0.018)' }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <h2 style={{ margin: 0, fontWeight: 700, fontSize: 36, letterSpacing: -0.6, color: '#f6f3ec' }}>Cryptographic Freshness</h2>
          <p style={{ margin: '12px 0 48px', fontSize: 16, color: 'rgba(255,255,255,0.55)' }}>Every note carries a score showing how fresh its proof of identity was at the moment of signing.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {FRESHNESS_ROWS.map(({ score, desc }) => (
              <div key={score} style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '16px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <FreshnessLock score={score} size={15} />
                </div>
                <p style={{ margin: 0, fontSize: 14, color: 'rgba(255,255,255,0.62)' }}>{desc}</p>
              </div>
            ))}
          </div>
          <p style={{ margin: '28px 0 0', fontSize: 13.5, lineHeight: 1.65, color: 'rgba(255,255,255,0.42)' }}>
            The freshness score is tamper-proof. Both timestamps are cryptographically bound inside the token. No one can fake a higher score.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ padding: '40px 40px 28px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <DiamondLogo size={12} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: 3, color: 'rgba(255,255,255,0.8)' }}>SIGIL</div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>decentralized notes protocol</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }}>
              {['Protocol Spec', 'Run a Relay', 'Run a Registry', 'GitHub'].map(l => (
                <a key={l} href="#" style={{ color: 'rgba(255,255,255,0.5)', textDecoration: 'none' }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.85)')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.5)')}>
                  {l}
                </a>
              ))}
            </div>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: 'rgba(255,255,255,0.38)' }}>Open protocol. No company controls this network.</span>
          </div>
          <div style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid rgba(255,255,255,0.05)', textAlign: 'center' }}>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: 'rgba(255,255,255,0.22)' }}>SIGIL is math, not a company.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
