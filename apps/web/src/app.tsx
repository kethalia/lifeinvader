const principles = [
  {
    number: '01',
    title: 'Nothing to hide',
    copy: 'Every post, reaction, and regrettable message belongs to the public record.',
  },
  {
    number: '02',
    title: 'Nothing to delete',
    copy: 'Corrections are new events. History remains available to shareholders and everyone else.',
  },
  {
    number: '03',
    title: 'Nobody in charge',
    copy: 'No administrator, upgrade key, or executive hotline can rewrite the protocol.',
  },
] as const

const networkFacts = [
  ['Frontend', 'Static'],
  ['Backend', 'Public chain'],
  ['Privacy', 'Absolutely not'],
] as const

export function App() {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="topbar">
        <a className="wordmark" href="./" aria-label="Lifeinvader home">
          life<span>invader</span>
        </a>
        <div className="status" aria-label="Protocol development status">
          <span className="status-dot" aria-hidden="true" />
          Protocol under construction
        </div>
      </header>

      <main id="main-content">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">The shareholder-owned social experience</p>
            <h1 id="hero-title">
              Privacy was a bug.
              <span>We put it on-chain.</span>
            </h1>
            <p className="hero-summary">
              Publish your personality directly to a public ledger. No hidden
              database, no delete button, and no confusing expectation of
              confidentiality.
            </p>

            <div className="hero-actions">
              <button type="button" disabled aria-describedby="wallet-note">
                Invade with your wallet
              </button>
              <p id="wallet-note">
                Wallet connection arrives in a focused milestone.
              </p>
            </div>
          </div>

          <aside className="ledger-card" aria-label="Network prospectus">
            <div className="ledger-heading">
              <span>LIVE</span>
              <p>Network prospectus</p>
            </div>
            <dl>
              {networkFacts.map(([term, value]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="ledger-disclaimer">
              Past embarrassment is a reliable indicator of future engagement.
            </p>
          </aside>
        </section>

        <section className="principles" aria-labelledby="principles-title">
          <div className="section-heading">
            <p className="eyebrow">Corporate values</p>
            <h2 id="principles-title">
              A social contract you can actually inspect.
            </h2>
          </div>

          <div className="principle-grid">
            {principles.map((principle) => (
              <article key={principle.number}>
                <p className="principle-number">{principle.number}</p>
                <h3>{principle.title}</h3>
                <p>{principle.copy}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer>
        <p>Lifeinvader is an unofficial parody project.</p>
        <p>Nothing is deployed. Everything will be public.</p>
      </footer>
    </div>
  )
}
