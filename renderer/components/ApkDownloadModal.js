import { useState, useEffect } from 'react';

const isMdm = typeof window !== 'undefined' && !!window.mdm;

export default function ApkDownloadModal({ onClose }) {
  const [serverConfig, setServerConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const loadConfig = async () => {
      if (isMdm) {
        try {
          const cfg = await window.mdm.getServerConfig();
          if (mounted && cfg) {
            setServerConfig(cfg);
          }
        } catch (e) {
          console.error('Failed to load server config:', e);
        } finally {
          if (mounted) setLoading(false);
        }
      } else {
        // 일반 브라우저: 현재 접속한 주소 사용
        const hostname = window.location.hostname;
        if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
          if (mounted) setServerConfig({ url: `http://${hostname}:3010`, mode: 'local' });
        }
        if (mounted) setLoading(false);
      }
    };
    loadConfig();
    return () => { mounted = false; };
  }, []);

  const getApkUrl = () => {
    if (serverConfig) return `${serverConfig.url}/apk`;
    return '';
  };

  if (loading) {
    return (
      <div className="modal-overlay" onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
      }}>
        <div className="modal glass animate-fade" onClick={e => e.stopPropagation()} style={{
          background: '#ffffff', borderRadius: 16, width: 420, padding: 24,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 16
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: 12 }}>
            <h2 style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', margin: 0 }}>📲 태블릿 앱(APK) 무선 다운로드</h2>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16, padding: 4
            }}>✕</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 0' }}>
            <div style={{ width: 180, height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12, background: '#f8fafc', borderRadius: 12, border: '1px dashed #cbd5e1' }}>
              서버 설정 로드 중...
            </div>
            <p style={{ fontSize: 12.5, color: '#64748b', textAlign: 'center', margin: 0 }}>네트워크 모드 확인 중...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!serverConfig) {
    return (
      <div className="modal-overlay" onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
      }}>
        <div className="modal glass animate-fade" onClick={e => e.stopPropagation()} style={{
          background: '#ffffff', borderRadius: 16, width: 420, padding: 24,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 16
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: 12 }}>
            <h2 style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', margin: 0 }}>📲 태블릿 앱(APK) 무선 다운로드</h2>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16, padding: 4
            }}>✕</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 0', textAlign: 'center' }}>
            <div style={{ width: 180, height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', fontSize: 12, background: '#fef2f2', borderRadius: 12, border: '1px solid #fecaca' }}>
              서버 정보를 가져올 수 없습니다.
            </div>
            <p style={{ fontSize: 12.5, color: '#64748b', margin: 0 }}>
              Electron 앱에서 실행 중인지 확인하세요.
            </p>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid #e2e8f0', paddingTop: 14 }}>
            <button className="btn btn-primary" onClick={onClose} style={{ padding: '8px 16px', fontSize: 12.5 }}>닫기</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div className="modal glass animate-fade" onClick={e => e.stopPropagation()} style={{
        background: '#ffffff', borderRadius: 16, width: 420, padding: 24,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 16
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: 12 }}>
          <h2 style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', margin: 0 }}>📲 태블릿 앱(APK) 무선 다운로드</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16, padding: 4
          }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '10px 0' }}>
          <p style={{ fontSize: 12.5, color: '#64748b', textAlign: 'center', margin: 0, lineHeight: 1.6 }}>
            태블릿의 기본 카메라 또는 QR 스캐너를 켜고<br/>아래 QR 코드를 비추면 <strong>앱(APK)이 즉시 다운로드</strong>됩니다.
          </p>

          {/* 현재 네트워크 모드 표시 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, fontSize: 11.5, color: '#166534' }}>
            <span>{serverConfig.mode === 'local' ? '📶' : '🌐'}</span>
            <strong>{serverConfig.mode === 'local' ? '로컬 WiFi 모드' : '외부망(Cloudflare) 모드'}</strong>
            <span style={{ color: '#166534', opacity: 0.7 }}>자동 감지됨</span>
          </div>

          <div style={{
            padding: 12, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0',
            boxShadow: '0 4px 14px rgba(0,0,0,0.06)', marginTop: 8
          }}>
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(getApkUrl())}`}
              alt="APK Download QR Code"
              style={{ width: 180, height: 180, display: 'block' }}
            />
          </div>

          <div style={{
            background: '#f8fafc', padding: '10px 14px', borderRadius: 8, border: '1px solid #e2e8f0',
            width: '100%', display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b' }}>무선 다운로드 직접 링크:</span>
            <a href={getApkUrl()} target="_blank" rel="noreferrer" style={{
              fontSize: 12, color: '#4f46e5', fontWeight: 600, textDecoration: 'underline', wordBreak: 'break-all'
            }}>
              {getApkUrl()}
            </a>
          </div>

          {/* 수동 서버 URL 수정 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', justifyContent: 'center', marginTop: 4 }}>
            <span style={{ fontSize: 11.5, color: '#475569', fontWeight: 600 }}>서버 URL 수정:</span>
            <input
              type="text"
              value={serverConfig.url}
              onChange={e => {
                const val = e.target.value;
                setServerConfig(prev => prev ? {...prev, url: val} : null);
              }}
              style={{
                fontSize: 12, fontFamily: 'monospace', width: 280, padding: '4px 8px',
                border: '1px solid #cbd5e1', borderRadius: 6, outline: 'none'
              }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid #e2e8f0', paddingTop: 14 }}>
          <button className="btn btn-primary" onClick={onClose} style={{ padding: '8px 16px', fontSize: 12.5 }}>닫기</button>
        </div>
      </div>
    </div>
  );
}