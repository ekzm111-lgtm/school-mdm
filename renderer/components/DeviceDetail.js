import { useState } from 'react';
import MirrorModal from './MirrorModal';

const isMdm = typeof window !== 'undefined' && !!window.mdm;

export default function DeviceDetail({ device, onClose, onRefresh }) {
  const [selectedApps, setSelectedApps] = useState([]); // unused but keeping consistency
  const [loading, setLoading] = useState('');
  const [apps, setApps] = useState([]);
  const [showApps, setShowApps] = useState(false);
  const [kioskPkg, setKioskPkg] = useState('');
  const [volume, setVolume] = useState(8);
  const [nameTag, setNameTag] = useState('');
  const [groupTag, setGroupTag] = useState('');
  const [locationResult, setLocationResult] = useState(null);
  const [showMirror, setShowMirror] = useState(false);

  // 기기가 변경되거나 별명이 로드되면 네임텍 폼을 싱크
  const { useEffect: useReactEffect } = require('react');
  useReactEffect(() => {
    setNameTag(device?.alias || '');
    setGroupTag(device?.group || '');
    setLocationResult(null);
  }, [device?.serial, device?.alias, device?.group]);

  if (!device) return null;

  const run = async (label, fn) => {
    setLoading(label);
    try { await fn(); onRefresh?.(); }
    finally { setLoading(''); }
  };

  const handleSaveAlias = async () => {
    setLoading('alias');
    try {
      if (isMdm) {
        await window.mdm.setDeviceAlias(device.serial, nameTag);
      } else {
        await fetch('http://localhost:3010/devices/alias', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial: device.serial, alias: nameTag })
        });
      }
      onRefresh?.();
    } catch (err) {
      console.error('Failed to save alias:', err);
    } finally {
      setLoading('');
    }
  };

  const handleSaveGroup = async () => {
    setLoading('group');
    try {
      if (isMdm) {
        await window.mdm.setDeviceGroup(device.serial, groupTag);
      } else {
        await fetch('http://localhost:3010/devices/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial: device.serial, group: groupTag })
        });
      }
      onRefresh?.();
    } catch (err) {
      console.error('Failed to save group tag:', err);
    } finally {
      setLoading('');
    }
  };

  const handleClearDownload = async () => {
    if (!confirm("⚠️ 정말로 이 태블릿의 다운로드(Download) 폴더 내 모든 파일을 영구적으로 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.")) return;
    setLoading('clearDownload');
    try {
      let result;
      if (isMdm) {
        result = await window.mdm.clearDownloadFolder(device.serial);
      } else {
        const response = await fetch('http://localhost:3010/devices/clear-download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial: device.serial })
        });
        result = await response.json();
      }

      if (result && result.ok) {
        alert("🎉 다운로드 폴더의 모든 파일이 깨끗하게 청소되었습니다!");
      } else {
        throw new Error(result?.error || "작업을 완료할 수 없습니다.");
      }
    } catch (err) {
      console.error('Failed to clear download folder:', err);
      alert("오류가 발생했습니다: " + err.message);
    } finally {
      setLoading('');
    }
  };

  const handleGetLocation = async () => {
    setLoading('location');
    setLocationResult(null);
    try {
      let res;
      if (isMdm) {
        res = await window.mdm.getDeviceLocation(device.serial);
      } else {
        const response = await fetch('http://localhost:3010/devices/location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial: device.serial })
        });
        res = await response.json();
      }
      
      if (res.ok) {
        setLocationResult({ lat: res.lat, lng: res.lng });
      } else {
        setLocationResult({ error: res.error || '위치 정보를 가져올 수 없습니다.' });
      }
    } catch (err) {
      setLocationResult({ error: '위치 정보 요청 중 네트워크 오류가 발생했습니다.' });
    } finally {
      setLoading('');
    }
  };

  const loadApps = async () => {
    if (!isMdm) { setApps(['com.example.demo1', 'com.example.demo2']); setShowApps(true); return; }
    setLoading('apps');
    const list = await window.mdm.getApps(device.serial);
    setApps(list);
    setShowApps(true);
    setLoading('');
  };

  const handleUninstallApp = async (pkg) => {
    if (!confirm(`정말로 이 앱(${pkg})을 태블릿에서 삭제하시겠습니까?`)) return;
    setLoading('apps');
    try {
      if (isMdm) {
        await window.mdm.uninstallApp(device.serial, pkg);
      } else {
        await fetch('http://localhost:3010/devices/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial: device.serial, packageName: pkg })
        });
      }
      await loadApps();
    } catch (err) {
      console.error('Failed to uninstall app:', err);
    } finally {
      setLoading('');
    }
  };

  const d = device;
  const isOnline = d.state === 'online';

  return (
    <aside className="detail-panel animate-slide">
      {/* 헤더 */}
      <div className="dp-header">
        <div>
          <div className="dp-model">{d.model}</div>
          <div className="dp-serial">{d.serial}</div>
        </div>
        <button className="close-btn" onClick={onClose}>✕</button>
      </div>

      {/* 상태 정보 */}
      <div className="dp-section">
        <div className="section-title">📡 기기 정보</div>
        <div className="info-grid">
          <InfoRow label="상태" value={
            <span className={`badge ${isOnline ? 'badge-online' : 'badge-offline'}`}>
              {isOnline ? '🟢 온라인' : '🔴 오프라인'}
            </span>
          } />
          <InfoRow label="IP 주소" value={d.ip || '—'} mono />
          <InfoRow label="배터리" value={
            <span style={{ color: d.battery <= 20 ? '#ef4444' : '#22c55e', fontWeight: 700 }}>
              {d.charging ? '⚡' : ''} {d.battery}%
            </span>
          } />
          <InfoRow label="잠금" value={d.locked ? '🔒 잠금됨' : '🔓 해제됨'} />
          <InfoRow label="키오스크" value={d.kioskApp ? `✅ ${d.kioskApp}` : '미설정'} small />
          <InfoRow label="마지막 접속" value={new Date(d.lastSeen).toLocaleString()} small />
        </div>
      </div>

      {/* 기기 네임텍 설정 */}
      <div className="dp-section">
        <div className="section-title">🏷️ 기기 네임텍 설정</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="text"
            placeholder="예: 1분반 5번 태블릿"
            value={nameTag}
            onChange={e => setNameTag(e.target.value)}
            style={{
              flex: 1, fontSize: 12, padding: '6px 8px', borderRadius: 6,
              border: '1px solid var(--border)', background: 'var(--bg-card2)', color: 'var(--text)', outline: 'none'
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={loading === 'alias'}
            onClick={handleSaveAlias}
            style={{ padding: '6px 10px', flexShrink: 0 }}
          >
            {loading === 'alias' ? '...' : '저장'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!device.alias || loading === 'alias'}
            onClick={() => {
              setNameTag('');
              run('alias', () => isMdm
                ? window.mdm.setDeviceAlias(device.serial, '')
                : fetch('http://localhost:3010/devices/alias', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ serial: device.serial, alias: '' })
                  })
              );
            }}
            style={{ padding: '6px 10px', flexShrink: 0, background: '#fee2e2', color: '#dc2626' }}
          >
            삭제
          </button>
        </div>
      </div>

      {/* 실시간 위치 찾기 */}
      <div className="dp-section">
        <div className="section-title">📍 실시간 위치 찾기</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!isOnline || loading === 'location'}
            onClick={handleGetLocation}
            style={{ width: '100%', border: '1px solid var(--border)' }}
          >
            {loading === 'location' ? '🌐 실시간 위치 추적 중...' : '📍 GPS 위치 조회'}
          </button>
          
          {locationResult && (
            <div style={{
              background: 'var(--bg-card2)', padding: 10, borderRadius: 8, border: '1px solid var(--border)',
              fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6
            }}>
              {locationResult.error ? (
                <div style={{ color: '#dc2626', fontWeight: 600 }}>⚠️ {locationResult.error}</div>
              ) : (
                <>
                  <div style={{ color: 'var(--text)' }}>
                    • 위도(Lat): <strong style={{ fontFamily: 'var(--mono)' }}>{locationResult.lat}</strong><br/>
                    • 경도(Lng): <strong style={{ fontFamily: 'var(--mono)' }}>{locationResult.lng}</strong>
                  </div>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${locationResult.lat},${locationResult.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'block', textAlign: 'center', background: '#10b981', color: '#ffffff',
                      padding: '5px 10px', borderRadius: 6, textDecoration: 'none', fontWeight: 700, fontSize: 11.5
                    }}
                  >
                    🗺️ 구글 지도에서 실시간 위치 보기
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 화면 모니터링 */}
      <div className="dp-section">
        <div className="section-title">🖥️ 화면 모니터링</div>
        <button
          className="btn btn-primary"
          style={{ width: '100%', padding: '8px 0', fontSize: 13, fontWeight: 700 }}
          disabled={!isOnline}
          onClick={() => setShowMirror(true)}
        >
          🖥️ 실시간 화면 보기
        </button>
      </div>

      {/* 빠른 제어 */}
      <div className="dp-section">
        <div className="section-title">⚡ 빠른 제어</div>
        <div className="control-grid">
          <button
            className="btn btn-danger btn-sm"
            disabled={!isOnline || loading === 'lock'}
            onClick={() => run('lock', () => window.mdm?.lockDevice(d.serial))}
          >
            🔒 화면 잠금
          </button>
          <button
            className="btn btn-success btn-sm"
            disabled={!isOnline || loading === 'unlock'}
            onClick={() => run('unlock', () => window.mdm?.unlockDevice(d.serial))}
          >
            🔓 잠금 해제
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!isOnline || loading === 'clearDownload'}
            onClick={handleClearDownload}
            style={{ gridColumn: 'span 2', marginTop: 6, background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5' }}
          >
            {loading === 'clearDownload' ? '⏳ 삭제 중... 잠시만 기다려주세요' : '🗑️ 다운로드 폴더 전체 비우기'}
          </button>
        </div>
      </div>

      {/* 볼륨 제어 */}
      <div className="dp-section">
        <div className="section-title">🔊 볼륨 제어</div>
        <div className="volume-row">
          <input
            type="range" min={0} max={15} value={volume}
            onChange={e => setVolume(+e.target.value)}
            style={{ flex: 1 }}
          />
          <span className="vol-val">{volume}</span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!isOnline}
            onClick={() => run('vol', () => window.mdm?.setVolume(d.serial, volume))}
          >
            적용
          </button>
        </div>
      </div>

      {/* 키오스크 */}
      <div className="dp-section">
        <div className="section-title">🎯 키오스크 모드</div>
        <div className="kiosk-row">
          <input
            type="text"
            placeholder="앱 패키지명 (예: com.android.chrome)"
            value={kioskPkg}
            onChange={e => setKioskPkg(e.target.value)}
            style={{ flex: 1, fontSize: 12 }}
          />
        </div>
        <div className="control-grid" style={{ marginTop: 8 }}>
          <button
            className="btn btn-primary btn-sm"
            disabled={!isOnline || !kioskPkg}
            onClick={() => run('kiosk', () => window.mdm?.setKiosk(d.serial, kioskPkg))}
          >
            🎯 키오스크 설정
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!isOnline || !d.kioskApp}
            onClick={() => run('exitkiosk', () => window.mdm?.exitKiosk(d.serial))}
          >
            ❎ 해제
          </button>
        </div>
      </div>

      {/* 설치 앱 목록 */}
      <div className="dp-section">
        <div className="section-title">📦 설치된 앱</div>
        <button className="btn btn-ghost btn-sm" onClick={loadApps} disabled={loading === 'apps'}>
          {loading === 'apps' ? '불러오는 중...' : '앱 목록 조회'}
        </button>
        {showApps && (
          <div className="app-list">
            {apps.map(pkg => (
              <div key={pkg} className="app-row">
                <span className="app-pkg">{pkg}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ padding: '3px 8px', fontSize: 11, background: '#4f46e5', borderColor: '#4f46e5' }}
                    onClick={() => run('kiosk', () => {
                      setKioskPkg(pkg);
                      return window.mdm?.setKiosk(device.serial, pkg);
                    })}
                  >
                    🎯 지정
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    style={{ padding: '3px 8px', fontSize: 11 }}
                    onClick={() => window.mdm?.forceStopApp(device.serial, pkg)}
                  >
                    종료
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '3px 8px', fontSize: 11, background: '#fee2e2', color: '#dc2626' }}
                    onClick={() => handleUninstallApp(pkg)}
                  >
                    삭제
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showMirror && (
        <MirrorModal device={device} onClose={() => setShowMirror(false)} />
      )}

      <style jsx>{`
        .detail-panel {
          width: 300px;
          flex-shrink: 0;
          background: var(--bg-card);
          border-left: 1px solid var(--border);
          overflow-y: auto;
          height: 100vh;
          display: flex;
          flex-direction: column;
        }
        .dp-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          padding: 18px 16px;
          border-bottom: 1px solid var(--border);
          position: sticky;
          top: 0;
          background: var(--bg-card);
          z-index: 10;
        }
        .dp-model { font-size: 15px; font-weight: 700; color: var(--text); }
        .dp-serial { font-size: 11px; color: var(--text-muted); font-family: var(--mono); margin-top: 2px; }
        .close-btn {
          background: none; border: none; color: var(--text-muted);
          cursor: pointer; font-size: 16px; padding: 2px 6px;
          border-radius: 6px; transition: all 0.1s;
        }
        .close-btn:hover { background: var(--bg-card2); color: var(--text); }
        .dp-section {
          padding: 14px 16px;
          border-bottom: 1px solid var(--border);
        }
        .section-title {
          font-size: 12px;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 10px;
        }
        .info-grid { display: flex; flex-direction: column; gap: 7px; }
        .control-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .volume-row { display: flex; align-items: center; gap: 8px; }
        .vol-val {
          font-family: var(--mono);
          font-size: 12px;
          color: var(--primary);
          font-weight: 700;
          min-width: 20px;
          text-align: center;
        }
        .kiosk-row { display: flex; gap: 8px; align-items: center; }
        .app-list {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 200px;
          overflow-y: auto;
        }
        .app-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 5px 8px;
          background: var(--bg-card2);
          border-radius: 6px;
        }
        .app-pkg {
          font-size: 11px;
          font-family: var(--mono);
          color: var(--text-dim);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        input[type="range"] {
          background: transparent;
          padding: 0;
          -webkit-appearance: none;
          height: 4px;
          border-radius: 2px;
          background: var(--border-bright);
          border: none;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          background: var(--primary);
          border-radius: 50%;
          cursor: pointer;
        }
      `}</style>
    </aside>
  );
}

function InfoRow({ label, value, mono, small }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span 
        suppressHydrationWarning
        style={{
          fontSize: small ? 11 : 12,
          color: 'var(--text)',
          fontFamily: mono ? 'var(--mono)' : 'inherit',
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >{value}</span>
    </div>
  );
}
