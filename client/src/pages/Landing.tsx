import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import DeleteLocalKeys from '../components/DeleteLocalKeys'
import { useIdentity } from '../store/identity'
import { config } from '../config'
import './Landing.css'

const steps = [
  { title: 'Create an identity you control', text: 'Your browser generates a private key and shows it once for backup. The public-key fingerprint gives others a precise way to recognize your signing key.' },
  { title: 'Choose a registry', text: 'A registry connects your handle to your public key with a signed endorsement. You choose which registries to use and whose endorsements to trust.' },
  { title: 'Publish through your brokers', text: 'Your client signs each note and sends it to the brokers you select. Connect to several, and choose independently where to read and where to publish.' },
  { title: 'Let readers verify your words', text: 'Readers check the registry endorsement and your signature. An altered note fails verification. The fingerprint and signing details stay available beside your handle.' },
]

export default function Landing() {
  const navigate = useNavigate()
  const { identity, restoring } = useIdentity()
  const enter = () => navigate(identity ? '/app' : '/onboarding')
  const action = restoring ? 'Restoring identity…' : identity ? 'Go to app' : 'Create your identity'
  const repository = config.repositoryUrl.replace(/\/$/, '')

  useEffect(() => {
    const htmlOverflow = document.documentElement.style.overflow
    const bodyOverflow = document.body.style.overflow
    const bodyHeight = document.body.style.height
    document.documentElement.style.overflow = 'auto'
    document.body.style.overflow = 'auto'
    document.body.style.height = 'auto'
    return () => {
      document.documentElement.style.overflow = htmlOverflow
      document.body.style.overflow = bodyOverflow
      document.body.style.height = bodyHeight
    }
  }, [])

  return <div className="landing-page">
    <a className="landing-skip" href="#main">Skip to content</a>
    <header className="landing-header landing-width">
      <a className="landing-brand" href="#main" aria-label="Sigil home"><span className="landing-mark" aria-hidden="true" />SIGIL</a>
      <nav className="landing-nav" aria-label="Main navigation">
        <a href="#protocol">How it works</a>
        <a href="#why">Why Sigil</a>
        <a href={repository} target="_blank" rel="noreferrer">GitHub</a>
        {!identity && !restoring && <button className="landing-text-button" onClick={() => navigate('/onboarding?mode=signin')}>Import Identity</button>}
        <button className="landing-button landing-button-small" onClick={enter} disabled={restoring} aria-busy={restoring}>{restoring ? 'Restoring…' : identity ? 'Go to app' : 'Get started'}</button>
      </nav>
    </header>

    <main id="main" className="landing-width">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div>
          <p className="landing-eyebrow">An open protocol for signed notes</p>
          <h1 id="landing-title">Your voice.<br /><span>Signed by you.</span></h1>
          <p className="landing-intro">A name can be copied. A signature needs your key. Sigil connects your words to a key you control, so others can verify who signed them.</p>
          <div className="landing-actions">
            <button className="landing-button" onClick={enter} disabled={restoring} aria-busy={restoring}>{action}<span aria-hidden="true">→</span></button>
            <a className="landing-secondary" href="#protocol">Read how it works <span aria-hidden="true">↓</span></a>
            <a className="landing-secondary" href={`${repository}#readme`} target="_blank" rel="noreferrer">Read the README <span aria-hidden="true">↗</span></a>
          </div>
          {identity && <p className="landing-active">Continue as <span>{identity.handle}</span></p>}
          {!identity && !restoring && <p className="landing-caption">No email required. Back up your key before you begin.</p>}
        </div>
        <aside className="landing-principle">
          <p className="landing-eyebrow">The idea is simple</p>
          <p className="landing-statement">Your identity belongs to you.<br />Your words carry the proof.</p>
          <p>A broker can carry your note. It cannot create a valid signature for your key. Readers verify the signature themselves, rather than taking a relay’s word for it.</p>
          <p>Choose your brokers. Keep your key. Take your signing identity with you.</p>
        </aside>
      </section>

      <section id="why" className="landing-section" aria-labelledby="why-title">
        <div className="landing-section-heading">
          <p className="landing-eyebrow">Why use Sigil</p>
          <h2 id="why-title">A voice you can recognize.<br />More than a familiar name.</h2>
        </div>
        <div className="landing-reasons">
          <article><h3>Make impersonation harder</h3><p>Someone can copy your name or quote your text. Without your private key, they cannot make a note pass signature verification as that key. Compare fingerprints when identity matters.</p></article>
          <article><h3>Keep control of your identity</h3><p>Your private key lives in your browser and your own backup. You can use it with compatible registries and brokers, instead of leaving your signing identity in a platform’s hands.</p></article>
          <article><h3>Choose more than one route</h3><p>A single broker does not have to be your only connection. Read from some brokers, publish to others, or do both. Your key stays yours when you change where your notes travel.</p></article>
        </div>
      </section>

      <section id="protocol" className="landing-section landing-protocol" aria-labelledby="protocol-title">
        <div className="landing-section-heading">
          <p className="landing-eyebrow">How the protocol works</p>
          <h2 id="protocol-title">From your key<br />to a verifiable note.</h2>
          <p>Three roles work together: your client signs and verifies, a registry endorses identities, and brokers relay notes.</p>
          {repository && <a className="landing-secondary" href={`${repository}#how-it-works`}>Read the protocol documentation <span aria-hidden="true">↗</span></a>}
        </div>
        <ol className="landing-steps">
          {steps.map((step, index) => <li key={step.title}><span className="landing-step-number" aria-hidden="true">0{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}
        </ol>
      </section>

      <section className="landing-section landing-proof" aria-labelledby="proof-title">
        <h2 id="proof-title">What the proof covers</h2>
        <div><p>A signature identifies the signing key. A registry endorses the handle attached to it. Choosing a registry is a trust decision; a familiar handle alone is not proof of the same identity.</p><p>Notes are signed public messages, not encrypted conversations. Brokers can read them and may refuse to relay them. Other brokers offer other routes, while your client keeps verifying the signatures.</p></div>
      </section>

      <section className="landing-final" aria-labelledby="start-title">
        <div><p className="landing-eyebrow">Make your words verifiable</p><h2 id="start-title">{identity ? 'Your identity is ready.' : 'Start with a key that’s yours.'}</h2><p>{identity ? 'Return to your notes with the identity already stored in this browser.' : 'Create an identity, save your backup, and write your first note.'}</p></div>
        <button className="landing-button" onClick={enter} disabled={restoring} aria-busy={restoring}>{action}<span aria-hidden="true">→</span></button>
      </section>
    </main>

    <footer className="landing-footer landing-width">
      <div><span className="landing-footer-name">SIGIL</span><p>Decentralized notes. Verifiable authorship.</p></div>
      <div className="landing-footer-links"><a href="#protocol">Protocol overview</a>{repository && <><a href={repository} target="_blank" rel="noreferrer">GitHub</a><a href={`${repository}#readme`} target="_blank" rel="noreferrer">README</a><a href={`${repository}#quick-start`}>Run the stack</a></>}<DeleteLocalKeys /></div>
    </footer>
  </div>
}
