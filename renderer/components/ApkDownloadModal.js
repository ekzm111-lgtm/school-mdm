import { useState } from 'react';

export default function ApkDownloadModal({ onClose }) {
  const staticUrl = "nonepithelial-unbased-reece.ngrok-free.dev";
  const [serverUrl, setServerUrl] = useState(staticUrl);

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

          <div style={{
            padding: 12, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0',
            boxShadow: '0 4px 14px rgba(0,0,0,0.06)', marginTop: 8
          }}>
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent('https://' + serverUrl + '/apk')}`}
              alt="APK Download QR Code"
              style={{ width: 180, height: 180, display: 'block' }}
            />
          </div>

          <div style={{
            background: '#f8fafc', padding: '10px 14px', borderRadius: 8, border: '1px solid #e2e8f0',
            width: '100%', display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b' }}>무선 다운로드 직접 링크:</span>
            <a href={`https://${serverUrl}/apk`} target="_blank" rel="noreferrer" style={{
              fontSize: 12, color: '#4f46e5', fontWeight: 600, textDecoration: 'underline', wordBreak: 'break-all'
            }}>
              https://{serverUrl}/apk
            </a>
          </div>

          {/* 수동 도메인/IP 변경 제공 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', justifyContent: 'center', marginTop: 4 }}>
            <span style={{ fontSize: 11.5, color: '#475569', fontWeight: 600 }}>서버 도메인 수정:</span>
            <input
              type="text"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              style={{
                fontSize: 12, fontFamily: 'monospace', width: 220, padding: '4px 8px',
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
