import { useMemo, useState } from 'react'
import './App.css'

const GAMES = ['One Piece', 'Pokemon', 'Riftbound']

const DEMO_COLLECTION = {
  'One Piece': [
    { name: 'Monkey D. Luffy OP05-060', costBasis: 120, marketValue: 155 },
    { name: 'Boa Hancock OP07-051', costBasis: 90, marketValue: 74 },
  ],
  Pokemon: [
    { name: 'Charizard ex 199/165', costBasis: 280, marketValue: 340 },
    { name: 'Umbreon VMAX 215/203', costBasis: 650, marketValue: 610 },
  ],
  Riftbound: [
    { name: 'Jinx Champion Card', costBasis: 60, marketValue: 55 },
    { name: 'Ashe Champion Card', costBasis: 45, marketValue: 52 },
  ],
}

const EMPTY_SPEND = Object.fromEntries(GAMES.map((game) => [game, { chase: 0, venmo: 0 }]))

function normalizeGame(value = '') {
  const cleaned = value.toLowerCase().trim()
  if (cleaned.includes('one piece')) return 'One Piece'
  if (cleaned.includes('pokemon')) return 'Pokemon'
  if (cleaned.includes('riftbound')) return 'Riftbound'
  return null
}

function summarizeSpend(payload, source) {
  const transactions = Array.isArray(payload) ? payload : payload?.transactions
  if (!Array.isArray(transactions)) {
    throw new Error('Expected transactions array in spend API response.')
  }

  const next = Object.fromEntries(GAMES.map((game) => [game, { chase: 0, venmo: 0 }]))

  for (const tx of transactions) {
    const game = normalizeGame(tx?.game ?? tx?.category ?? tx?.memo ?? tx?.description)
    if (!game) continue
    const amount = Math.abs(Number(tx?.amount ?? 0))
    if (!Number.isFinite(amount)) continue
    next[game][source] += amount
  }

  return next
}

async function authorizeTcgPlayer(clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  })

  const response = await fetch('https://api.tcgplayer.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!response.ok) {
    throw new Error(`TCGPlayer authorization failed: ${response.status}`)
  }

  return response.json()
}

function mergeSpend(current, incoming) {
  const merged = structuredClone(current)
  for (const game of GAMES) {
    merged[game].chase = incoming[game].chase || merged[game].chase
    merged[game].venmo = incoming[game].venmo || merged[game].venmo
  }
  return merged
}

function App() {
  const [selectedGame, setSelectedGame] = useState('One Piece')
  const [collection] = useState(DEMO_COLLECTION)
  const [spendByGame, setSpendByGame] = useState(EMPTY_SPEND)
  const [tcgClientId, setTcgClientId] = useState('')
  const [tcgClientSecret, setTcgClientSecret] = useState('')
  const [tcgStatus, setTcgStatus] = useState('Not connected')
  const [tokenSnippet, setTokenSnippet] = useState('')
  const [spendConfig, setSpendConfig] = useState({
    chase: { endpoint: '', apiKey: '' },
    venmo: { endpoint: '', apiKey: '' },
  })
  const [spendStatus, setSpendStatus] = useState({ chase: 'Not synced', venmo: 'Not synced' })

  const selectedCards = collection[selectedGame]

  const totals = useMemo(() => {
    const totalCostBasis = selectedCards.reduce((sum, card) => sum + card.costBasis, 0)
    const totalMarketValue = selectedCards.reduce((sum, card) => sum + card.marketValue, 0)
    const sourceSpend = spendByGame[selectedGame]
    const totalExternalSpend = sourceSpend.chase + sourceSpend.venmo
    const net = totalMarketValue - (totalCostBasis + totalExternalSpend)

    return { totalCostBasis, totalMarketValue, totalExternalSpend, net }
  }, [selectedCards, selectedGame, spendByGame])

  const runAuthorization = async () => {
    try {
      setTcgStatus('Authorizing...')
      const token = await authorizeTcgPlayer(tcgClientId, tcgClientSecret)
      setTokenSnippet((token.access_token || '').slice(0, 16))
      setTcgStatus('Connected')
    } catch (error) {
      setTcgStatus(error.message)
      setTokenSnippet('')
    }
  }

  const syncSpendSource = async (source) => {
    const config = spendConfig[source]
    if (!config.endpoint) {
      setSpendStatus((current) => ({ ...current, [source]: 'Enter endpoint first.' }))
      return
    }

    try {
      setSpendStatus((current) => ({ ...current, [source]: 'Syncing...' }))
      const response = await fetch(config.endpoint, {
        headers: {
          Accept: 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
      const summarized = summarizeSpend(data, source)
      setSpendByGame((current) => mergeSpend(current, summarized))
      setSpendStatus((current) => ({ ...current, [source]: 'Synced' }))
    } catch (error) {
      setSpendStatus((current) => ({ ...current, [source]: `Sync failed: ${error.message}` }))
    }
  }

  return (
    <main className="app-shell">
      <h1>Card Collection P&amp;L Tracker</h1>
      <p className="lead">
        Connect TCGPlayer and your spend feeds to track gains/losses for One Piece, Pokemon,
        and Riftbound.
      </p>

      <section className="card">
        <h2>Game Toggle</h2>
        <div className="toggle-row" role="tablist" aria-label="Select game category">
          {GAMES.map((game) => (
            <button
              type="button"
              key={game}
              className={game === selectedGame ? 'chip active' : 'chip'}
              onClick={() => setSelectedGame(game)}
              role="tab"
              aria-selected={game === selectedGame}
            >
              {game}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>TCGPlayer API Authorization</h2>
        <div className="field-grid">
          <label>
            Client ID
            <input
              value={tcgClientId}
              onChange={(event) => setTcgClientId(event.target.value)}
              placeholder="Paste your TCGPlayer client_id"
            />
          </label>
          <label>
            Client Secret
            <input
              value={tcgClientSecret}
              onChange={(event) => setTcgClientSecret(event.target.value)}
              placeholder="Paste your TCGPlayer client_secret"
              type="password"
            />
          </label>
        </div>
        <div className="action-row">
          <button type="button" onClick={runAuthorization} className="primary">
            Authorize TCGPlayer
          </button>
          <span>Status: {tcgStatus}</span>
          {tokenSnippet && <span>Token starts with: {tokenSnippet}...</span>}
        </div>
      </section>

      <section className="card">
        <h2>Spend Sync (Chase + Venmo)</h2>
        {['chase', 'venmo'].map((source) => (
          <div className="source-row" key={source}>
            <h3>{source.toUpperCase()}</h3>
            <div className="field-grid">
              <label>
                Backend endpoint URL
                <input
                  value={spendConfig[source].endpoint}
                  onChange={(event) =>
                    setSpendConfig((current) => ({
                      ...current,
                      [source]: { ...current[source], endpoint: event.target.value },
                    }))
                  }
                  placeholder={`https://your-backend/${source}/transactions`}
                />
              </label>
              <label>
                API key / token
                <input
                  value={spendConfig[source].apiKey}
                  onChange={(event) =>
                    setSpendConfig((current) => ({
                      ...current,
                      [source]: { ...current[source], apiKey: event.target.value },
                    }))
                  }
                  type="password"
                  placeholder="Optional bearer token"
                />
              </label>
            </div>
            <div className="action-row">
              <button type="button" className="primary" onClick={() => syncSpendSource(source)}>
                Sync {source}
              </button>
              <span>{spendStatus[source]}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="card metrics">
        <h2>{selectedGame} Snapshot</h2>
        <div className="metric-grid">
          <article>
            <h3>Total cost basis</h3>
            <p>${totals.totalCostBasis.toFixed(2)}</p>
          </article>
          <article>
            <h3>Current market value</h3>
            <p>${totals.totalMarketValue.toFixed(2)}</p>
          </article>
          <article>
            <h3>External spend (Chase + Venmo)</h3>
            <p>${totals.totalExternalSpend.toFixed(2)}</p>
          </article>
          <article className={totals.net >= 0 ? 'positive' : 'negative'}>
            <h3>Net gain / loss</h3>
            <p>${totals.net.toFixed(2)}</p>
          </article>
        </div>
      </section>

      <section className="card">
        <h2>{selectedGame} Cards</h2>
        <ul className="card-list">
          {selectedCards.map((card) => (
            <li key={card.name}>
              <span>{card.name}</span>
              <span>Cost: ${card.costBasis.toFixed(2)}</span>
              <span>Value: ${card.marketValue.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}

export default App
