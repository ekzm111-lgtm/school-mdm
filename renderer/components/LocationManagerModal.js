import { useState, useEffect } from 'react';

const isMdm = typeof window !== 'undefined' && !!window.mdm;

// ── 장소(Location) 관리 모달 ────────────────────────────
export default function LocationManagerModal({ devices, onClose, onRefresh }) {
  const [locations, setLocations]   = useState([]);   // ['1교실', '2교실', ...]
  const [newName,   setNewName]     = useState('');
  const [editIdx,   setEditIdx]     = useState(null); // 수정 중인 인덱스
  const [editName,  setEditName]    = useState('');
  const [toast,     setToast]       = useState('');

  // localStorage 기반 장소 목록 영속화
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('mdm_locations') || '[]');
      setLocations(saved);
    } catch { setLocations([]); }
  }, []);

  const save = (list) => {
    setLocations(list);
    localStorage.setItem('mdm_locations', JSON.stringify(list));
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  };

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    if (locations.includes(name)) { showToast('⚠️ 이미 존재하는 장소입니다.'); return; }
    save([...locations, name]);
    setNewName('');
    showToast(`✅ "${name}" 장소가 추가되었습니다.`);
  };

  const handleDelete = (loc) => {
    if (!confirm(`"${loc}" 장소를 삭제하시겠습니까?\n(이 장소에 배정된 기기들은 미배정 상태가 됩니다.)`)) return;
    // 해당 장소에 배정된 기기들 그룹 초기화
    const devicesInLoc = devices.filter(d => d.group === loc);
    devicesInLoc.forEach(d => {
      if (isMdm) window.mdm.setDeviceGroup(d.serial, '');
    });
    save(locations.filter(l => l !== loc));
    showToast(`🗑️ "${loc}" 장소가 삭제되었습니다.`);
    onRefresh?.();
  };

  const handleEditSave = (oldName) => {
    const name = editName.trim();
    if (!name) return;
    if (locations.includes(name) && name !== oldName) { showToast('⚠️ 이미 존재하는 장소입니다.'); return; }
    // 기기 그룹명도 일괄 변경
    const devicesInLoc = devices.filter(d => d.group === oldName);
    devicesInLoc.forEach(d => {
      if (isMdm) window.mdm.setDeviceGroup(d.serial, name);
    });
    const newList = locations.map(l => l === oldName ? name : l);
    save(newList);
    setEditIdx(null);
    setEditName('');
    showToast(`✏️ "${oldName}" → "${name}" 으로 변경되었습니다.`);
    onRefresh?.();
  };

  const handleAssign = async (serial, group) => {
    if (isMdm) await window.mdm.setDeviceGroup(serial, group);
    showToast(`📍 기기가 "${group || '미배정'}"으로 이동했습니다.`);
    onRefresh?.();
  };

  const unassigned = devices.filter(d => !d.group || !locations.includes(d.group));

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(15,23,42,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1100, padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: '#fff', borderRadius: 18,
        width: 680, maxHeight: '88vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 64px rgba(0,0,0,0.28)',
        overflow: 'hidden',
      }} onClick={e => e.stopPropagation()}>

        {/* 헤더 */}
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid #e2e8f0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%)',
        }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: '#fff', margin: 0 }}>🗂️ 장소(카테고리) 관리</h2>
            <p style={{ fontSize: 12, color: '#c7d2fe', margin: '4px 0 0' }}>
              장소를 추가·수정·삭제하고 기기를 배정하세요.
            </p>
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.18)', border: 'none',
            width: 34, height: 34, borderRadius: 8, cursor: 'pointer',
            fontSize: 17, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* 새 장소 추가 */}
          <div style={{
            background: '#f8faff', border: '1.5px dashed #a5b4fc',
            borderRadius: 12, padding: '16px 18px',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#4f46e5', marginBottom: 10 }}>➕ 새 장소 추가</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                placeholder="예) 1교실, 도서관, 컴퓨터실 …"
                style={{
                  flex: 1, padding: '9px 14px', borderRadius: 8,
                  border: '1.5px solid #c7d2fe', fontSize: 13,
                  outline: 'none', background: '#fff',
                }}
              />
              <button onClick={handleAdd} style={{
                background: 'linear-gradient(135deg,#4f46e5,#7c3aed)',
                color: '#fff', border: 'none', borderRadius: 8,
                padding: '9px 20px', fontSize: 13, fontWeight: 700,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}>추가</button>
            </div>
          </div>

          {/* 장소 목록 */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 10 }}>
              📍 등록된 장소 ({locations.length})
            </div>
            {locations.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 13, padding: '24px 0' }}>
                아직 등록된 장소가 없습니다.<br/>위에서 새 장소를 추가해보세요.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {locations.map((loc, idx) => {
                  const devicesHere = devices.filter(d => d.group === loc);
                  const isEditing = editIdx === idx;
                  return (
                    <div key={loc} style={{
                      background: '#fff', border: '1.5px solid #e2e8f0',
                      borderRadius: 12, overflow: 'hidden',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                    }}>
                      {/* 장소 헤더 */}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 14px', background: '#f8fafc',
                        borderBottom: devicesHere.length > 0 ? '1px solid #e2e8f0' : 'none',
                      }}>
                        <span style={{ fontSize: 16 }}>📍</span>
                        {isEditing ? (
                          <>
                            <input
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleEditSave(loc); if (e.key === 'Escape') setEditIdx(null); }}
                              autoFocus
                              style={{
                                flex: 1, padding: '5px 10px', borderRadius: 6,
                                border: '1.5px solid #4f46e5', fontSize: 13, outline: 'none',
                              }}
                            />
                            <button onClick={() => handleEditSave(loc)} style={{ background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>저장</button>
                            <button onClick={() => setEditIdx(null)} style={{ background: '#f1f5f9', color: '#64748b', border: 'none', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}>취소</button>
                          </>
                        ) : (
                          <>
                            <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: '#1e293b' }}>{loc}</span>
                            <span style={{ fontSize: 11.5, color: '#64748b', background: '#e2e8f0', borderRadius: 99, padding: '2px 8px' }}>
                              기기 {devicesHere.length}대
                            </span>
                            <button onClick={() => { setEditIdx(idx); setEditName(loc); }} style={{ background: '#eef2ff', color: '#4f46e5', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>✏️ 수정</button>
                            <button onClick={() => handleDelete(loc)} style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>🗑️ 삭제</button>
                          </>
                        )}
                      </div>
                      {/* 이 장소의 기기 목록 */}
                      {devicesHere.length > 0 && (
                        <div style={{ padding: '8px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {devicesHere.map(d => (
                            <div key={d.serial} style={{
                              display: 'flex', alignItems: 'center', gap: 6,
                              background: '#f0fdf4', border: '1px solid #86efac',
                              borderRadius: 99, padding: '4px 10px 4px 8px',
                              fontSize: 12, color: '#166534',
                            }}>
                              <span style={{ width: 7, height: 7, borderRadius: '50%', background: d.state === 'online' ? '#16a34a' : '#94a3b8', display: 'inline-block' }} />
                              {d.alias || d.model || d.serial}
                              <select
                                value={d.group || ''}
                                onChange={e => handleAssign(d.serial, e.target.value)}
                                style={{ fontSize: 11, border: '1px solid #86efac', borderRadius: 6, background: '#fff', padding: '1px 4px', cursor: 'pointer', color: '#166534' }}
                              >
                                <option value="">미배정</option>
                                {locations.map(l => <option key={l} value={l}>{l}</option>)}
                              </select>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 미배정 기기 */}
          {unassigned.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 10 }}>
                📱 미배정 기기 ({unassigned.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {unassigned.map(d => (
                  <div key={d.serial} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: '#fff', border: '1px solid #e2e8f0',
                    borderRadius: 10, padding: '10px 14px',
                  }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.state === 'online' ? '#16a34a' : '#94a3b8', display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
                      {d.alias || d.model || d.serial}
                      <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>{d.serial}</span>
                    </span>
                    <select
                      value={d.group || ''}
                      onChange={e => handleAssign(d.serial, e.target.value)}
                      style={{
                        fontSize: 12, border: '1.5px solid #c7d2fe', borderRadius: 7,
                        background: '#f8faff', padding: '5px 10px', cursor: 'pointer',
                        color: '#4f46e5', fontWeight: 600,
                      }}
                    >
                      <option value="">📌 장소 배정…</option>
                      {locations.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 푸터 */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            background: 'linear-gradient(135deg,#4f46e5,#7c3aed)',
            color: '#fff', border: 'none', borderRadius: 8,
            padding: '9px 24px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}>닫기</button>
        </div>
      </div>

      {/* 토스트 */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 32, left: '50%', transform: 'translateX(-50%)',
          background: '#1e293b', color: '#fff', borderRadius: 10,
          padding: '10px 22px', fontSize: 13, fontWeight: 600,
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)', zIndex: 2000,
          animation: 'fadeInUp 0.2s ease',
        }}>{toast}</div>
      )}
    </div>
  );
}
