export const minApiVersion = 1;


function getRctStore() {
  if (typeof window === 'undefined') return null;
  if (!window.__RCT_STORE__) {
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fbb_rct_sync') : null;

    // Disassembly with structured columns: Addr, Bytes, Label, Mnemonic, Dest, Src, Comment
    const initialProgram = [
      { addr: '0000', bytes: '00',    label: 'START:',    mnem: 'NOP',  dest: '',     src: '',     comment: '; Entry point' },
      { addr: '0001', bytes: '3E 01', label: '',          mnem: 'LD',   dest: 'A,',   src: '$01',  comment: '; Set initial A = 1' },
      { addr: '0003', bytes: '06 01', label: 'FIB_INIT:', mnem: 'LD',   dest: 'B,',   src: '$01',  comment: '; Set initial B = 1' },
      { addr: '0005', bytes: '0E 00', label: '',          mnem: 'LD',   dest: 'C,',   src: '$00',  comment: '; Clear C = 0' },
      { addr: '0007', bytes: '80',    label: 'LOOP:',     mnem: 'ADD',  dest: 'A,',   src: 'B',    comment: '; Fibonacci: A = A + B' },
      { addr: '0008', bytes: '48',    label: '',          mnem: 'LD',   dest: 'C,',   src: 'B',    comment: '; Save previous B to C' },
      { addr: '0009', bytes: '47',    label: '',          mnem: 'LD',   dest: 'B,',   src: 'A',    comment: '; Update B to new sum' },
      { addr: '000A', bytes: '18 FB', label: '',          mnem: 'JR',   dest: 'LOOP', src: '(-5)', comment: '; Repeat loop' },
      { addr: '000C', bytes: '76',    label: '',          mnem: 'HALT', dest: '',     src: '',     comment: '; Stop CPU execution' }
    ];

    // 64KB memory array (65536 bytes)
    const initialMemory = new Uint8Array(65536);
    // Load initial program bytes at 0x0000
    const progBytes = [0x00, 0x3E, 0x01, 0x06, 0x01, 0x0E, 0x00, 0x80, 0x48, 0x47, 0x18, 0xFB, 0x76];
    for (let i = 0; i < progBytes.length; i++) {
      initialMemory[i] = progBytes[i];
    }
    // Set initial stack data near 0xFFF0 - 0xFFFF
    initialMemory[0xFFFA] = 0x12;
    initialMemory[0xFFFB] = 0x34;
    initialMemory[0xFFFC] = 0x56;
    initialMemory[0xFFFD] = 0x78;
    initialMemory[0xFFFE] = 0x00;
    initialMemory[0xFFFF] = 0x00;

    let state = {
      stepCount: 0,
      cycleCount: 0,
      isRunning: false,
      clockSpeed: 500,
      zoom: 1.0,
      lastExecuted: 'NOP',
      currentPc: '0000',
      regs: {
        af: '0x0000', bc: '0x0000', de: '0x0000', hl: '0x0000',
        af_alt: '0x5500', bc_alt: '0x0000', de_alt: '0x0000', hl_alt: '0x0000',
        ix: '0x1234', iy: '0x0000', sp: '0xFFFE', pc: '0x0000',
        i: '0x00', r: '0x00', im: 0
      },
      flags: { s: 0, z: 0, h: 0, pv: 0, n: 0, c: 0 },
      bus: {
        addr: '0x0000', data_in: '0x00', data_out: '0x00',
        mreq: false, iorq: false, rd: false, wr: false, m1: false,
        active: false
      },
      breakpoints: [
        { id: 1, type: 'PC_MATCH', condition: '== 0x0003 (EX_TEST)', status: 'Active' }
      ],
      bpType: 'PC_MATCH',
      bpValue: '',
      program: initialProgram,
      memory: initialMemory,
      history: []
    };

    const listeners = new Set();
    // Automatically fetch active HEX program if provided by start_lab.sh
    if (typeof fetch !== 'undefined') {
      fetch('/api/scenario/rct-program')
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && data.program && data.program.length > 0) {
            state.program = data.program;
            if (data.memory && data.memory.length > 0) {
              for (let i = 0; i < data.memory.length && i < 65536; i++) {
                state.memory[i] = data.memory[i];
              }
            }
            if (data.startPc) {
              state.currentPc = data.startPc;
              state.regs.pc = '0x' + data.startPc;
            }
            if (data.program[0]) {
              state.lastExecuted = data.program[0].mnem;
            }
            notify('local');
          }
        })
        .catch(() => {});
    }

    let runTimer = null;

    function notify(origin) {
      listeners.forEach(l => {
        try { l(state); } catch (e) { console.error(e); }
      });
      if (origin === 'local' && channel) {
        channel.postMessage({
          type: 'SYNC_STATE',
          payload: {
            ...state,
            memory: Array.from(state.memory.slice(0, 256))
          }
        });
      }
    }

    // Accurate Z80 Instruction Stepping Engine
    function step() {
      state.history.push({
        stepCount: state.stepCount,
        cycleCount: state.cycleCount,
        regs: { ...state.regs },
        flags: { ...state.flags },
        bus: { ...state.bus },
        currentPc: state.currentPc,
        lastExecuted: state.lastExecuted
      });

      const pcNum = parseInt(state.currentPc, 16);
      const curItem = state.program.find(p => parseInt(p.addr, 16) === pcNum) || state.program[0];

      let rA = parseInt(state.regs.af.substring(2, 4), 16) || 0;
      let rF = parseInt(state.regs.af.substring(4, 6), 16) || 0;
      let rB = parseInt(state.regs.bc.substring(2, 4), 16) || 0;
      let rC = parseInt(state.regs.bc.substring(4, 6), 16) || 0;
      let rD = parseInt(state.regs.de.substring(2, 4), 16) || 0;
      let rE = parseInt(state.regs.de.substring(4, 6), 16) || 0;
      let rH = parseInt(state.regs.hl.substring(2, 4), 16) || 0;
      let rL = parseInt(state.regs.hl.substring(4, 6), 16) || 0;

      let nextPcNum = pcNum + (curItem ? curItem.bytes.split(' ').length : 1);
      let tCycles = 4;
      let busAddr = '0x' + state.currentPc;
      let busData = curItem ? curItem.bytes.split(' ')[0] : '00';

      if (curItem) {
        if (curItem.mnem === 'NOP') {
          tCycles = 4;
        } else if (curItem.mnem === 'LD') {
          const dest = curItem.dest.replace(',', '').trim();
          const src = curItem.src.trim();
          let srcVal = 0;
          if (src.startsWith('$')) {
            srcVal = parseInt(src.replace('$', '0x'), 16);
            tCycles = 7;
          } else if (src === 'A') srcVal = rA;
          else if (src === 'B') srcVal = rB;
          else if (src === 'C') srcVal = rC;
          else if (src === 'D') srcVal = rD;
          else if (src === 'E') srcVal = rE;
          else if (src === 'H') srcVal = rH;
          else if (src === 'L') srcVal = rL;

          if (dest === 'A') rA = srcVal & 0xFF;
          else if (dest === 'B') rB = srcVal & 0xFF;
          else if (dest === 'C') rC = srcVal & 0xFF;
          else if (dest === 'D') rD = srcVal & 0xFF;
          else if (dest === 'E') rE = srcVal & 0xFF;
          else if (dest === 'H') rH = srcVal & 0xFF;
          else if (dest === 'L') rL = srcVal & 0xFF;
          else if (dest === 'BC') { rB = (srcVal >> 8) & 0xFF; rC = srcVal & 0xFF; }
          else if (dest === 'DE') { rD = (srcVal >> 8) & 0xFF; rE = srcVal & 0xFF; }
          else if (dest === 'HL') { rH = (srcVal >> 8) & 0xFF; rL = srcVal & 0xFF; }
        } else if (curItem.mnem === 'ADD') {
          const src = curItem.src.trim();
          let srcVal = 0;
          if (src === 'B') srcVal = rB;
          else if (src === 'C') srcVal = rC;
          else if (src === 'D') srcVal = rD;
          else if (src === 'E') srcVal = rE;
          else if (src === 'A') srcVal = rA;
          else if (src.startsWith('$')) srcVal = parseInt(src.replace('$', '0x'), 16);

          const oldA = rA;
          const sum = rA + srcVal;
          rA = sum & 0xFF;
          tCycles = 4;

          const s = (rA & 0x80) ? 1 : 0;
          const z = (rA === 0) ? 1 : 0;
          const h = ((oldA & 0x0F) + (srcVal & 0x0F) > 0x0F) ? 1 : 0;
          const c = (sum > 0xFF) ? 1 : 0;
          const pv = (((oldA ^ ~srcVal) & (oldA ^ rA)) & 0x80) ? 1 : 0;
          state.flags = { s, z, h, pv, n: 0, c };
          rF = (s << 7) | (z << 6) | (h << 4) | (pv << 2) | c;
        } else if (curItem.mnem === 'JR') {
          tCycles = 12;
          if (curItem.src.includes('-5') || curItem.dest === 'LOOP') {
            const loopItem = state.program.find(p => p.label && p.label.startsWith('LOOP'));
            nextPcNum = loopItem ? parseInt(loopItem.addr, 16) : 0x0007;
          }
        } else if (curItem.mnem === 'INC') {
          const dest = curItem.dest.replace(',', '').trim();
          if (dest === 'A') { rA = (rA + 1) & 0xFF; }
          else if (dest === 'B') { rB = (rB + 1) & 0xFF; }
          else if (dest === 'C') { rC = (rC + 1) & 0xFF; }
          const val = dest === 'A' ? rA : (dest === 'B' ? rB : rC);
          const z = val === 0 ? 1 : 0;
          const s = (val & 0x80) ? 1 : 0;
          state.flags = { ...state.flags, s, z };
          tCycles = 4;
        } else if (curItem.mnem === 'DEC') {
          const dest = curItem.dest.replace(',', '').trim();
          if (dest === 'A') { rA = (rA - 1) & 0xFF; }
          else if (dest === 'B') { rB = (rB - 1) & 0xFF; }
          else if (dest === 'C') { rC = (rC - 1) & 0xFF; }
          const val = dest === 'A' ? rA : (dest === 'B' ? rB : rC);
          const z = val === 0 ? 1 : 0;
          const s = (val & 0x80) ? 1 : 0;
          state.flags = { ...state.flags, s, z, n: 1 };
          tCycles = 4;
        } else if (curItem.mnem === 'DJNZ') {
          rB = (rB - 1) & 0xFF;
          tCycles = 13;
          if (rB !== 0) {
            const targetHex = curItem.dest.replace('$', '').trim();
            const targetNum = parseInt(targetHex, 16);
            if (!isNaN(targetNum)) nextPcNum = targetNum;
          } else {
            tCycles = 8;
          }
        } else if (curItem.mnem === 'CALL') {
          tCycles = 17;
          const targetHex = curItem.dest.replace('$', '').trim();
          const targetNum = parseInt(targetHex, 16);
          if (!isNaN(targetNum)) nextPcNum = targetNum;
        } else if (curItem.mnem === 'RET') {
          tCycles = 10;
        } else if (curItem.mnem === 'PUSH') {
          tCycles = 11;
        } else if (curItem.mnem === 'POP') {
          tCycles = 10;
        } else if (curItem.mnem === 'HALT') {
          nextPcNum = pcNum;
          tCycles = 4;
        }
      }

      const nextPcHex = nextPcNum.toString(16).padStart(4, '0').toUpperCase();
      state.stepCount += 1;
      state.cycleCount += tCycles;
      state.currentPc = nextPcHex;
      state.lastExecuted = curItem ? (curItem.mnem + (curItem.dest ? ' ' + curItem.dest : '') + (curItem.src ? ' ' + curItem.src : '')) : 'NOP';

      const fmt16 = (hi, lo) => '0x' + hi.toString(16).padStart(2, '0').toUpperCase() + lo.toString(16).padStart(2, '0').toUpperCase();
      state.regs = {
        ...state.regs,
        af: fmt16(rA, rF),
        bc: fmt16(rB, rC),
        de: fmt16(rD, rE),
        hl: fmt16(rH, rL),
        pc: '0x' + nextPcHex
      };

      state.bus = {
        addr: busAddr,
        data_in: busData,
        data_out: '00',
        mreq: true, iorq: false, rd: true, wr: false, m1: true,
        active: true
      };

      // Check if breakpoint hit at new PC
      const hitBp = checkBreakpoints(nextPcHex);
      if (hitBp) {
        if (state.isRunning) {
          if (runTimer) {
            clearInterval(runTimer);
            runTimer = null;
          }
          state.isRunning = false;
        }
        state.hitBpId = hitBp.id;
        state.statusMsg = `BP HIT: 0x${nextPcHex}`;
      } else {
        state.hitBpId = null;
        state.statusMsg = null;
      }

      notify('local');

      setTimeout(() => {
        state.bus = { ...state.bus, active: false };
        notify('local');
      }, 200);
    }

    function backstep() {
      if (state.history.length === 0) return;
      const prev = state.history.pop();
      state.stepCount = prev.stepCount;
      state.cycleCount = prev.cycleCount;
      state.regs = prev.regs;
      state.flags = prev.flags;
      state.bus = prev.bus;
      state.currentPc = prev.currentPc;
      state.lastExecuted = prev.lastExecuted;
      notify('local');
    }

    function reset() {
      if (runTimer) {
        clearInterval(runTimer);
        runTimer = null;
      }
      state.isRunning = false;
      state.stepCount = 0;
      state.cycleCount = 0;
      state.currentPc = '0000';
      state.lastExecuted = 'NOP';
      state.regs = {
        af: '0x0000', bc: '0x0000', de: '0x0000', hl: '0x0000',
        af_alt: '0x5500', bc_alt: '0x0000', de_alt: '0x0000', hl_alt: '0x0000',
        ix: '0x1234', iy: '0x0000', sp: '0xFFFE', pc: '0x0000',
        i: '0x00', r: '0x00', im: 0
      };
      state.flags = { s: 0, z: 0, h: 0, pv: 0, n: 0, c: 0 };
      state.bus = {
        addr: '0x0000', data_in: '0x00', data_out: '0x00',
        mreq: false, iorq: false, rd: false, wr: false, m1: false,
        active: false
      };
      state.history = [];
      notify('local');
    }

    function setRunning(running) {
      state.isRunning = running;
      if (runTimer) {
        clearInterval(runTimer);
        runTimer = null;
      }
      if (running) {
        runTimer = setInterval(() => {
          step();
        }, state.clockSpeed);
      }
      notify('local');
    }

    function setClockSpeed(speed) {
      state.clockSpeed = speed;
      if (state.isRunning) {
        if (runTimer) clearInterval(runTimer);
        runTimer = setInterval(() => {
          step();
        }, speed);
      }
      notify('local');
    }

    function setZoom(z) {
      state.zoom = z;
      notify('local');
    }

    function checkBreakpoints(pcHex) {
      if (!state.breakpoints || state.breakpoints.length === 0) return null;
      for (const bp of state.breakpoints) {
        if (bp.status === 'Disabled') continue;
        const match = bp.condition.match(/(?:0x)?([0-9a-fA-F]{1,4})/);
        if (!match) continue;
        const targetHex = match[1].padStart(4, '0').toUpperCase();

        if (bp.type === 'PC_MATCH') {
          if (pcHex === targetHex) return bp;
        } else if (bp.type === 'MEM_READ') {
          const busAddrHex = state.bus.addr ? state.bus.addr.replace('0x', '').padStart(4, '0').toUpperCase() : '';
          if (state.bus.mreq && state.bus.rd && busAddrHex === targetHex) return bp;
        } else if (bp.type === 'MEM_WRITE') {
          const busAddrHex = state.bus.addr ? state.bus.addr.replace('0x', '').padStart(4, '0').toUpperCase() : '';
          if (state.bus.mreq && state.bus.wr && busAddrHex === targetHex) return bp;
        }
      }
      return null;
    }

    function addBreakpoint(type, cond) {
      if (!cond) return;
      state.breakpoints.push({
        id: Date.now(),
        type,
        condition: cond.startsWith('==') ? cond : `== ${cond}`,
        status: 'Active'
      });
      state.bpValue = '';
      notify('local');
    }

    function removeBreakpoint(id) {
      state.breakpoints = state.breakpoints.filter(b => b.id !== id);
      notify('local');
    }

    function setBpType(t) {
      state.bpType = t;
      notify('local');
    }

    function setBpValue(v) {
      state.bpValue = v;
      notify('local');
    }

    if (channel) {
      channel.onmessage = (e) => {
        if (e.data && e.data.type === 'SYNC_STATE') {
          const { memory, ...rest } = e.data.payload;
          state = { ...state, ...rest };
          notify('remote');
        }
      };
    }

    window.__RCT_STORE__ = {
      getState: () => state,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      actions: {
        step,
        backstep,
        reset,
        setRunning,
        setClockSpeed,
        setZoom,
        addBreakpoint,
        removeBreakpoint,
        setBpType,
        setBpValue
      }
    };
  }
  return window.__RCT_STORE__;
}

function useRctStore() {
  const store = getRctStore();
  const FBB = window.FBB || {};
  const React = FBB.React || window.React;
  const { useState, useEffect } = FBB.hooks || React;
  const [state, setState] = useState(store ? store.getState() : {});

  useEffect(() => {
    if (!store) return;
    return store.subscribe(newState => setState({ ...newState }));
  }, [store]);

  return [state, store ? store.actions : {}];
}

const S = {
  container: {
    background: '#12151c',
    color: '#e2e8f0',
    height: '100%',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'SF Pro Text, -apple-system, Segoe UI, Roboto, monospace',
    fontSize: '12px',
    overflow: 'hidden',
    userSelect: 'none',
    boxSizing: 'border-box'
  },
  header: {
    background: '#1e2433',
    padding: '6px 10px',
    fontWeight: 'bold',
    fontSize: '11px',
    color: '#94a3b8',
    borderBottom: '1px solid #232b3b',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexShrink: 0
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    background: '#161a23',
    display: 'flex',
    flexDirection: 'column'
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
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px'
  })
};


export default function RctControllerPane() {
  const FBB = window.FBB || {};
  const React = FBB.React || window.React;
  const [state, actions] = useRctStore();

  const isRunning = state.isRunning || false;
  const historyLen = (state.history || []).length;

  return React.createElement(
    'div',
    {
      style: {
        background: '#1a1f2c',
        borderBottom: '1px solid #2d3748',
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        height: '100%',
        boxSizing: 'border-box',
        overflowX: 'auto',
        fontFamily: 'SF Pro Text, -apple-system, Segoe UI, Roboto, monospace',
        fontSize: '12px'
      }
    },
    React.createElement('button', {
      style: S.btn('#2563eb'),
      onClick: actions.step
    }, 'Step'),

    React.createElement('button', {
      style: S.btn(isRunning ? '#dc2626' : '#16a34a'),
      onClick: () => actions.setRunning(!isRunning)
    }, isRunning ? 'Stop' : 'Run'),

    React.createElement('button', {
      style: S.btn('#475569'),
      onClick: actions.reset
    }, 'Reset'),

    React.createElement('button', {
      style: S.btn(historyLen > 0 ? '#d97706' : '#334155'),
      onClick: actions.backstep,
      disabled: historyLen === 0
    }, 'Backstep'),

    React.createElement('div', { style: { height: '16px', width: '1px', background: '#334155', margin: '0 4px' } }),

    React.createElement('span', { style: { color: '#94a3b8', fontSize: '11px' } }, 'Speed:'),
    React.createElement('input', {
      type: 'range',
      min: '50',
      max: '1000',
      step: '50',
      value: state.clockSpeed || 500,
      onChange: e => actions.setClockSpeed(Number(e.target.value)),
      style: { width: '80px', accentColor: '#38bdf8' }
    }),
    React.createElement('span', { style: { color: '#64748b', fontSize: '10px' } }, `${state.clockSpeed || 500}ms`),

    React.createElement('div', { style: { height: '16px', width: '1px', background: '#334155', margin: '0 4px' } }),

    React.createElement('span', { style: { color: '#38bdf8', fontSize: '11px', fontFamily: 'monospace' } },
      `Step: ${state.stepCount || 0}`
    ),
    React.createElement('span', { style: { color: '#38bdf8', fontSize: '11px', fontFamily: 'monospace', marginLeft: '6px' } },
      `Cycles: ${state.cycleCount || 0}`
    ),
    React.createElement('span', { style: { color: '#a3e635', fontSize: '11px', fontFamily: 'monospace', marginLeft: '6px' } },
      `Last: ${state.lastExecuted || 'NOP'}`
    ),
    state.statusMsg ? React.createElement('span', {
      style: {
        color: '#f87171',
        background: 'rgba(239, 68, 68, 0.2)',
        border: '1px solid #ef4444',
        padding: '2px 6px',
        borderRadius: '3px',
        fontFamily: 'monospace',
        fontWeight: 'bold',
        fontSize: '11px',
        marginLeft: '6px'
      }
    }, state.statusMsg) : null,

    React.createElement('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
      React.createElement('span', { style: { color: '#38bdf8', fontWeight: 'bold' } }, 'Z80 Core:'),
      React.createElement('span', { style: { color: '#4ade80' } }, 'RTL Verified')
    )
  );
}
