import { useState, useEffect } from 'react';
import Head from 'next/head';
import Sidebar from '../components/Sidebar';
import DeviceGrid from '../components/DeviceGrid';
import DeviceDetail from '../components/DeviceDetail';
import ConnectModal from '../components/ConnectModal';
import BroadcastModal from '../components/BroadcastModal';
import FileDistributeModal from '../components/FileDistributeModal';
import ApkDownloadModal from '../components/ApkDownloadModal';

const isMdm = typeof window !== 'undefined' && !!window.mdm;

const DEMO_DEVICES = [];

export default function Dashboard() {
  const [devices, setDevices]             = useState(DEMO_DEVICES);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [activeTab, setActiveTab]         = useState('dashboard');
  const [showConnect, setShowConnect]     = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [showFileDistribute, setShowFileDistribute] = useState(false);
  const [showApkDownload, setShowApkDownload] = useState(false);
  const [showGuide, setShowGuide]         = useState(false);
  const [loading, setLoading]             = useState('');

  useEffect(() => {
    if (isMdm) {
      window.mdm.getDevices().then(d => { if (d?.length) setDevices(d); });
      window.mdm.onDeviceUpdate(setDevices);
      return () => window.mdm.removeDeviceUpdate();
    } else {
      // 일반 웹 브라우저 접속 환경: 3010 포트의 HTTP API를 주기적으로 호출(폴링)하여 동기화
      const fetchDevices = async () => {
        try {
          const res = await fetch('http://localhost:3010/devices');
          if (res.ok) {
            const data = await res.json();
            setDevices(data);
          }
        } catch (err) {
          console.error('Failed to fetch devices:', err);
        }
      };
      fetchDevices();
      const interval = setInterval(fetchDevices, 3000);
      return () => clearInterval(interval);
    }
  }, []);

  const stats = {
    total:      devices.length,
    online:     devices.filter(d => d.state === 'online').length,
    offline:    devices.filter(d => d.state === 'offline').length,
    locked:     devices.filter(d => d.locked).length,
    kiosk:      devices.filter(d => d.kioskApp).length,
    lowBattery: devices.filter(d => d.battery <= 20 && d.state === 'online').length,
  };

  const handleLockAll = async () => {
    if (!isMdm) { alert('⚠️ 실제 태블릿이 연결되어야 동작합니다.\n\n사용 방법:\n1. 태블릿에서 개발자 옵션 → 무선 디버깅 활성화\n2. 🔗 WiFi 연결 버튼으로 기기 연결'); return; }
    setLoading('lock');
    for (const d of devices.filter(d => d.state === 'online' && !d.locked))
      await window.mdm.lockDevice(d.serial);
    setLoading('');
  };
  const handleUnlockAll = async () => {
    if (!isMdm) { alert('⚠️ 실제 태블릿이 연결되어야 동작합니다.'); return; }
    setLoading('unlock');
    for (const d of devices.filter(d => d.state === 'online' && d.locked))
      await window.mdm.unlockDevice(d.serial);
    setLoading('');
  };

  const tabLabel = { dashboard:'📊 대시보드', devices:'📱 기기 관리', kiosk:'🔒 키오스크', apps:'📦 앱 관리', logs:'📋 이용 로그' };

  return (
    <>
      <Head><title>School MDM · 학교 태블릿 관리 시스템</title></Head>

      <div style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
        <Sidebar activeTab={activeTab} onTabChange={setActiveTab} stats={stats} />

        <main style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0, background:'#f0f4f8' }}>

          {/* ── 상단바 ── */}
          <header style={{
            display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'11px 20px', flexShrink:0,
            borderBottom:'1px solid #e2e8f0',
            background:'#ffffff', gap:12, flexWrap:'wrap',
            boxShadow:'0 1px 3px rgba(0,0,0,0.07)',
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <h1 style={{ fontSize:19, fontWeight:800, color:'#0f172a' }}>{tabLabel[activeTab]}</h1>
              <span style={{
                display:'flex', alignItems:'center', gap:6,
                fontSize:11.5, fontWeight:700, color:'#16a34a',
                background:'#dcfce7', border:'1px solid #86efac',
                padding:'3px 10px', borderRadius:99,
              }}>
                <span style={{ width:7, height:7, background:'#16a34a', borderRadius:'50%', display:'inline-block', animation:'pulse-dot 1.5s infinite' }}/>
                실시간 연동
              </span>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowGuide(true)}>❓ 사용법</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowConnect(true)}>🔗 WiFi 연결</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowApkDownload(true)}>📲 APK 다운로드</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowBroadcast(true)}>📢 전체 알림</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowFileDistribute(true)}>📁 파일 배포</button>
              <div style={{ width:1, height:24, background:'#e2e8f0', margin:'0 2px' }} />
              <button className="btn btn-danger btn-sm" onClick={handleLockAll} disabled={!!loading}>
                🔒 {loading==='lock' ? '처리 중...' : '전체 잠금'}
              </button>
              <button className="btn btn-success btn-sm" onClick={handleUnlockAll} disabled={!!loading}>
                🔓 {loading==='unlock' ? '처리 중...' : '전체 해제'}
              </button>
            </div>
          </header>

          {/* ── 통계 카드 ── */}
          {activeTab === 'dashboard' && (
            <div style={{
              display:'grid', gridTemplateColumns:'repeat(6,1fr)',
              gap:12, padding:'16px 20px 0', flexShrink:0,
            }} className="animate-fade">
              <StatCard icon="📱" label="전체 기기" value={stats.total}      accent="#4f46e5" bg="#eef2ff" />
              <StatCard icon="🟢" label="온라인"    value={stats.online}     accent="#16a34a" bg="#dcfce7" />
              <StatCard icon="🔴" label="오프라인"  value={stats.offline}    accent="#dc2626" bg="#fee2e2" />
              <StatCard icon="🔒" label="잠금됨"    value={stats.locked}     accent="#d97706" bg="#fef3c7" />
              <StatCard icon="🎯" label="키오스크"  value={stats.kiosk}      accent="#0891b2" bg="#cffafe" />
              <StatCard icon="🪫" label="저배터리"  value={stats.lowBattery} accent="#dc2626" bg="#fee2e2" />
            </div>
          )}

          {/* ── 기기 그리드 ── */}
          <div style={{ flex:1, overflowY:'auto', padding:'14px 20px 20px' }} className="animate-fade">
            <DeviceGrid devices={devices} onSelect={setSelectedDevice} selected={selectedDevice} filter={activeTab} />
          </div>
        </main>

        {/* ── 상세 패널 ── */}
        {selectedDevice && (
          <DeviceDetail
            device={devices.find(d => d.serial === selectedDevice) ?? null}
            onClose={() => setSelectedDevice(null)}
            onRefresh={() => window.mdm?.getDevices().then(setDevices)}
          />
        )}
      </div>

      {showConnect   && <ConnectModal onClose={() => setShowConnect(false)} />}
      {showApkDownload && <ApkDownloadModal onClose={() => setShowApkDownload(false)} />}
      {showBroadcast && <BroadcastModal devices={devices.filter(d => d.state==='online')} onClose={() => setShowBroadcast(false)} />}
      {showFileDistribute && <FileDistributeModal devices={devices} onClose={() => setShowFileDistribute(false)} />}
      {showGuide     && <GuideModal onClose={() => setShowGuide(false)} />}
    </>
  );
}

/* ── 통계 카드 ── */
function StatCard({ icon, label, value, accent, bg }) {
  return (
    <div style={{
      background:'#ffffff', border:`1.5px solid ${accent}33`,
      borderRadius:12, padding:'14px',
      boxShadow:'0 1px 4px rgba(0,0,0,0.07)',
      display:'flex', flexDirection:'column', gap:4,
      transition:'transform 0.14s, box-shadow 0.14s', cursor:'default',
    }}
    onMouseEnter={e => { e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow='0 6px 18px rgba(0,0,0,0.12)'; }}
    onMouseLeave={e => { e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow='0 1px 4px rgba(0,0,0,0.07)'; }}
    >
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <span style={{ fontSize:20 }}>{icon}</span>
        <span style={{ background:bg, color:accent, fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:99 }}>{label}</span>
      </div>
      <div style={{ fontSize:38, fontWeight:800, color:accent, lineHeight:1, letterSpacing:'-1px', marginTop:4 }}>{value}</div>
      <div style={{ fontSize:12.5, fontWeight:600, color:'#64748b' }}>{label}</div>
    </div>
  );
}

/* ── 사용법 모달 ── */
function GuideModal({ onClose }) {
  const steps = [
    { icon:'🔧', title:'개발자 옵션 활성화', desc:'태블릿 설정 → 소프트웨어 정보 → 빌드 번호를 7번 탭하여 개발자 모드를 활성화합니다.' },
    { icon:'📶', title:'무선 디버깅 켜기', desc:'설정 → 개발자 옵션 → 무선 디버깅 ON → "IP 주소 및 포트" 메모합니다.' },
    { icon:'🔗', title:'WiFi 연결', desc:'이 앱에서 🔗 WiFi 연결 버튼 → 태블릿의 IP:포트 입력 → 연결합니다. (PC와 태블릿이 같은 WiFi여야 함)' },
    { icon:'📱', title:'기기 확인', desc:'연결 성공 시 대시보드에 태블릿이 자동으로 나타납니다. 카드를 클릭하면 오른쪽에 제어 패널이 열립니다.' },
    { icon:'🔒', title:'화면 잠금/해제', desc:'기기 카드 클릭 → 오른쪽 패널에서 "화면 잠금" 버튼. 또는 상단 "전체 잠금"으로 모든 기기를 한 번에 잠급니다.' },
    { icon:'🎯', title:'키오스크 모드', desc:'특정 앱만 실행되도록 고정합니다. 앱 패키지명 입력 (예: com.android.chrome) → 키오스크 설정.' },
    { icon:'📢', title:'전체 알림 전송', desc:'상단 📢 전체 알림 버튼 → 메시지 입력 → 전송. 연결된 모든 온라인 기기에 알림이 전달됩니다.' },
  ];
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,23,42,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }} onClick={onClose}>
      <div style={{ background:'#fff', borderRadius:16, width:560, maxHeight:'85vh', overflow:'hidden', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }} onClick={e=>e.stopPropagation()}>
        <div style={{ padding:'20px 24px', borderBottom:'1px solid #e2e8f0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <h2 style={{ fontSize:18, fontWeight:800, color:'#0f172a' }}>📖 사용 방법</h2>
            <p style={{ fontSize:12.5, color:'#64748b', marginTop:3 }}>현재 데모 모드입니다. 실제 제어는 태블릿 연결 후 가능합니다.</p>
          </div>
          <button onClick={onClose} style={{ background:'#f1f5f9', border:'none', width:32, height:32, borderRadius:8, cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center' }}>✕</button>
        </div>
        <div style={{ overflowY:'auto', padding:'16px 24px', display:'flex', flexDirection:'column', gap:12 }}>
          {steps.map((s,i) => (
            <div key={i} style={{ display:'flex', gap:14, padding:'14px', background:'#f8fafc', borderRadius:10, border:'1px solid #e2e8f0' }}>
              <div style={{ width:36, height:36, background:'#eef2ff', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>{s.icon}</div>
              <div>
                <div style={{ fontSize:13.5, fontWeight:700, color:'#0f172a', marginBottom:3 }}>
                  <span style={{ color:'#4f46e5', marginRight:6 }}>Step {i+1}</span>{s.title}
                </div>
                <div style={{ fontSize:12.5, color:'#475569', lineHeight:1.6 }}>{s.desc}</div>
              </div>
            </div>
          ))}
          <div style={{ padding:'12px 14px', background:'#fef3c7', borderRadius:10, border:'1px solid #fde68a' }}>
            <div style={{ fontSize:13, fontWeight:700, color:'#92400e', marginBottom:4 }}>⚠️ 주의사항</div>
            <div style={{ fontSize:12.5, color:'#78350f', lineHeight:1.6 }}>
              • 태블릿과 관리 PC가 <strong>동일한 WiFi 네트워크</strong>에 연결되어 있어야 합니다<br/>
              • 태블릿에서 무선 디버깅을 허용할 때 <strong>이 PC를 신뢰</strong>로 설정해야 합니다<br/>
              • ADB가 PC에 설치되어 있거나 PATH에 등록되어 있어야 합니다
            </div>
          </div>
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid #e2e8f0', display:'flex', justifyContent:'flex-end' }}>
          <button className="btn btn-primary" onClick={onClose}>확인했습니다</button>
        </div>
      </div>
    </div>
  );
}
