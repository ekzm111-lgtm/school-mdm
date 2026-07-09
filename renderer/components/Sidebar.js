export default function Sidebar({ activeTab, onTabChange, stats }) {
  const nav = [
    { id: 'dashboard', icon: '📊', label: '대시보드' },
    { id: 'devices',   icon: '📱', label: '기기 관리' },
    { id: 'kiosk',     icon: '🔒', label: '키오스크' },
    { id: 'apps',      icon: '📦', label: '앱 관리' },
    { id: 'logs',      icon: '📋', label: '이용 로그' },
  ];

  return (
    <aside style={{
      width: 210, flexShrink: 0,
      background: '#1e293b',
      borderRight: '1px solid #334155',
      display: 'flex', flexDirection: 'column',
      height: '100vh',
    }}>
      {/* 로고 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '18px 14px',
        borderBottom: '1px solid #334155',
      }}>
        <span style={{ fontSize: 26 }}>🏫</span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#f1f5f9' }}>School MDM</div>
          <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 2 }}>태블릿 통합 관리</div>
        </div>
      </div>

      {/* 네비 */}
      <nav style={{ flex: 1, padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {nav.map(item => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 8,
                border: isActive ? '1px solid rgba(99,102,241,0.5)' : '1px solid transparent',
                background: isActive ? 'rgba(99,102,241,0.22)' : 'transparent',
                color: isActive ? '#c7d2fe' : '#94a3b8',
                fontFamily: 'inherit', fontSize: 13.5,
                fontWeight: isActive ? 700 : 500,
                cursor: 'pointer', textAlign: 'left', transition: 'all 0.14s',
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#e2e8f0'; } }}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#94a3b8'; } }}
            >
              <span style={{ fontSize: 16 }}>{item.icon}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.id === 'devices' && stats.offline > 0 && (
                <span style={{ background: '#ef4444', color: '#fff', fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 99 }}>
                  {stats.offline}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* 하단 */}
      <div style={{ padding: '14px', borderTop: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, background: '#4ade80', borderRadius: '50%', display: 'inline-block', flexShrink: 0, animation: 'pulse-dot 2s infinite' }}/>
          <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 500 }}>온라인 {stats.online}대</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, background: '#f87171', borderRadius: '50%', display: 'inline-block', flexShrink: 0 }}/>
          <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 500 }}>오프라인 {stats.offline}대</span>
        </div>
        <div style={{ fontSize: 10, color: '#64748b', marginTop: 2, fontFamily: 'var(--mono)' }}>v1.0.0</div>
      </div>
    </aside>
  );
}
