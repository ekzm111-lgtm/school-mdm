import { useState } from 'react';

export default function DeviceGrid({ devices, onSelect, selected, filter, checkedSerials, onToggleCheck, onSelectAll, onInvertSelect }) {
  const [search, setSearch] = useState('');
  const [sort, setSort]     = useState('state');
  const [selectedCategory, setSelectedCategory] = useState('ALL');

  // 중복 없이 기기에 지정된 모든 고유 그룹(카테고리) 목록 추출
  const categories = ['ALL', 'UNASSIGNED', ...Array.from(new Set(devices.map(d => d.group).filter(Boolean))).sort()];

  let filtered = devices.filter(d => {
    // 1. 검색어 필터
    const q = search.toLowerCase();
    const matchesSearch = d.model.toLowerCase().includes(q)
        || (d.alias && d.alias.toLowerCase().includes(q))
        || d.serial.toLowerCase().includes(q)
        || d.ip.toLowerCase().includes(q);

    if (!matchesSearch) return false;

    // 2. 위치 카테고리 필터
    if (selectedCategory === 'ALL') return true;
    if (selectedCategory === 'UNASSIGNED') return !d.group;
    return d.group === selectedCategory;
  });

  if (filter === 'kiosk') filtered = filtered.filter(d => d.kioskApp);
  
  filtered = [...filtered].sort((a, b) => {
    if (sort === 'state')   return a.state === b.state ? 0 : a.state === 'online' ? -1 : 1;
    if (sort === 'battery') return a.battery - b.battery;
    if (sort === 'model')   return a.model.localeCompare(b.model);
    if (sort === 'alias') {
      const aliasA = a.alias || '';
      const aliasB = b.alias || '';
      if (!aliasA && !aliasB) return a.model.localeCompare(b.model, undefined, { numeric: true });
      if (!aliasA) return 1;
      if (!aliasB) return -1;
      return aliasA.localeCompare(aliasB, undefined, { numeric: true });
    }
    return 0;
  });

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {/* 필터 바 */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
        <input 
          type="text" 
          placeholder="🔍  기기 검색 (모델명, 시리얼, IP)" 
          value={search} 
          onChange={e=>setSearch(e.target.value)} 
          style={{ width:230 }} 
        />
        
        {/* 위치 카테고리 필터 추가 */}
        <select 
          value={selectedCategory} 
          onChange={e=>setSelectedCategory(e.target.value)} 
          style={{ background: '#f8fafc', border: '1px solid #cbd5e1', fontWeight: 600, padding: '6px 10px', borderRadius: 8, fontSize: 13 }}
        >
          {categories.map(cat => (
            <option key={cat} value={cat}>
              {cat === 'ALL' ? '📁 전체 위치' : cat === 'UNASSIGNED' ? '📁 위치 미지정 기기' : `🏫 ${cat}`}
            </option>
          ))}
        </select>

        <select 
          value={sort} 
          onChange={e=>setSort(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 8, fontSize: 13 }}
        >
          <option value="state">상태순</option>
          <option value="battery">배터리순</option>
          <option value="model">모델명순</option>
          <option value="alias">네임텍 이름순</option>
        </select>
        <span style={{ fontSize:13, color:'#64748b', fontWeight:500 }}>{filtered.length}대 표시 중</span>

        {/* 전체 선택 / 선택 반전 / 전체 해제 버튼 추가 */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onSelectAll(filtered.map(d => d.serial))} style={{ border: '1px solid #cbd5e1', fontWeight: 600, padding: '5px 10px', fontSize: 12, height: 32, display: 'flex', alignItems: 'center', background: '#ffffff', color: '#334155' }}>
            ✅ 전체 선택
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onInvertSelect(filtered.map(d => d.serial))} style={{ border: '1px solid #cbd5e1', fontWeight: 600, padding: '5px 10px', fontSize: 12, height: 32, display: 'flex', alignItems: 'center', background: '#ffffff', color: '#334155' }}>
            🔄 선택 반전
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onSelectAll([])} style={{ border: '1px solid #fca5a5', background: '#fee2e2', color: '#dc2626', fontWeight: 600, padding: '5px 10px', fontSize: 12, height: 32, display: 'flex', alignItems: 'center' }}>
            ❌ 전체 해제
          </button>
        </div>
      </div>

      {/* 카드 그리드 */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(195px,1fr))', gap:12 }}>
        {filtered.map((d, i) => (
          <DeviceCard
            key={d.serial}
            device={d}
            selected={selected===d.serial}
            onClick={() => onSelect(d.serial===selected?null:d.serial)}
            checked={checkedSerials?.includes(d.serial)}
            onToggleCheck={onToggleCheck}
            delay={i*25}
          />
        ))}
        {filtered.length === 0 && (
          <div style={{ gridColumn:'1/-1', padding:60, textAlign:'center', color:'#94a3b8', display:'flex', flexDirection:'column', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:40 }}>📭</span>
            <p style={{ fontSize:14 }}>조건에 부합하는 기기가 없습니다</p>
          </div>
        )}
      </div>
    </div>
  );
}

function BatteryBar({ level, charging }) {
  const val = typeof level === 'number' && !isNaN(level) ? Math.max(0, Math.min(100, level)) : 0;
  const color = val <= 20 ? '#dc2626' : val <= 50 ? '#d97706' : '#16a34a';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <div style={{ flex:1, height:7, borderRadius:4, background:'#e2e8f0', overflow:'hidden' }}>
        <div style={{ width:`${val}%`, height:'100%', background:color, borderRadius:4, transition:'width 0.4s' }}/>
      </div>
      <span style={{ fontSize:12, fontWeight:700, fontFamily:'var(--mono)', color, minWidth:46, textAlign:'right' }}>
        {charging?'⚡ ':''}{val}%
      </span>
    </div>
  );
}

function DeviceCard({ device:d, selected, onClick, checked, onToggleCheck, delay }) {
  const online = d.state === 'online';
  return (
    <div
      style={{
        background: selected ? '#eef2ff' : '#ffffff',
        border: selected ? '2px solid #4f46e5' : '1.5px solid #e2e8f0',
        borderRadius: 12,
        padding: 14,
        cursor: 'pointer',
        transition: 'all 0.16s ease',
        display: 'flex', flexDirection: 'column', gap: 10,
        opacity: online ? 1 : 0.55,
        boxShadow: selected ? '0 0 0 3px rgba(79,70,229,0.15), 0 4px 12px rgba(0,0,0,0.1)' : '0 1px 4px rgba(0,0,0,0.07)',
        animation: `fade-in 0.28s ease ${delay}ms both`,
      }}
      onClick={onClick}
      onMouseEnter={e => { if(!selected) e.currentTarget.style.boxShadow='0 6px 18px rgba(0,0,0,0.12)'; e.currentTarget.style.transform='translateY(-2px)'; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow=selected?'0 0 0 3px rgba(79,70,229,0.15)':'0 1px 4px rgba(0,0,0,0.07)'; e.currentTarget.style.transform=''; }}
    >
      {/* 상단 */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%', gap:4 }}>
        <span className={`badge ${online?'badge-online':'badge-offline'}`}>
          <span style={{ width:6, height:6, borderRadius:'50%', background:online?'#16a34a':'#dc2626', display:'inline-block' }}/>
          {online?'온라인':'오프라인'}
        </span>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ display:'flex', gap:4 }}>
            {d.locked   && <span className="badge badge-locked"  style={{ padding:'2px 7px', fontSize:11 }}>🔒 잠금</span>}
            {d.kioskApp && <span className="badge badge-kiosk"   style={{ padding:'2px 7px', fontSize:11 }}>🎯 키오스크</span>}
          </div>
          <input 
            type="checkbox"
            checked={!!checked}
            onChange={(e) => {
              e.stopPropagation();
              onToggleCheck(d.serial);
            }}
            style={{ 
              width: 15, height: 15, cursor: 'pointer', accentColor: '#4f46e5',
              margin: 0
            }}
          />
        </div>
      </div>

      {/* 중앙 */}
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, padding:'4px 0' }}>
        <span style={{ fontSize:34 }}>📱</span>
        {d.alias ? (
          <>
            <div style={{ fontSize:14, fontWeight:800, color:'#4f46e5', textAlign:'center' }}>🏷️ {d.alias}</div>
            <div style={{ fontSize:11.5, color:'#64748b', fontWeight:500, textAlign:'center' }}>{d.model}</div>
          </>
        ) : (
          <div style={{ fontSize:14, fontWeight:700, color:'#0f172a', textAlign:'center' }}>{d.model}</div>
        )}
        <div style={{ fontSize:11, color:'#94a3b8', fontFamily:'var(--mono)', textAlign:'center' }}>{d.serial}</div>
        
        {/* 기기 카드 내에 소속 위치(그룹) 뱃지 노출 */}
        {d.group && (
          <span style={{
            fontSize: 10, fontWeight: 700, background: '#e0f2fe', color: '#0369a1',
            padding: '2px 6px', borderRadius: 4, marginTop: 4, display: 'inline-block'
          }}>
            🏫 {d.group}
          </span>
        )}

        {d.ip && <div style={{ fontSize:12, color:'#0891b2', fontFamily:'var(--mono)', marginTop:2 }}>🌐 {d.ip}</div>}
      </div>

      {/* 하단 */}
      {online
        ? <BatteryBar level={d.battery} charging={d.charging}/>
        : <div style={{ fontSize:11, color:'#94a3b8', textAlign:'center' }} suppressHydrationWarning>마지막: {new Date(d.lastSeen).toLocaleTimeString()}</div>
      }
    </div>
  );
}
