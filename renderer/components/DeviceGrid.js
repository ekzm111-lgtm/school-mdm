import { useState } from 'react';

export default function DeviceGrid({ devices, onSelect, selected, filter }) {
  const [search, setSearch] = useState('');
  const [sort, setSort]     = useState('state');

  let filtered = devices.filter(d => {
    const q = search.toLowerCase();
    return d.model.toLowerCase().includes(q)
        || (d.alias && d.alias.toLowerCase().includes(q))
        || d.serial.toLowerCase().includes(q)
        || d.ip.toLowerCase().includes(q);
  });
  if (filter === 'kiosk') filtered = filtered.filter(d => d.kioskApp);
  filtered = [...filtered].sort((a, b) => {
    if (sort === 'state')   return a.state === b.state ? 0 : a.state === 'online' ? -1 : 1;
    if (sort === 'battery') return a.battery - b.battery;
    if (sort === 'model')   return a.model.localeCompare(b.model);
    return 0;
  });

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {/* 필터 바 */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
        <input type="text" placeholder="🔍  기기 검색 (모델명, 시리얼, IP)" value={search} onChange={e=>setSearch(e.target.value)} style={{ width:290 }} />
        <select value={sort} onChange={e=>setSort(e.target.value)}>
          <option value="state">상태순</option>
          <option value="battery">배터리순</option>
          <option value="model">모델명순</option>
        </select>
        <span style={{ fontSize:13, color:'#64748b', fontWeight:500 }}>{filtered.length}대 표시 중</span>
      </div>

      {/* 카드 그리드 */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(195px,1fr))', gap:12 }}>
        {filtered.map((d, i) => (
          <DeviceCard key={d.serial} device={d} selected={selected===d.serial} onClick={() => onSelect(d.serial===selected?null:d.serial)} delay={i*25} />
        ))}
        {filtered.length === 0 && (
          <div style={{ gridColumn:'1/-1', padding:60, textAlign:'center', color:'#94a3b8', display:'flex', flexDirection:'column', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:40 }}>📭</span>
            <p style={{ fontSize:14 }}>기기가 없습니다</p>
          </div>
        )}
      </div>
    </div>
  );
}

function BatteryBar({ level, charging }) {
  const color = level<=20 ? '#dc2626' : level<=50 ? '#d97706' : '#16a34a';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <div style={{ flex:1, height:7, borderRadius:4, background:'#e2e8f0', overflow:'hidden' }}>
        <div style={{ width:`${level}%`, height:'100%', background:color, borderRadius:4, transition:'width 0.4s' }}/>
      </div>
      <span style={{ fontSize:12, fontWeight:700, fontFamily:'var(--mono)', color, minWidth:46, textAlign:'right' }}>
        {charging?'⚡ ':''}{level}%
      </span>
    </div>
  );
}

function DeviceCard({ device:d, selected, onClick, delay }) {
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
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:4, flexWrap:'wrap' }}>
        <span className={`badge ${online?'badge-online':'badge-offline'}`}>
          <span style={{ width:6, height:6, borderRadius:'50%', background:online?'#16a34a':'#dc2626', display:'inline-block' }}/>
          {online?'온라인':'오프라인'}
        </span>
        <div style={{ display:'flex', gap:4 }}>
          {d.locked   && <span className="badge badge-locked"  style={{ padding:'2px 7px', fontSize:11 }}>🔒 잠금</span>}
          {d.kioskApp && <span className="badge badge-kiosk"   style={{ padding:'2px 7px', fontSize:11 }}>🎯 키오스크</span>}
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
