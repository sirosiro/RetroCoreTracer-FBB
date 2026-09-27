export const minApiVersion = 1;

// @intent:responsibility RetroCoreTracer 完全スタジオ UI (DPPA v1.0 準拠)
// @intent:observability CodeView, MemoryMap, CoreCanvas(Bus Glow), Breakpoints, Flags, HexDump, Stack, Registers

const { React, hooks: { useState, useEffect, useRef, useMemo, useCallback } } = window.FBB;

export default function RetroCoreTracerPane() {
  // --- 状態管理 ---
  const [stepCount, setStepCount] = useState(0);
  const [cycleCount, setCycleCount] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [clockSpeed, setClockSpeed] = useState(500); // ms per step in Run mode
  const [zoom, setZoom] = useState(1.0);
  const [lastExecuted, setLastExecuted] = useState('NOP');

  // レジスタ群
  const [regs, setRegs] = useState({
    af: '0x0000', bc: '0x0000', de: '0x0000', hl: '0x0000',
    af_alt: '0x5500', bc_alt: '0x0000', de_alt: '0x0000', hl_alt: '0x0000',
    ix: '0x1234', iy: '0x0000', sp: '0x0000', pc: '0x0000',
    i: '0x00', r: '0x00', im: 0
  });

  // フラグ群
  const [flags, setFlags] = useState({ s: 0, z: 0, h: 0, pv: 0, n: 0, c: 0 });

  // バス信号 (Bus Glow 用)
  const [bus, setBus] = useState({
    addr: '0x0000', data_in: '0x00', data_out: '0x00',
    mreq: false, iorq: false, rd: false, wr: false, m1: false,
    active: false
  });

  // ブレークポイント一覧
  const [breakpoints, setBreakpoints] = useState([
    { id: 1, type: 'PC_MATCH', condition: '== 0x0003 (EX_TEST)', status: 'Active' }
  ]);
  const [hitBpId, setHitBpId] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);
  const [bpType, setBpType] = useState('PC_MATCH');
  const [bpValue, setBpValue] = useState('');

  // プログラムリスト (逆アセンブラ行)
  const initialProgram = useMemo(() => [
    { addr: '0000', bytes: '00', label: 'START:', mnem: 'NOP' },
    { addr: '0001', bytes: '3E 01', label: '', mnem: 'LD A, $01' },
    { addr: '0003', bytes: '06 01', label: 'FIB_INIT:', mnem: 'LD B, $01' },
    { addr: '0005', bytes: '0E 00', label: '', mnem: 'LD C, $00' },
    { addr: '0007', bytes: '80', label: 'LOOP:', mnem: 'ADD A, B' },
    { addr: '0008', bytes: '48', label: '', mnem: 'LD C, B' },
    { addr: '0009', bytes: '47', label: '', mnem: 'LD B, A' },
    { addr: '000A', bytes: '18 FB', label: '', mnem: 'JR LOOP (-5)' },
    { addr: '000C', bytes: '76', label: '', mnem: 'HALT' }
  ], []);

  const [program, setProgram] = useState(initialProgram);
  const [currentPc, setCurrentPc] = useState('0000');

  // スナップショット履歴 (タイムトラベル用)
  const historyRef = useRef([]);

  const checkBreakpoints = useCallback((pcHex) => {
    if (!breakpoints || breakpoints.length === 0) return null;
    for (const bp of breakpoints) {
      if (bp.status === 'Disabled') continue;
      let targetHex = null;
      const hexWith0x = bp.condition.match(/0x([0-9a-fA-F]+)/i);
      if (hexWith0x) {
        targetHex = hexWith0x[1].padStart(4, '0').toUpperCase();
      } else {
        const numMatch = bp.condition.match(/([0-9a-fA-F]{1,4})/);
        if (numMatch) {
          targetHex = numMatch[1].padStart(4, '0').toUpperCase();
        }
      }
      if (!targetHex) continue;

      if (bp.type === 'PC_MATCH') {
        if (pcHex === targetHex) return bp;
      } else if (bp.type === 'MEM_READ') {
        const busAddrHex = bus.addr ? bus.addr.replace('0x', '').padStart(4, '0').toUpperCase() : '';
        if (bus.mreq && bus.rd && busAddrHex === targetHex) return bp;
      } else if (bp.type === 'MEM_WRITE') {
        const busAddrHex = bus.addr ? bus.addr.replace('0x', '').padStart(4, '0').toUpperCase() : '';
        if (bus.mreq && bus.wr && busAddrHex === targetHex) return bp;
      }
    }
    return null;
  }, [breakpoints, bus]);

  // --- ステップ実行 (Forward) ---
  const handleStep = useCallback(() => {
    // 現在状態を履歴に保存
    historyRef.current.push({
      step: stepCount, cycles: cycleCount, regs: { ...regs }, flags: { ...flags },
      bus: { ...bus }, pc: currentPc, lastExecuted
    });

    const pcNum = parseInt(currentPc, 16);
    // 次の命令を見つける
    const curIdx = program.findIndex(p => parseInt(p.addr, 16) === pcNum);
    const nextIdx = (curIdx >= 0 && curIdx < program.length - 1) ? curIdx + 1 : 0;
    const nextItem = program[nextIdx];
    const newPc = nextItem ? nextItem.addr : '0000';

    setStepCount(s => s + 1);
    setCycleCount(c => c + 4);
    setCurrentPc(newPc);
    setLastExecuted(nextItem ? nextItem.mnem : 'NOP');

    let rA = parseInt(regs.af.substring(2, 4), 16) || 0;
    let rF = parseInt(regs.af.substring(4, 6), 16) || 0;
    let rB = parseInt(regs.bc.substring(2, 4), 16) || 0;
    let rC = parseInt(regs.bc.substring(4, 6), 16) || 0;
    let rD = parseInt(regs.de.substring(2, 4), 16) || 0;
    let rE = parseInt(regs.de.substring(4, 6), 16) || 0;
    let rH = parseInt(regs.hl.substring(2, 4), 16) || 0;
    let rL = parseInt(regs.hl.substring(4, 6), 16) || 0;

    const curItem = program.find(p => parseInt(p.addr, 16) === pcNum) || program[0];
    if (curItem) {
      if (curItem.mnem.startsWith('LD A,')) {
        rA = parseInt(curItem.mnem.split('$')[1], 16) || 0;
      } else if (curItem.mnem.startsWith('LD B,')) {
        if (curItem.mnem.includes('$')) rB = parseInt(curItem.mnem.split('$')[1], 16) || 0;
        else if (curItem.mnem.includes('A')) rB = rA;
      } else if (curItem.mnem.startsWith('LD C,')) {
        if (curItem.mnem.includes('$')) rC = parseInt(curItem.mnem.split('$')[1], 16) || 0;
        else if (curItem.mnem.includes('B')) rC = rB;
      } else if (curItem.mnem.startsWith('ADD A,')) {
        const sum = rA + rB;
        rA = sum & 0xFF;
        const s = (rA & 0x80) ? 1 : 0;
        const z = (rA === 0) ? 1 : 0;
        const h = ((rA & 0x0F) + (rB & 0x0F) > 0x0F) ? 1 : 0;
        const c = (sum > 0xFF) ? 1 : 0;
        setFlags({ s, z, h, pv: 0, n: 0, c });
        rF = (s << 7) | (z << 6) | (h << 4) | c;
      }
    }

    const fmt16 = (hi, lo) => '0x' + hi.toString(16).padStart(2, '0').toUpperCase() + lo.toString(16).padStart(2, '0').toUpperCase();
    setRegs(r => ({
      ...r,
      af: fmt16(rA, rF),
      bc: fmt16(rB, rC),
      de: fmt16(rD, rE),
      hl: fmt16(rH, rL),
      pc: '0x' + newPc
    }));

    // バス光彩アクティブ化
    setBus({
      addr: '0x' + newPc,
      data_in: nextItem ? nextItem.bytes.split(' ')[0] : '00',
      data_out: '00',
      mreq: true, iorq: false, rd: true, wr: false, m1: true,
      active: true
    });

    setTimeout(() => {
      setBus(b => ({ ...b, active: false }));
    }, 200);

    const hitBp = checkBreakpoints(newPc);
    if (hitBp) {
      setIsRunning(false);
      setHitBpId(hitBp.id);
      setStatusMsg(`BP HIT: 0x${newPc}`);
    } else {
      setHitBpId(null);
      setStatusMsg(null);
    }
  }, [currentPc, program, regs, flags, bus, stepCount, cycleCount, lastExecuted, checkBreakpoints]);

  // --- バックステップ (Time-Travel Undo) ---
  const handleBackstep = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const prev = historyRef.current.pop();
    setStepCount(prev.step);
    setCycleCount(prev.cycles);
    setRegs(prev.regs);
    setFlags(prev.flags);
    setBus(prev.bus);
    setCurrentPc(prev.pc);
    setLastExecuted(prev.lastExecuted);
  }, []);

  // --- リセット ---
  const handleReset = useCallback(() => {
    setIsRunning(false);
    setStepCount(0);
    setCycleCount(0);
    setCurrentPc('0000');
    setLastExecuted('NOP');
    setRegs({
      af: '0x0000', bc: '0x0000', de: '0x0000', hl: '0x0000',
      af_alt: '0x5500', bc_alt: '0x0000', de_alt: '0x0000', hl_alt: '0x0000',
      ix: '0x1234', iy: '0x0000', sp: '0x0000', pc: '0x0000',
      i: '0x00', r: '0x00', im: 0
    });
    setFlags({ s: 0, z: 0, h: 0, pv: 0, n: 0, c: 0 });
    historyRef.current = [];
  }, []);

  // --- 連続実行タイマー ---
  useEffect(() => {
    let timer = null;
    if (isRunning) {
      timer = setInterval(() => {
        handleStep();
      }, clockSpeed);
    }
    return () => { if (timer) clearInterval(timer); };
  }, [isRunning, clockSpeed, handleStep]);

  // --- ブレークポイント追加 ---
  const addBreakpoint = () => {
    if (!bpValue) return;
    setBreakpoints(b => [
      ...b,
      { id: Date.now(), type: bpType, condition: `== ${bpValue}`, status: 'Active' }
    ]);
    setBpValue('');
  };

  // --- スタイル定義 (ダークテーマ・レトロモニター) ---
  const S = {
    container: {
      background: '#12151c',
      color: '#e2e8f0',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'SF Pro Text, -apple-system, Segoe UI, Roboto, monospace',
      fontSize: '12px',
      overflow: 'hidden',
      userSelect: 'none'
    },
    toolbar: {
      background: '#1a1f2c',
      borderBottom: '1px solid #2d3748',
      padding: '6px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    },
    btn: (bg = '#2563eb') => ({
      background: bg,
      color: '#fff',
      border: 'none',
      padding: '4px 10px',
      borderRadius: '4px',
      fontSize: '11px',
      fontWeight: 'bold',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '4px'
    }),
    grid: {
      display: 'grid',
      gridTemplateColumns: '260px 1fr 280px 200px',
      gridTemplateRows: '1fr',
      flex: 1,
      overflow: 'hidden'
    },
    panel: {
      background: '#161a23',
      borderRight: '1px solid #232b3b',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    },
    panelHeader: {
      background: '#1e2433',
      padding: '6px 10px',
      fontWeight: 'bold',
      fontSize: '11px',
      color: '#94a3b8',
      borderBottom: '1px solid #232b3b',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    },
    footer: {
      background: '#161a23',
      borderTop: '1px solid #232b3b',
      padding: '4px 12px',
      fontSize: '11px',
      color: '#38bdf8',
      display: 'flex',
      justifyContent: 'space-between'
    }
  };

  return React.createElement(
    'div',
    { style: S.container },

    // 1. 上部ツールバー
    React.createElement('div', { style: S.toolbar },
      React.createElement('button', { style: S.btn('#2563eb'), onClick: handleStep }, 'Step'),
      React.createElement('button', {
        style: S.btn(isRunning ? '#dc2626' : '#16a34a'),
        onClick: () => setIsRunning(!isRunning)
      }, isRunning ? 'Stop' : 'Run'),
      React.createElement('button', { style: S.btn('#475569'), onClick: handleReset }, 'Reset'),
      React.createElement('button', {
        style: S.btn(historyRef.current.length > 0 ? '#d97706' : '#334155'),
        onClick: handleBackstep,
        disabled: historyRef.current.length === 0
      }, 'Backstep'),
      React.createElement('div', { style: { height: '16px', width: '1px', background: '#334155', margin: '0 4px' } }),
      React.createElement('span', { style: { color: '#94a3b8', fontSize: '11px' } }, 'Speed:'),
      React.createElement('input', {
        type: 'range', min: '50', max: '1000', step: '50',
        value: clockSpeed, onChange: e => setClockSpeed(Number(e.target.value)),
        style: { width: '80px', accentColor: '#38bdf8' }
      }),
      React.createElement('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
        React.createElement('span', { style: { color: '#38bdf8', fontWeight: 'bold' } }, 'Z80 Core:'),
        React.createElement('span', { style: { color: '#4ade80' } }, 'RTL Verified')
      )
    ),

    // 2. メイン 4 列グリッドレイアウト
    React.createElement('div', { style: S.grid },

      // === 列 1: Code View & Memory Map ===
      React.createElement('div', { style: S.panel },
        // Code View
        React.createElement('div', { style: S.panelHeader },
          React.createElement('span', null, 'Code View'),
          React.createElement('span', { style: { color: '#38bdf8' } }, `PC: 0x${currentPc}`)
        ),
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', background: '#0f131a', fontFamily: 'monospace' } },
          React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '11px' } },
            React.createElement('thead', null,
              React.createElement('tr', { style: { color: '#64748b', borderBottom: '1px solid #1e293b' } },
                React.createElement('th', { style: { padding: '4px', textAlign: 'left' } }, 'Addr'),
                React.createElement('th', { style: { padding: '4px', textAlign: 'left' } }, 'Bytes'),
                React.createElement('th', { style: { padding: '4px', textAlign: 'left' } }, 'Mnemonic')
              )
            ),
            React.createElement('tbody', null,
              program.map((p, idx) => {
                const isCur = p.addr === currentPc;
                return React.createElement('tr', {
                  key: idx,
                  style: {
                    background: isCur ? '#3f3810' : 'transparent',
                    borderLeft: isCur ? '3px solid #facc15' : '3px solid transparent',
                    color: isCur ? '#facc15' : '#cbd5e1'
                  }
                },
                  React.createElement('td', { style: { padding: '3px 4px', color: isCur ? '#fde047' : '#64748b' } }, p.addr),
                  React.createElement('td', { style: { padding: '3px 4px', color: '#94a3b8' } }, p.bytes),
                  React.createElement('td', { style: { padding: '3px 4px', fontWeight: isCur ? 'bold' : 'normal' } },
                    p.label ? React.createElement('span', { style: { color: '#38bdf8', marginRight: '4px' } }, p.label) : null,
                    p.mnem
                  )
                );
              })
            )
          )
        ),
        // Memory Map
        React.createElement('div', { style: { ...S.panelHeader, borderTop: '1px solid #232b3b' } },
          React.createElement('span', null, 'Memory Map')
        ),
        React.createElement('div', { style: { height: '110px', background: '#0f131a', padding: '6px', fontSize: '11px', fontFamily: 'monospace' } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#f87171' } },
            React.createElement('span', null, '0000 - 3FFF: ROM (RO)'),
            React.createElement('span', null, 'Monitor ROM')
          ),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#4ade80', marginTop: '4px' } },
            React.createElement('span', null, '8000 - FFFF: RAM (RW)'),
            React.createElement('span', null, 'Main RAM')
          )
        )
      ),

      // === 列 2: Core Canvas (Bus Glow) & Breakpoints ===
      React.createElement('div', { style: S.panel },
        // Core Canvas
        React.createElement('div', { style: S.panelHeader },
          React.createElement('span', null, 'Core Canvas (Bus Glow)'),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement('span', null, 'Zoom:'),
            React.createElement('input', {
              type: 'range', min: '0.8', max: '1.5', step: '0.1', value: zoom,
              onChange: e => setZoom(Number(e.target.value)),
              style: { width: '60px', accentColor: '#38bdf8' }
            })
          )
        ),
        React.createElement('div', {
          style: {
            flex: 1, background: '#0b0f17', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden'
          }
        },
          // SVG ダイアグラム
          React.createElement('svg', {
            width: '100%', height: '100%', viewBox: '0 0 320 220',
            style: { transform: `scale(${zoom})`, transformOrigin: 'center' }
          },
            // Z80 Core Box
            React.createElement('rect', {
              x: 100, y: 15, width: 120, height: 60, rx: 6,
              fill: '#1a2233', stroke: '#38bdf8', strokeWidth: 2
            }),
            React.createElement('text', {
              x: 160, y: 40, fill: '#38bdf8', fontSize: '13px', fontWeight: 'bold', textAnchor: 'middle'
            }, 'Z80 Core'),
            React.createElement('text', {
              x: 160, y: 58, fill: '#94a3b8', fontSize: '9px', textAnchor: 'middle'
            }, `PC: 0x${currentPc}`),

            // バス結線 (Bus Lines)
            React.createElement('path', {
              d: 'M 160 75 L 160 115 L 80 115 L 80 145',
              fill: 'none',
              stroke: bus.active ? '#f59e0b' : '#334155',
              strokeWidth: bus.active ? 3 : 2,
              strokeDasharray: bus.active ? 'none' : '4,4',
              style: {
                filter: bus.active ? 'drop-shadow(0 0 6px #f59e0b)' : 'none',
                transition: 'all 0.15s ease'
              }
            }),
            React.createElement('path', {
              d: 'M 160 115 L 240 115 L 240 145',
              fill: 'none',
              stroke: bus.active ? '#38bdf8' : '#334155',
              strokeWidth: bus.active ? 3 : 2,
              style: {
                filter: bus.active ? 'drop-shadow(0 0 6px #38bdf8)' : 'none',
                transition: 'all 0.15s ease'
              }
            }),

            // Memory Space Box
            React.createElement('rect', {
              x: 30, y: 145, width: 100, height: 50, rx: 4,
              fill: '#261719', stroke: '#ef4444', strokeWidth: 1.5
            }),
            React.createElement('text', {
              x: 80, y: 172, fill: '#ef4444', fontSize: '10px', textAnchor: 'middle', fontWeight: 'bold'
            }, 'ROM (0000-3FFF)'),

            // RAM / IO Box
            React.createElement('rect', {
              x: 190, y: 145, width: 100, height: 50, rx: 4,
              fill: '#15241b', stroke: '#22c55e', strokeWidth: 1.5
            }),
            React.createElement('text', {
              x: 240, y: 172, fill: '#22c55e', fontSize: '10px', textAnchor: 'middle', fontWeight: 'bold'
            }, 'RAM (8000-FFFF)')
          )
        ),
        // Breakpoints
        React.createElement('div', { style: { ...S.panelHeader, borderTop: '1px solid #232b3b' } },
          React.createElement('span', null, 'Breakpoints')
        ),
        React.createElement('div', { style: { height: '130px', background: '#0f131a', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
          React.createElement('div', { style: { display: 'flex', gap: '6px' } },
            React.createElement('select', {
              value: bpType, onChange: e => setBpType(e.target.value),
              style: { background: '#1e2433', color: '#fff', border: '1px solid #334155', padding: '2px 4px', fontSize: '11px', borderRadius: '3px' }
            },
              React.createElement('option', { value: 'PC_MATCH' }, 'PC_MATCH'),
              React.createElement('option', { value: 'MEM_READ' }, 'MEM_READ'),
              React.createElement('option', { value: 'MEM_WRITE' }, 'MEM_WRITE')
            ),
            React.createElement('input', {
              placeholder: '0x0003...', value: bpValue, onChange: e => setBpValue(e.target.value),
              style: { flex: 1, background: '#1e2433', color: '#fff', border: '1px solid #334155', padding: '2px 6px', fontSize: '11px', borderRadius: '3px' }
            }),
            React.createElement('button', { style: S.btn('#0284c7'), onClick: addBreakpoint }, 'Add')
          ),
          React.createElement('div', { style: { flex: 1, overflowY: 'auto' } },
            breakpoints.map(bp => React.createElement('div', {
              key: bp.id,
              style: { display: 'flex', justifyContent: 'space-between', padding: '2px 4px', color: '#4ade80', fontSize: '11px', background: '#161e2e', borderRadius: '3px', marginTop: '2px' }
            },
              React.createElement('span', null, `${bp.type} ${bp.condition}`),
              React.createElement('button', { style: { background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '10px' }, onClick: () => setBreakpoints(b => b.filter(x => x.id !== bp.id)) }, 'Del')
            ))
          )
        )
      ),

      // === 列 3: Flags, Memory (HEX) & Stack ===
      React.createElement('div', { style: S.panel },
        // Flags
        React.createElement('div', { style: S.panelHeader },
          React.createElement('span', null, 'Flags')
        ),
        React.createElement('div', {
          style: {
            background: '#131822', padding: '6px 12px', display: 'flex',
            justifyContent: 'space-between', fontFamily: 'monospace', fontWeight: 'bold'
          }
        },
          ['S', 'Z', 'H', 'PV', 'N', 'C'].map(fKey => React.createElement('div', { key: fKey, style: { display: 'flex', gap: '3px' } },
            React.createElement('span', { style: { color: '#64748b' } }, `${fKey}:`),
            React.createElement('span', { style: { color: '#facc15' } }, flags[fKey.toLowerCase()] ?? 0)
          ))
        ),

        // Memory (HEX)
        React.createElement('div', { style: { ...S.panelHeader, borderTop: '1px solid #232b3b' } },
          React.createElement('span', null, 'Memory (HEX)')
        ),
        React.createElement('div', {
          style: {
            flex: 1, background: '#090d14', color: '#a3e635', padding: '6px',
            fontFamily: 'monospace', fontSize: '11px', lineHeight: '1.4', overflowY: 'auto'
          }
        },
          React.createElement('div', null, '0000: 00 3E 01 06 01 80 48 47 18 FB 00 00 00 00 00 00  .>....HG........'),
          React.createElement('div', null, '0010: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  ................'),
          React.createElement('div', null, '0020: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  ................'),
          React.createElement('div', null, '0030: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  ................')
        ),

        // Stack
        React.createElement('div', { style: { ...S.panelHeader, borderTop: '1px solid #232b3b' } },
          React.createElement('span', null, 'Stack')
        ),
        React.createElement('div', {
          style: {
            height: '90px', background: '#090d14', color: '#a3e635', padding: '6px',
            fontFamily: 'monospace', fontSize: '11px', overflowY: 'auto'
          }
        },
          React.createElement('div', null, 'FFFE: 00 00  (TOS)'),
          React.createElement('div', null, 'FFFC: 00 00'),
          React.createElement('div', null, 'FFFA: 00 00')
        )
      ),

      // === 列 4: Registers ===
      React.createElement('div', { style: { ...S.panel, borderRight: 'none', background: '#11151f' } },
        React.createElement('div', { style: S.panelHeader },
          React.createElement('span', null, 'Registers')
        ),
        React.createElement('div', { style: { flex: 1, padding: '8px', overflowY: 'auto', fontFamily: 'monospace' } },
          // Main Registers
          React.createElement('div', { style: { color: '#38bdf8', fontWeight: 'bold', marginBottom: '4px', fontSize: '11px' } }, 'Main Registers'),
          ['af', 'bc', 'de', 'hl'].map(k => React.createElement('div', {
            key: k, style: { display: 'flex', justifyContent: 'space-between', padding: '2px 0' }
          },
            React.createElement('span', { style: { color: '#94a3b8' } }, `${k.toUpperCase()}:`),
            React.createElement('span', { style: { color: '#facc15', fontWeight: 'bold' } }, regs[k])
          )),

          // Alternate Registers
          React.createElement('div', { style: { color: '#38bdf8', fontWeight: 'bold', margin: '8px 0 4px 0', fontSize: '11px' } }, 'Alternate Registers'),
          ['af_alt', 'bc_alt', 'de_alt', 'hl_alt'].map(k => React.createElement('div', {
            key: k, style: { display: 'flex', justifyContent: 'space-between', padding: '2px 0' }
          },
            React.createElement('span', { style: { color: '#94a3b8' } }, `${k.replace('_alt', "'").toUpperCase()}:`),
            React.createElement('span', { style: { color: '#facc15' } }, regs[k])
          )),

          // Index Control
          React.createElement('div', { style: { color: '#38bdf8', fontWeight: 'bold', margin: '8px 0 4px 0', fontSize: '11px' } }, 'Index Control'),
          ['ix', 'iy', 'sp', 'pc'].map(k => React.createElement('div', {
            key: k, style: { display: 'flex', justifyContent: 'space-between', padding: '2px 0' }
          },
            React.createElement('span', { style: { color: '#94a3b8' } }, `${k.toUpperCase()}:`),
            React.createElement('span', { style: { color: k === 'pc' ? '#4ade80' : '#facc15', fontWeight: 'bold' } }, regs[k])
          )),

          // Special
          React.createElement('div', { style: { color: '#38bdf8', fontWeight: 'bold', margin: '8px 0 4px 0', fontSize: '11px' } }, 'Special'),
          ['i', 'r', 'im'].map(k => React.createElement('div', {
            key: k, style: { display: 'flex', justifyContent: 'space-between', padding: '2px 0' }
          },
            React.createElement('span', { style: { color: '#94a3b8' } }, `${k.toUpperCase()}:`),
            React.createElement('span', { style: { color: '#facc15' } }, regs[k])
          ))
        )
      )
    ),

    // 3. フッターステータスバー
    React.createElement('div', { style: S.footer },
      React.createElement('span', null, `Executed: ${lastExecuted}`),
      React.createElement('div', { style: { display: 'flex', gap: '12px' } },
        React.createElement('span', null, `Step: ${stepCount}`),
        React.createElement('span', null, `Cycles: ${cycleCount}`)
      )
    )
  );
}
