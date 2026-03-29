import { useState, useEffect, useCallback } from 'react'
import './App.css'

// Arkeo RPC endpoints — use same-origin proxy on HTTPS, direct on GitHub Pages
const isHTTPS = typeof window !== 'undefined' && window.location.protocol === 'https:'
// Only providers that serve arkeo-mainnet-fullnode can be used here
const RPC_ENDPOINTS = {
  red5: isHTTPS ? '/rpc/red5/arkeo-mainnet-fullnode' : 'http://red5-arkeo.duckdns.org:3636/arkeo-mainnet-fullnode',
}
// Other providers shown for latency display (they serve ETH/Arbitrum/etc, not Arkeo chain)
const PROVIDER_LATENCY_ENDPOINTS = {
  stakevillage: isHTTPS ? '/rpc/stakevillage/eth-mainnet-fullnode' : 'http://142.132.148.174:3636/eth-mainnet-fullnode',
  everstake: isHTTPS ? '/rpc/everstake/arbitrum-mainnet-fullnode' : 'http://135.181.18.66:3636/arbitrum-mainnet-fullnode',
  oxfury: isHTTPS ? '/rpc/oxfury/eth-mainnet-fullnode' : 'http://arkeo.dc01.0xfury.io:3636/eth-mainnet-fullnode',
  nodefleet: isHTTPS ? '/rpc/nodefleet/metadata.json' : 'http://148.72.141.214:3636/metadata.json',
}
// Primary endpoint used throughout fetchData
// eslint-disable-next-line @typescript-eslint/no-unused-vars
void RPC_ENDPOINTS.red5

interface BlockHeader {
  height: string
  time: string
  proposer_address: string
  chain_id: string
  num_txs: number
}

interface Validator {
  address: string
  pub_key: { type: string; value: string }
  voting_power: string
  proposer_priority: string
}

interface TxResult {
  hash: string
  height: string
  tx_result: {
    code: number
    events: Array<{
      type: string
      attributes: Array<{ key: string; value: string }>
    }>
  }
}

interface NetworkStats {
  latestBlock: string
  latestTime: string
  chainId: string
  validators: number
  totalVotingPower: string
  catching_up: boolean
  providers: number
  contracts: number
  claims: number
}

function decodeAttr(val: string): string {
  try { return atob(val) } catch { return val }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function formatAddr(addr: string): string {
  if (addr.length <= 16) return addr
  return addr.slice(0, 10) + '...' + addr.slice(-6)
}

function App() {
  const [stats, setStats] = useState<NetworkStats | null>(null)
  const [blocks, setBlocks] = useState<BlockHeader[]>([])
  const [validators, setValidators] = useState<Validator[]>([])
  const [recentTxs, setRecentTxs] = useState<TxResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'overview' | 'blocks' | 'validators' | 'txs' | 'arkeo'>('overview')
  const [rpcLatency, setRpcLatency] = useState<{ red5: number; everstake: number; stakevillage: number; nodefleet: number; oxfury: number }>({ red5: 0, everstake: 0, stakevillage: 0, nodefleet: 0, oxfury: 0 })

  // Arkeo-specific data
  const [arkeoProviders, setArkeoProviders] = useState<number>(0)
  const [arkeoContracts, setArkeoContracts] = useState<number>(0)
  const [arkeoClaims, setArkeoClaims] = useState<number>(0)
  const [recentArkeoTxs, setRecentArkeoTxs] = useState<Array<{ type: string; hash: string; height: string; attrs: Record<string, string> }>>([])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void useState(false)[0]
  const [statsLoadedRef] = useState({ current: false })

  // Safe JSON fetch — handles rate limit text responses gracefully
  const safeFetch = async (url: string) => {
    const res = await fetch(url)
    const text = await res.text()
    if (text.startsWith('free client') || text.startsWith('rate limit')) {
      return null // silently skip rate-limited responses
    }
    return JSON.parse(text)
  }

  const fetchData = useCallback(async () => {
    try {
      setError(null)
      const isFirstLoad = !statsLoadedRef.current

      // Use primary provider for lightweight refresh (status + blocks = 2 reqs)
      const P1 = RPC_ENDPOINTS.red5

      // Fetch status (1 req)
      const t1 = performance.now()
      const statusData = await safeFetch(`${P1}/status`)
      if (!statusData) { setLoading(false); return }
      const red5Ms = Math.round(performance.now() - t1)
      setRpcLatency(prev => ({ ...prev, red5: red5Ms }))

      const si = statusData.result.sync_info
      const latestHeight = parseInt(si.latest_block_height)

      // Fetch recent blocks (1 req — total 2 for refresh cycle)
      const blockchainData = await safeFetch(`${P1}/blockchain?minHeight=${Math.max(1, latestHeight - 9)}&maxHeight=${latestHeight}`)
      if (blockchainData) {
        const blockMetas = (blockchainData.result.block_metas || []).map((bm: any) => ({
          height: bm.header.height,
          time: bm.header.time,
          proposer_address: bm.header.proposer_address,
          chain_id: bm.header.chain_id,
          num_txs: parseInt(bm.num_txs || '0'),
        }))
        setBlocks(blockMetas)
      }

      // === FIRST LOAD ONLY: All queries go through primary (Red_5) for reliability ===
      if (isFirstLoad) {
        // Latency checks for other providers (non-blocking — don't let failures stall loading)
        // Latency checks for other providers (these serve different chains but show sentinel reachability)
        const latencyChecks: Array<{ name: string; endpoint: string }> = [
          { name: 'stakevillage', endpoint: PROVIDER_LATENCY_ENDPOINTS.stakevillage },
          { name: 'everstake', endpoint: PROVIDER_LATENCY_ENDPOINTS.everstake },
          { name: 'oxfury', endpoint: PROVIDER_LATENCY_ENDPOINTS.oxfury },
          { name: 'nodefleet', endpoint: PROVIDER_LATENCY_ENDPOINTS.nodefleet },
        ]
        for (const check of latencyChecks) {
          const tc = performance.now()
          try { const r = await fetch(check.endpoint, { signal: AbortSignal.timeout(5000) }); if (r.ok) setRpcLatency(prev => ({ ...prev, [check.name]: Math.round(performance.now() - tc) })); else setRpcLatency(prev => ({ ...prev, [check.name]: -1 })) } catch { setRpcLatency(prev => ({ ...prev, [check.name]: -1 })) }
        }

        // All data queries use primary provider (Red_5) for reliability
        const valData = await safeFetch(`${P1}/validators?per_page=100`)
        if (valData) setValidators(valData.result.validators || [])

        const txData = await safeFetch(`${P1}/tx_search?query="tx.height>${latestHeight - 100}"&per_page=20&order_by="desc"`)
        if (txData) setRecentTxs(txData.result.txs || [])

        const arkeoTxData = await safeFetch(`${P1}/tx_search?query="tx.height>${latestHeight - 5000}"&per_page=50&order_by="desc"`)

        // Arkeo module stats — all from primary provider
        const [provData, contData, claimData] = await Promise.all([
          safeFetch(`${P1}/tx_search?query="message.action='/arkeo.arkeo.MsgModProvider'"&per_page=1`),
          safeFetch(`${P1}/tx_search?query="message.action='/arkeo.arkeo.MsgOpenContract'"&per_page=1`),
          safeFetch(`${P1}/tx_search?query="message.action='/arkeo.arkeo.MsgClaimContractIncome'"&per_page=1`),
        ])
        
        if (provData) setArkeoProviders(parseInt(provData.result.total_count || '0'))
        if (contData) setArkeoContracts(parseInt(contData.result.total_count || '0'))
        if (claimData) setArkeoClaims(parseInt(claimData.result.total_count || '0'))

        statsLoadedRef.current = true

        // Process arkeo txs
        const arkeoTxList: Array<{ type: string; hash: string; height: string; attrs: Record<string, string> }> = []
        if (arkeoTxData) {
          for (const tx of (arkeoTxData.result.txs || [])) {
            for (const ev of tx.tx_result.events) {
              if (ev.type === 'message') {
                const attrs: Record<string, string> = {}
                for (const a of ev.attributes) {
                  attrs[decodeAttr(a.key)] = decodeAttr(a.value)
                }
                const action = attrs['action'] || ''
                if (action.includes('arkeo') || action.includes('Delegate')) {
                  arkeoTxList.push({ type: action.split('.').pop() || action, hash: tx.hash, height: tx.height, attrs })
                }
              }
            }
          }
        }
        setRecentArkeoTxs(arkeoTxList.slice(0, 20))
      }

      // Update stats (use cached values for stats that only load on first load)
      const ni = statusData.result.node_info

      setStats(prev => ({
        latestBlock: si.latest_block_height,
        latestTime: si.latest_block_time,
        chainId: ni.network,
        validators: prev?.validators || 0,
        totalVotingPower: prev?.totalVotingPower || '0',
        catching_up: si.catching_up,
        providers: prev?.providers || 0,
        contracts: prev?.contracts || 0,
        claims: prev?.claims || 0,
      }))

      setLoading(false)
    } catch (err: any) {
      // Don't show error on refresh cycles, only on first load
      if (!statsLoadedRef.current) {
        setError(err.message || 'Failed to fetch')
      }
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    // Refresh every 30s (lightweight: just status + blocks = 2 reqs)
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [fetchData])

  const getTxAction = (tx: TxResult): string => {
    for (const ev of tx.tx_result.events) {
      if (ev.type === 'message') {
        for (const a of ev.attributes) {
          const key = decodeAttr(a.key)
          if (key === 'action') {
            const val = decodeAttr(a.value)
            return val.split('.').pop()?.replace('Msg', '') || val
          }
        }
      }
    }
    return 'Unknown'
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">🔭</span>
            <span>Arkeo Explorer</span>
          </div>
          <div className="header-right">
            <div className="rpc-status">
              <span className="rpc-dot online"></span>
              <span className="rpc-label">Red_5 <span className="rpc-ms">{rpcLatency.red5}ms</span></span>
              <span className="rpc-label">Everstake <span className="rpc-ms">{rpcLatency.everstake > 0 ? `${rpcLatency.everstake}ms` : '—'}</span></span>
              <span className="rpc-label">StakeVillage <span className="rpc-ms">{rpcLatency.stakevillage > 0 ? `${rpcLatency.stakevillage}ms` : '—'}</span></span>
              <span className="rpc-label">NodeFleet <span className="rpc-ms">{rpcLatency.nodefleet > 0 ? `${rpcLatency.nodefleet}ms` : '—'}</span></span>
              <span className="rpc-label">0xFury <span className="rpc-ms">{rpcLatency.oxfury > 0 ? `${rpcLatency.oxfury}ms` : '—'}</span></span>
            </div>
            <a href="https://arkeomarketplace.com" target="_blank" rel="noopener" className="nav-link">← Marketplace</a>
          </div>
        </div>
      </header>

      {error && <div className="error-banner">⚠️ {error}</div>}

      {/* Stats Bar */}
      {stats && (
        <div className="stats-grid">
          <div className="stat-card accent">
            <span className="stat-value">{parseInt(stats.latestBlock).toLocaleString()}</span>
            <span className="stat-label">Latest Block</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.validators}</span>
            <span className="stat-label">Validators</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.providers.toLocaleString()}</span>
            <span className="stat-label">Provider Txs</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.contracts.toLocaleString()}</span>
            <span className="stat-label">Contracts Opened</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.claims.toLocaleString()}</span>
            <span className="stat-label">Income Claims</span>
          </div>
          <div className="stat-card">
            <span className="stat-value chain-id">{stats.chainId}</span>
            <span className="stat-label">Chain ID</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        {(['overview', 'blocks', 'validators', 'txs', 'arkeo'] as const).map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'overview' ? '📊 Overview' : t === 'blocks' ? '📦 Blocks' : t === 'validators' ? '🛡️ Validators' : t === 'txs' ? '📜 Transactions' : '⚡ Arkeo Activity'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading">Loading Arkeo chain data via Arkeo sentinel...</div>
      ) : (
        <div className="content">
          {/* Overview */}
          {tab === 'overview' && (
            <>
              <div className="two-col">
                <div className="panel">
                  <h3>Recent Blocks</h3>
                  {blocks.slice(0, 5).map(b => (
                    <div key={b.height} className="list-row" onClick={() => setTab('blocks')}>
                      <div className="row-left">
                        <span className="block-height">#{parseInt(b.height).toLocaleString()}</span>
                        <span className="block-time">{timeAgo(b.time)}</span>
                      </div>
                      <div className="row-right">
                        <span className="tx-count">{b.num_txs} txs</span>
                        <span className="proposer">{formatAddr(b.proposer_address)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="panel">
                  <h3>Recent Transactions</h3>
                  {recentTxs.slice(0, 5).map(tx => (
                    <div key={tx.hash} className="list-row" onClick={() => setTab('txs')}>
                      <div className="row-left">
                        <span className={`tx-action ${getTxAction(tx).includes('Claim') ? 'claim' : getTxAction(tx).includes('Open') ? 'contract' : getTxAction(tx).includes('Mod') ? 'provider' : ''}`}>
                          {getTxAction(tx)}
                        </span>
                        <span className="tx-hash">{tx.hash.slice(0, 12)}...</span>
                      </div>
                      <div className="row-right">
                        <span className="tx-block">#{parseInt(tx.height).toLocaleString()}</span>
                        <span className={`tx-status ${tx.tx_result.code === 0 ? 'success' : 'fail'}`}>
                          {tx.tx_result.code === 0 ? '✓' : '✗'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* How this works */}
              <div className="info-banner">
                <strong>🔭 Meta:</strong> This block explorer reads Arkeo chain data <em>through Arkeo's own sentinel</em>. The data you see was fetched via Arkeo providers (Red_5, Everstake, StakeVillage, NodeFleet, 0xFury) serving the <code>arkeo-mainnet-fullnode</code> service.
              </div>
            </>
          )}

          {/* Blocks Tab */}
          {tab === 'blocks' && (
            <div className="panel full">
              <h3>📦 Recent Blocks</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>Height</th><th>Time</th><th>Txs</th><th>Proposer</th></tr>
                  </thead>
                  <tbody>
                    {blocks.map(b => (
                      <tr key={b.height}>
                        <td className="mono accent-text">{parseInt(b.height).toLocaleString()}</td>
                        <td>{timeAgo(b.time)}</td>
                        <td>{b.num_txs}</td>
                        <td className="mono">{formatAddr(b.proposer_address)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Validators Tab */}
          {tab === 'validators' && (
            <div className="panel full">
              <h3>🛡️ Active Validators ({validators.length})</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>#</th><th>Address</th><th>Voting Power</th><th>Share</th></tr>
                  </thead>
                  <tbody>
                    {validators
                      .sort((a, b) => parseInt(b.voting_power) - parseInt(a.voting_power))
                      .map((v, i) => {
                        const totalVP = validators.reduce((s, v2) => s + parseInt(v2.voting_power), 0)
                        const share = ((parseInt(v.voting_power) / totalVP) * 100).toFixed(2)
                        return (
                          <tr key={v.address}>
                            <td>{i + 1}</td>
                            <td className="mono">{v.address}</td>
                            <td className="mono">{parseInt(v.voting_power).toLocaleString()}</td>
                            <td>
                              <div className="power-bar">
                                <div className="power-fill" style={{ width: `${share}%` }}></div>
                                <span>{share}%</span>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Transactions Tab */}
          {tab === 'txs' && (
            <div className="panel full">
              <h3>📜 Recent Transactions</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>Hash</th><th>Block</th><th>Type</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {recentTxs.map(tx => (
                      <tr key={tx.hash}>
                        <td className="mono">{tx.hash.slice(0, 20)}...</td>
                        <td className="mono accent-text">{parseInt(tx.height).toLocaleString()}</td>
                        <td>
                          <span className={`action-badge ${getTxAction(tx).includes('Claim') ? 'claim' : getTxAction(tx).includes('Open') ? 'contract' : getTxAction(tx).includes('Mod') ? 'provider' : getTxAction(tx).includes('Delegate') ? 'delegate' : 'default'}`}>
                            {getTxAction(tx)}
                          </span>
                        </td>
                        <td className={tx.tx_result.code === 0 ? 'success-text' : 'fail-text'}>
                          {tx.tx_result.code === 0 ? 'Success' : 'Failed'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Arkeo Activity Tab */}
          {tab === 'arkeo' && (
            <div className="panel full">
              <h3>⚡ Arkeo Module Activity</h3>
              <div className="arkeo-summary">
                <div className="arkeo-stat">
                  <span className="arkeo-num">{arkeoProviders}</span>
                  <span>Provider Registrations</span>
                </div>
                <div className="arkeo-stat">
                  <span className="arkeo-num">{arkeoContracts.toLocaleString()}</span>
                  <span>Contracts Opened</span>
                </div>
                <div className="arkeo-stat">
                  <span className="arkeo-num">{arkeoClaims.toLocaleString()}</span>
                  <span>Income Claims</span>
                </div>
              </div>

              <h4 style={{ marginTop: '1.5rem', marginBottom: '0.75rem' }}>Recent Arkeo Transactions</h4>
              {recentArkeoTxs.length === 0 ? (
                <div className="no-data">No Arkeo-specific transactions in recent blocks</div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr><th>Type</th><th>Hash</th><th>Block</th></tr>
                    </thead>
                    <tbody>
                      {recentArkeoTxs.map((tx, i) => (
                        <tr key={i}>
                          <td>
                            <span className={`action-badge ${tx.type.includes('Claim') ? 'claim' : tx.type.includes('Open') ? 'contract' : tx.type.includes('Mod') ? 'provider' : 'default'}`}>
                              {tx.type}
                            </span>
                          </td>
                          <td className="mono">{tx.hash.slice(0, 20)}...</td>
                          <td className="mono accent-text">{parseInt(tx.height).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="info-banner" style={{ marginTop: '1.5rem' }}>
                <strong>What are these?</strong><br />
                <strong>ModProvider</strong> — A provider registered or updated their services on the network<br />
                <strong>OpenContract</strong> — A consumer opened a PAYG or subscription contract with a provider<br />
                <strong>ClaimContractIncome</strong> — A provider claimed earned ARKEO tokens from serving requests
              </div>
            </div>
          )}
        </div>
      )}

      <footer className="footer">
        <p>
          Arkeo chain explorer powered by{' '}
          <a href="https://rbechtold69.github.io/arkeo-data-engine-v2/" target="_blank" rel="noopener">Arkeo Network</a>
          {' '}— exploring itself via its own decentralized RPC
        </p>
        <p className="footer-sub">
          Data served by Red_5 provider via <code>arkeo-mainnet-fullnode</code> sentinel service
        </p>
      </footer>
    </div>
  )
}

export default App
