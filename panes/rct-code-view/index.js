export const minApiVersion = 1;


function getRctStore() {
  if (typeof window === 'undefined') return null;
  if (!window.__RCT_STORE__ || (window.__RCT_STORE__.version || 0) < 11) {
    if (typeof window !== 'undefined' && window.__RCT_STORE__ && window.__RCT_STORE__._channel) {
      try { window.__RCT_STORE__._channel.close(); } catch (e) {}
    }
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fbb_rct_sync') : null;

    // Disassembly with structured columns: Addr, Bytes, Label, Mnemonic, Dest, Src, Comment
    const initialProgram = [
      { addr: '0000', bytes: '00', label: 'START:', mnem: 'NOP', dest: '', src: '', comment: '; Entry point' },
      { addr: '0001', bytes: '3E 01', label: '', mnem: 'LD', dest: 'A,', src: '$01', comment: '; Set initial A = 1' },
      { addr: '0003', bytes: '06 01', label: 'FIB_INIT:', mnem: 'LD', dest: 'B,', src: '$01', comment: '; Set initial B = 1' },
      { addr: '0005', bytes: '0E 00', label: '', mnem: 'LD', dest: 'C,', src: '$00', comment: '; Clear C = 0' },
      { addr: '0007', bytes: '80', label: 'LOOP:', mnem: 'ADD', dest: 'A,', src: 'B', comment: '; Fibonacci: A = A + B' },
      { addr: '0008', bytes: '48', label: '', mnem: 'LD', dest: 'C,', src: 'B', comment: '; Save previous B to C' },
      { addr: '0009', bytes: '47', label: '', mnem: 'LD', dest: 'B,', src: 'A', comment: '; Update B to new sum' },
      { addr: '000A', bytes: '18 FB', label: '', mnem: 'JR', dest: 'LOOP', src: '(-5)', comment: '; Repeat loop' },
      { addr: '000C', bytes: '76', label: '', mnem: 'HALT', dest: '', src: '', comment: '; Stop CPU execution' }
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

    let loadedProgramData = null;

    let state = {
      stepCount: 0,
      cycleCount: 0,
      isRunning: false,
      isTimeTraveling: false,
      clockSpeed: 500,
      zoom: 1.0,
      lastExecuted: 'NOP',
      lastOpType: 'NOP',
      lastUpdatedReg: null,
      lastOpDesc: null,
      currentPc: '0000',
      regs: {
        af: '0x0000', bc: '0x0000', de: '0x0000', hl: '0x0000',
        af_alt: '0x5500', bc_alt: '0x0000', de_alt: '0x0000', hl_alt: '0x0000',
        ix: '0x1234', iy: '0x0000', sp: '0x0000', pc: '0x0000',
        i: '0x00', r: '0x00', im: 0
      },
      flags: { s: 0, z: 0, h: 0, pv: 0, n: 0, c: 0 },
      bus: {
        addr: '0x0000', data_in: '0x00', data_out: '0x00',
        mreq: false, iorq: false, rd: false, wr: false, m1: false,
        active: false
      },
      breakpoints: [],
      bpType: 'PC_MATCH',
      bpValue: '',
      program: initialProgram,
      memory: initialMemory,
      history: []
    };

    const listeners = (window.__RCT_STORE__ && window.__RCT_STORE__._listeners) || new Set();

    // Automatically fetch active HEX program if provided by start_lab.sh
    if (typeof fetch !== 'undefined') {
      fetch('/api/file?path=/tmp/rct_active_program.json')
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && data.program && data.program.length > 0) {
            loadedProgramData = data;
            state.program = data.program;
            if (data.memoryMap) {
              for (const [addrStr, val] of Object.entries(data.memoryMap)) {
                const a = parseInt(addrStr, 10);
                if (!isNaN(a) && a >= 0 && a < 65536) state.memory[a] = val;
              }
            } else if (data.memory && data.memory.length > 0) {
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
        .catch(() => { });
    }

    let runTimer = null;
    let turboRaf = null;
    let lastTurboUiTime = 0;
    let lastTurboFlushTime = 0;
    let turboStartHistoryLen = 0;
    let skipNextSingleSync = false;

    function stopRunning() {
      state.isRunning = false;
      if (runTimer) {
        clearInterval(runTimer);
        runTimer = null;
      }
      if (turboRaf) {
        if (typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(turboRaf);
        } else {
          clearTimeout(turboRaf);
        }
        turboRaf = null;
      }
    }

    // F-BB Core Dashboard Time-Travel Sync Channel
    const fbbSyncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fbb_dashboard_sync') : null;
    if (fbbSyncChannel) {
      fbbSyncChannel.onmessage = (event) => {
        const { type, payload } = event.data || {};
        if (type === 'SYNC_TIME_TRAVEL') {
          if (payload && !payload.isLive) {
            state.isTimeTraveling = true;
            state.isRunning = false;
            if (runTimer) { clearInterval(runTimer); runTimer = null; }
            if (payload.snapshot) {
              const snap = payload.snapshot;
              const fmtHex16 = (v) => '0x' + (Number(v) & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
              if (snap.vfpga_z80_PC !== undefined) {
                const pcHex = (Number(snap.vfpga_z80_PC) & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
                state.currentPc = pcHex;
                state.regs.pc = '0x' + pcHex;
              }
              if (snap.vfpga_z80_SP !== undefined) state.regs.sp = fmtHex16(snap.vfpga_z80_SP);
              if (snap.vfpga_z80_AF !== undefined) state.regs.af = fmtHex16(snap.vfpga_z80_AF);
              if (snap.vfpga_z80_BC !== undefined) state.regs.bc = fmtHex16(snap.vfpga_z80_BC);
              if (snap.vfpga_z80_DE !== undefined) state.regs.de = fmtHex16(snap.vfpga_z80_DE);
              if (snap.vfpga_z80_HL !== undefined) state.regs.hl = fmtHex16(snap.vfpga_z80_HL);
              if (snap.vfpga_z80_IX !== undefined) state.regs.ix = fmtHex16(snap.vfpga_z80_IX);
              if (snap.vfpga_z80_IY !== undefined) state.regs.iy = fmtHex16(snap.vfpga_z80_IY);
              if (snap.vfpga_z80_FLAGS !== undefined) {
                const f = Number(snap.vfpga_z80_FLAGS) & 0xFF;
                state.flags = {
                  s: (f >> 7) & 1,
                  z: (f >> 6) & 1,
                  h: (f >> 4) & 1,
                  pv: (f >> 2) & 1,
                  n: (f >> 1) & 1,
                  c: f & 1
                };
              }
            }
          } else {
            state.isTimeTraveling = false;
          }
          notify('fbb_sync');
        }
      };
    }

    function syncMmioToFbb() {
      if (state.isTimeTraveling) return; // TIME-TRAVEL中の変化は共有メモリ/履歴へ逆流させない
      if (typeof window === 'undefined' || !window.FBB || !window.FBB.socket) return;
      const flagsVal = (state.flags.s << 7) | (state.flags.z << 6) | (state.flags.h << 4) | (state.flags.pv << 2) | (state.flags.n << 1) | state.flags.c;
      const parse16 = (v) => parseInt((v || '0').replace('0x', ''), 16) || 0;
      window.FBB.socket.emit('mmio:write', {
        deviceName: 'vfpga_z80',
        registers: {
          CTRL: 1,
          STATUS: state.isRunning ? 1 : 0,
          CMD: 0,
          CYCLES: state.cycleCount,
          PC: parseInt(state.currentPc, 16) || 0,
          SP: getSp(),
          AF: parse16(state.regs.af),
          BC: parse16(state.regs.bc),
          DE: parse16(state.regs.de),
          HL: parse16(state.regs.hl),
          IX: parse16(state.regs.ix),
          IY: parse16(state.regs.iy),
          FLAGS: flagsVal,
          AF_ALT: parse16(state.regs.af_alt),
          BC_ALT: parse16(state.regs.bc_alt),
          DE_ALT: parse16(state.regs.de_alt),
          HL_ALT: parse16(state.regs.hl_alt)
        }
      });
    }

    function syncMmioBatchToFbb(steps) {
      if (state.isTimeTraveling) return;
      if (typeof window === 'undefined' || !window.FBB || !window.FBB.socket) return;
      if (!Array.isArray(steps) || steps.length === 0) return;

      const parse16 = (v) => parseInt((v || '0').replace('0x', ''), 16) || 0;
      const parseSp = (v) => parseInt((v || '0').replace('0x', ''), 16) || 0;

      const batch = steps.map((h, idx) => {
        const flagsVal = (h.flags.s << 7) | (h.flags.z << 6) | (h.flags.h << 4) | (h.flags.pv << 2) | (h.flags.n << 1) | h.flags.c;
        const isLast = (idx === steps.length - 1);
        return {
          CTRL: 1,
          STATUS: isLast ? (state.isRunning ? 1 : 0) : 1,
          CMD: 0,
          CYCLES: h.cycleCount,
          PC: parseInt(h.currentPc, 16) || 0,
          SP: parseSp(h.regs.sp),
          AF: parse16(h.regs.af),
          BC: parse16(h.regs.bc),
          DE: parse16(h.regs.de),
          HL: parse16(h.regs.hl),
          IX: parse16(h.regs.ix),
          IY: parse16(h.regs.iy),
          FLAGS: flagsVal,
          AF_ALT: parse16(h.regs.af_alt),
          BC_ALT: parse16(h.regs.bc_alt),
          DE_ALT: parse16(h.regs.de_alt),
          HL_ALT: parse16(h.regs.hl_alt)
        };
      });

      window.FBB.socket.emit('mmio:write_batch', {
        deviceName: 'vfpga_z80',
        batch
      });
    }

    function notify(origin) {
      listeners.forEach(l => {
        try { l(state, origin); } catch (e) { console.error(e); }
      });
      if (origin === 'local' && !state.isTimeTraveling) {
        if (!skipNextSingleSync) {
          syncMmioToFbb();
        }
        skipNextSingleSync = false;
        if (channel) {
          const lastHist = state.history[state.history.length - 1];
          channel.postMessage({
            type: 'SYNC_STATE',
            payload: {
              ...state,
              memChanges: lastHist ? lastHist.memChanges : []
            }
          });
        }
      } else if (origin === 'turbo_tick' && channel) {
        channel.postMessage({
          type: 'TURBO_TICK',
          payload: {
            regs: state.regs,
            flags: state.flags,
            currentPc: state.currentPc,
            stepCount: state.stepCount,
            cycleCount: state.cycleCount,
            isRunning: state.isRunning
          }
        });
      }
    }

    function getSp() {
      const v = parseInt(state.regs.sp.replace('0x', ''), 16);
      return isNaN(v) ? 0 : v;
    }

    // Accurate Z80 Instruction Stepping Engine
    function step(silent = false) {
      const isSilent = typeof silent === 'boolean' ? silent : false;
      if (state.isTimeTraveling) return false;

      // History cap to prevent OOM in long runs (keeps last 50,000 steps)
      if (state.history.length >= 50000) {
        state.history.shift();
      }

      const memChanges = [];
      state.history.push({
        stepCount: state.stepCount,
        cycleCount: state.cycleCount,
        regs: { ...state.regs },
        flags: { ...state.flags },
        bus: { ...state.bus },
        currentPc: state.currentPc,
        lastExecuted: state.lastExecuted,
        memChanges
      });

      const pcNum = parseInt(state.currentPc, 16);
      const curItem = state.program.find(p => p.bytes && parseInt(p.addr, 16) === pcNum) || state.program.find(p => parseInt(p.addr, 16) === pcNum) || state.program[0];

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

      state.lastUpdatedReg = null;
      state.lastOpType = curItem ? curItem.mnem : 'NOP';
      state.lastOpDesc = null;

      const parseVal = (str) => {
        if (!str) return NaN;
        const s = str.trim();
        if (s.startsWith('$')) return parseInt(s.replace('$', '0x'), 16);
        if (/^0x[0-9a-fA-F]+$/i.test(s)) return parseInt(s, 16);
        if (/^[0-9a-fA-F]+[hH]$/i.test(s)) return parseInt(s.slice(0, -1), 16);
        if (/^\d+$/.test(s)) return parseInt(s, 10);
        return NaN;
      };

      const getImmediateVal = (str, item) => {
        let v = parseVal(str);
        if (isNaN(v) && item && item.bytes) {
          const b = item.bytes.trim().split(/\s+/).map(x => parseInt(x, 16)).filter(x => !isNaN(x));
          if (b.length === 2) v = b[1];
          else if (b.length === 3) v = b[1] | (b[2] << 8);
          else if (b.length === 4) v = b[2] | (b[3] << 8);
        }
        return v;
      };

const resolveIndexedAddr = (str, item) => {
        if (!str) return null;
        const clean = str.replace(',', '').trim();
        const m = clean.match(/^\(\s*(IX|IY)\s*([+-])\s*([^)]+)\)$/i);
        if (!m) return null;
        const reg = m[1].toUpperCase();
        let base = (reg === 'IX')
          ? (parseInt(state.regs.ix.replace('0x', ''), 16) || 0)
          : (parseInt(state.regs.iy.replace('0x', ''), 16) || 0);

        let disp = null;
        if (item && item.bytes) {
          const b = item.bytes.trim().split(/\s+/).map(x => parseInt(x, 16)).filter(x => !isNaN(x));
          if (b.length >= 3 && (b[0] === 0xDD || b[0] === 0xFD)) {
            const raw = b[2];
            disp = (raw >= 128) ? raw - 256 : raw;
          }
        }
        if (disp === null) {
          disp = 0;
          if (m[2] && m[3]) {
            const sign = m[2] === '-' ? -1 : 1;
            const exprVal = getImmediateVal(m[3], item);
            if (!isNaN(exprVal)) disp = sign * exprVal;
          }
        }
        return (base + disp) & 0xFFFF;
      };

      const resolveJumpTarget = (item, candidate) => {
        const candidates = [candidate, item && item.dest, item && item.src].filter(Boolean);
        for (let cand of candidates) {
          const rawTrimmed = cand.replace(/[(),]/g, '').trim();

          // 1. Try finding by label in program
          const match = state.program.find(p => {
            if (!p.label || !p.addr) return false;
            const l = p.label.replace(':', '').trim();
            return l.toLowerCase() === rawTrimmed.toLowerCase();
          });
          if (match) {
            const a = parseInt(match.addr, 16);
            if (!isNaN(a)) return a;
          }

          // 2. Explicit hex formats (bash055, 0x0055, 0055h)
          if (rawTrimmed.startsWith('$')) {
            const a = parseInt(rawTrimmed.slice(1), 16);
            if (!isNaN(a)) return a;
          }
          if (/^0x[0-9a-fA-F]+$/i.test(rawTrimmed)) {
            const a = parseInt(rawTrimmed, 16);
            if (!isNaN(a)) return a;
          }
          if (/^[0-9a-fA-F]+[hH]$/i.test(rawTrimmed)) {
            const a = parseInt(rawTrimmed.slice(0, -1), 16);
            if (!isNaN(a)) return a;
          }

          // 3. Try instruction opcode bytes if available (CALL nn / JP nn has 3 bytes: OP, lo, hi)
          if (item && item.bytes && (item.mnem === 'CALL' || item.mnem === 'JP')) {
            const b = item.bytes.trim().split(/\s+/).map(x => parseInt(x, 16)).filter(x => !isNaN(x));
            if (b.length >= 3) {
              return (b[2] << 8) | b[1];
            }
          }

          // 4. Try 3 or 4-digit hex address (e.g. 0055, 0100)
          if (/^[0-9a-fA-F]{3,4}$/i.test(rawTrimmed)) {
            const a = parseInt(rawTrimmed, 16);
            if (!isNaN(a)) return a;
          }

          // 5. Try relative offset e.g. (-5), +5, -5 (for JR and DJNZ)
          const offMatch = cand.match(/^[\(\[]?\s*([+-]?\d+)\s*[\)\]]?$/);
          if (offMatch) {
            const offset = parseInt(offMatch[1], 10);
            const instrLen = item && item.bytes ? item.bytes.trim().split(/\s+/).length : 2;
            const basePc = item && item.addr ? parseInt(item.addr, 16) : pcNum;
            return (basePc + instrLen + offset) & 0xFFFF;
          }

          // 6. Generic parseVal fallback
          const immA = parseVal(rawTrimmed);
          if (!isNaN(immA)) return immA;
        }
        return NaN;
      };

      if (curItem) {
        if (curItem.mnem === 'NOP') {
          tCycles = 4;
        } else if (curItem.mnem === 'LD') {
          const dest = curItem.dest.replace(',', '').trim();
          const src = curItem.src.trim();
          let srcVal = 0;
          const srcIdxAddr = resolveIndexedAddr(src, curItem);
          const destIdxAddr = resolveIndexedAddr(dest, curItem);

          if (srcIdxAddr !== null) {
            srcVal = state.memory[srcIdxAddr] || 0;
            tCycles = 19;
          } else if (src === '(HL)') {
            srcVal = state.memory[(rH << 8) | rL] || 0;
            tCycles = 7;
          } else if (src === '(DE)') {
            srcVal = state.memory[(rD << 8) | rE] || 0;
            tCycles = 7;
          } else if (src === '(BC)') {
            srcVal = state.memory[(rB << 8) | rC] || 0;
            tCycles = 7;
          } else if (src === 'A') srcVal = rA;
          else if (src === 'B') srcVal = rB;
          else if (src === 'C') srcVal = rC;
          else if (src === 'D') srcVal = rD;
          else if (src === 'E') srcVal = rE;
          else if (src === 'H') srcVal = rH;
          else if (src === 'L') srcVal = rL;
          else if (src === 'BC') srcVal = (rB << 8) | rC;
          else if (src === 'DE') srcVal = (rD << 8) | rE;
          else if (src === 'HL') srcVal = (rH << 8) | rL;
          else if (src === 'SP') srcVal = parseInt(state.regs.sp.replace('0x', ''), 16) || 0;
          else if (src === 'IX') srcVal = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
          else if (src === 'IY') srcVal = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;
          else if (src === 'IXH') { const ix = parseInt(state.regs.ix.replace('0x', ''), 16) || 0; srcVal = (ix >> 8) & 0xFF; }
          else if (src === 'IXL') { const ix = parseInt(state.regs.ix.replace('0x', ''), 16) || 0; srcVal = ix & 0xFF; }
          else if (src === 'IYH') { const iy = parseInt(state.regs.iy.replace('0x', ''), 16) || 0; srcVal = (iy >> 8) & 0xFF; }
          else if (src === 'IYL') { const iy = parseInt(state.regs.iy.replace('0x', ''), 16) || 0; srcVal = iy & 0xFF; }
          else {
            const imm = getImmediateVal(src, curItem);
            if (!isNaN(imm)) {
              srcVal = imm;
              tCycles = dest.length === 2 ? 10 : 7;
            }
          }

          if (destIdxAddr !== null) {
            memChanges.push({ addr: destIdxAddr, oldVal: state.memory[destIdxAddr] || 0, newVal: srcVal & 0xFF });
            state.memory[destIdxAddr] = srcVal & 0xFF;
            tCycles = 19;
          } else if (dest === '(HL)') {
            const a = (rH << 8) | rL;
            memChanges.push({ addr: a, oldVal: state.memory[a] || 0, newVal: srcVal & 0xFF });
            state.memory[a] = srcVal & 0xFF;
            tCycles = 7;
          } else if (dest === '(DE)') {
            const a = (rD << 8) | rE;
            memChanges.push({ addr: a, oldVal: state.memory[a] || 0, newVal: srcVal & 0xFF });
            state.memory[a] = srcVal & 0xFF;
            tCycles = 7;
          } else if (dest === '(BC)') {
            const a = (rB << 8) | rC;
            memChanges.push({ addr: a, oldVal: state.memory[a] || 0, newVal: srcVal & 0xFF });
            state.memory[a] = srcVal & 0xFF;
            tCycles = 7;
          } else if (dest === 'A') rA = srcVal & 0xFF;
          else if (dest === 'B') rB = srcVal & 0xFF;
          else if (dest === 'C') rC = srcVal & 0xFF;
          else if (dest === 'D') rD = srcVal & 0xFF;
          else if (dest === 'E') rE = srcVal & 0xFF;
          else if (dest === 'H') rH = srcVal & 0xFF;
          else if (dest === 'L') rL = srcVal & 0xFF;
          else if (dest === 'BC') { rB = (srcVal >> 8) & 0xFF; rC = srcVal & 0xFF; }
          else if (dest === 'DE') { rD = (srcVal >> 8) & 0xFF; rE = srcVal & 0xFF; }
          else if (dest === 'HL') { rH = (srcVal >> 8) & 0xFF; rL = srcVal & 0xFF; }
          else if (dest === 'IX') {
            state.regs.ix = '0x' + (srcVal & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IY') {
            state.regs.iy = '0x' + (srcVal & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IXH') {
            let ix = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
            ix = ((srcVal & 0xFF) << 8) | (ix & 0xFF);
            state.regs.ix = '0x' + ix.toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IXL') {
            let ix = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
            ix = (ix & 0xFF00) | (srcVal & 0xFF);
            state.regs.ix = '0x' + ix.toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IYH') {
            let iy = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;
            iy = ((srcVal & 0xFF) << 8) | (iy & 0xFF);
            state.regs.iy = '0x' + iy.toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IYL') {
            let iy = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;
            iy = (iy & 0xFF00) | (srcVal & 0xFF);
            state.regs.iy = '0x' + iy.toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'SP') {
            state.regs.sp = '0x' + (srcVal & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
          }
        } else if (curItem.mnem === 'ADD') {
          const dest = (curItem.dest || '').replace(',', '').trim();
          const src = curItem.src.trim();
          if (dest === 'HL') {
            const hl = (rH << 8) | rL;
            let val = 0;
            if (src === 'BC') val = (rB << 8) | rC;
            else if (src === 'DE') val = (rD << 8) | rE;
            else if (src === 'HL') val = hl;
            else if (src === 'SP') val = getSp();
            const sum = hl + val;
            rH = ((sum & 0xFFFF) >> 8) & 0xFF;
            rL = sum & 0xFF;
            const cOut = (sum > 0xFFFF) ? 1 : 0;
            state.flags = { ...state.flags, n: 0, c: cOut };
            rF = (rF & ~0x03) | cOut;
            tCycles = 11;
          } else {
            let srcVal = 0;
            const idxAddr = resolveIndexedAddr(src, curItem);
            if (idxAddr !== null) {
              srcVal = state.memory[idxAddr] || 0;
              tCycles = 19;
            } else {
              const imm = getImmediateVal(src, curItem);
              if (!isNaN(imm)) srcVal = imm;
              else if (src === 'B') srcVal = rB;
              else if (src === 'C') srcVal = rC;
              else if (src === 'D') srcVal = rD;
              else if (src === 'E') srcVal = rE;
              else if (src === 'H') srcVal = rH;
              else if (src === 'L') srcVal = rL;
              else if (src === 'A') srcVal = rA;
              tCycles = 4;
            }
            const oldA = rA;
            const sum = rA + srcVal;
            rA = sum & 0xFF;
            const s = (rA & 0x80) ? 1 : 0;
            const z = (rA === 0) ? 1 : 0;
            const h = ((oldA & 0x0F) + (srcVal & 0x0F) > 0x0F) ? 1 : 0;
            const c = (sum > 0xFF) ? 1 : 0;
            const pv = (((oldA ^ ~srcVal) & (oldA ^ rA)) & 0x80) ? 1 : 0;
            state.flags = { s, z, h, pv, n: 0, c };
            rF = (s << 7) | (z << 6) | (h << 4) | (pv << 2) | c;
          }
        } else if (curItem.mnem === 'ADC') {
          const dest = (curItem.dest || '').replace(',', '').trim();
          const src = curItem.src.trim();
          if (dest === 'HL') {
            const hl = (rH << 8) | rL;
            let val = 0;
            if (src === 'BC') val = (rB << 8) | rC;
            else if (src === 'DE') val = (rD << 8) | rE;
            else if (src === 'HL') val = hl;
            else if (src === 'SP') val = getSp();
            else val = getImmediateVal(src, curItem) || 0;
            const cIn = state.flags.c ? 1 : 0;
            const sum = hl + val + cIn;
            rH = ((sum & 0xFFFF) >> 8) & 0xFF;
            rL = sum & 0xFF;
            const s = (sum & 0x8000) ? 1 : 0;
            const z = ((sum & 0xFFFF) === 0) ? 1 : 0;
            const cOut = (sum > 0xFFFF) ? 1 : 0;
            const pv = (((hl ^ ~val) & (hl ^ sum)) & 0x8000) ? 1 : 0;
            state.flags = { ...state.flags, s, z, pv, n: 0, c: cOut };
            rF = (s << 7) | (z << 6) | (pv << 2) | cOut;
            tCycles = 15;
          } else {
            let srcVal = 0;
            const idxAddr = resolveIndexedAddr(src, curItem);
            if (idxAddr !== null) srcVal = state.memory[idxAddr] || 0;
            else {
              const imm = getImmediateVal(src, curItem);
              if (!isNaN(imm)) srcVal = imm;
              else if (src === 'B') srcVal = rB;
              else if (src === 'C') srcVal = rC;
              else if (src === 'D') srcVal = rD;
              else if (src === 'E') srcVal = rE;
              else if (src === 'H') srcVal = rH;
              else if (src === 'L') srcVal = rL;
              else if (src === 'A') srcVal = rA;
            }
            const cIn = state.flags.c ? 1 : 0;
            const oldA = rA;
            const sum = rA + srcVal + cIn;
            rA = sum & 0xFF;
            const s = (rA & 0x80) ? 1 : 0;
            const z = (rA === 0) ? 1 : 0;
            const h = ((oldA & 0x0F) + (srcVal & 0x0F) + cIn > 0x0F) ? 1 : 0;
            const c = (sum > 0xFF) ? 1 : 0;
            const pv = (((oldA ^ ~srcVal) & (oldA ^ rA)) & 0x80) ? 1 : 0;
            state.flags = { s, z, h, pv, n: 0, c };
            rF = (s << 7) | (z << 6) | (h << 4) | (pv << 2) | c;
            tCycles = 4;
          }
        } else if (curItem.mnem === 'DAA') {
          tCycles = 4;
          let correction = 0;
          let cOut = state.flags.c ? 1 : 0;
          const lowNib = rA & 0x0F;
          const highNib = (rA >> 4) & 0x0F;
          if (state.flags.n) {
            if (state.flags.h || lowNib > 9) correction |= 0x06;
            if (cOut || highNib > 9) {
              correction |= 0x60;
              cOut = 1;
            }
            rA = (rA - correction) & 0xFF;
          } else {
            if (state.flags.h || lowNib > 9) correction |= 0x06;
            if (cOut || highNib > 9 || (highNib === 9 && lowNib > 9)) {
              correction |= 0x60;
              cOut = 1;
            }
            rA = (rA + correction) & 0xFF;
          }
          const s = (rA & 0x80) ? 1 : 0;
          const z = (rA === 0) ? 1 : 0;
          let p = 0; for (let i = 0; i < 8; i++) if ((rA >> i) & 1) p++;
          const pv = (p % 2 === 0) ? 1 : 0;
          state.flags = { ...state.flags, s, z, pv, c: cOut };
          rF = (s << 7) | (z << 6) | (pv << 2) | cOut;
        } else if (curItem.mnem === 'BIT') {
          tCycles = 20;
          const bStr = (curItem.dest || '').replace(',', '').trim();
          let bitNum = parseInt(bStr, 10);
          if (curItem.bytes) {
            const b = curItem.bytes.trim().split(/\s+/).map(x => parseInt(x, 16));
            if (b.length >= 4 && (b[0] === 0xDD || b[0] === 0xFD) && b[1] === 0xCB) {
              bitNum = (b[3] >> 3) & 7;
            } else if (b.length >= 2 && b[0] === 0xCB) {
              bitNum = (b[1] >> 3) & 7;
            }
          }
          if (isNaN(bitNum)) bitNum = getImmediateVal(bStr, curItem);
          const op = (curItem.src || '').trim();
          let val = 0;
          const idxAddr = resolveIndexedAddr(op, curItem);
          if (idxAddr !== null) val = state.memory[idxAddr] || 0;
          else if (op === '(HL)') val = state.memory[(rH << 8) | rL] || 0;
          else if (op === 'A') val = rA;
          else if (op === 'B') val = rB;
          else if (op === 'C') val = rC;
          else if (op === 'D') val = rD;
          else if (op === 'E') val = rE;
          else if (op === 'H') val = rH;
          else if (op === 'L') val = rL;

          const isZero = ((val & (1 << bitNum)) === 0) ? 1 : 0;
          state.flags = { ...state.flags, z: isZero, h: 1, n: 0 };
          rF = (rF & ~0x52) | (isZero << 6) | (1 << 4);
        } else if (curItem.mnem === 'SET' || curItem.mnem === 'RES') {
          tCycles = 23;
          const isSet = curItem.mnem === 'SET';
          const bStr = (curItem.dest || '').replace(',', '').trim();
          let bitNum = parseInt(bStr, 10);
          if (curItem.bytes) {
            const b = curItem.bytes.trim().split(/\s+/).map(x => parseInt(x, 16));
            if (b.length >= 4 && (b[0] === 0xDD || b[0] === 0xFD) && b[1] === 0xCB) {
              bitNum = (b[3] >> 3) & 7;
            } else if (b.length >= 2 && b[0] === 0xCB) {
              bitNum = (b[1] >> 3) & 7;
            }
          }
          if (isNaN(bitNum)) bitNum = getImmediateVal(bStr, curItem);
          const op = (curItem.src || '').trim();
          const idxAddr = resolveIndexedAddr(op, curItem);
          const modifyBit = (v) => isSet ? (v | (1 << bitNum)) : (v & ~(1 << bitNum));

          if (idxAddr !== null) {
            const oldVal = state.memory[idxAddr] || 0;
            const newVal = modifyBit(oldVal) & 0xFF;
            memChanges.push({ addr: idxAddr, oldVal, newVal });
            state.memory[idxAddr] = newVal;
          } else if (op === '(HL)') {
            const addr = (rH << 8) | rL;
            const oldVal = state.memory[addr] || 0;
            const newVal = modifyBit(oldVal) & 0xFF;
            memChanges.push({ addr, oldVal, newVal });
            state.memory[addr] = newVal;
          } else if (op === 'A') rA = modifyBit(rA) & 0xFF;
          else if (op === 'B') rB = modifyBit(rB) & 0xFF;
          else if (op === 'C') rC = modifyBit(rC) & 0xFF;
          else if (op === 'D') rD = modifyBit(rD) & 0xFF;
          else if (op === 'E') rE = modifyBit(rE) & 0xFF;
          else if (op === 'H') rH = modifyBit(rH) & 0xFF;
          else if (op === 'L') rL = modifyBit(rL) & 0xFF;
        } else if (curItem.mnem === 'SUB') {
          const operand = (curItem.dest || curItem.src || '').replace(',', '').trim();
          let srcVal = 0;
          const imm = getImmediateVal(operand, curItem);
          if (!isNaN(imm)) srcVal = imm;
          else if (operand === 'B') srcVal = rB;
          else if (operand === 'C') srcVal = rC;
          else if (operand === 'D') srcVal = rD;
          else if (operand === 'E') srcVal = rE;
          else if (operand === 'H') srcVal = rH;
          else if (operand === 'L') srcVal = rL;
          else if (operand === 'A') srcVal = rA;

          const oldA = rA;
          const diff = rA - srcVal;
          rA = (diff < 0 ? diff + 256 : diff) & 0xFF;
          tCycles = 4;

          const s = (rA & 0x80) ? 1 : 0;
          const z = (rA === 0) ? 1 : 0;
          const h = ((oldA & 0x0F) < (srcVal & 0x0F)) ? 1 : 0;
          const c = (diff < 0) ? 1 : 0;
          const pv = (((oldA ^ srcVal) & (oldA ^ rA)) & 0x80) ? 1 : 0;
          state.flags = { s, z, h, pv, n: 1, c };
          rF = (s << 7) | (z << 6) | (h << 4) | (pv << 2) | (1 << 1) | c;
        } else if (curItem.mnem === 'SBC') {
          tCycles = 15;
          const dest = (curItem.dest || '').replace(',', '').trim();
          const src = (curItem.src || '').trim();
          if (dest === 'HL') {
            const hl = (rH << 8) | rL;
            let val = 0;
            if (src === 'BC') val = (rB << 8) | rC;
            else if (src === 'DE') val = (rD << 8) | rE;
            else if (src === 'HL') val = hl;
            else if (src === 'SP') val = getSp();
            else val = getImmediateVal(src, curItem) || 0;
            const cIn = state.flags.c ? 1 : 0;
            const res = hl - val - cIn;
            rH = ((res & 0xFFFF) >> 8) & 0xFF;
            rL = res & 0xFF;
            const s = (res & 0x8000) ? 1 : 0;
            const z = ((res & 0xFFFF) === 0) ? 1 : 0;
            const cOut = (res < 0) ? 1 : 0;
            state.flags = { ...state.flags, s, z, n: 1, c: cOut };
            rF = (s << 7) | (z << 6) | (1 << 1) | cOut;
          } else {
            let v = 0;
            const op = src || dest;
            if (op === '(HL)') v = state.memory[(rH << 8) | rL] || 0;
            else if (op === 'B') v = rB;
            else if (op === 'C') v = rC;
            else if (op === 'D') v = rD;
            else if (op === 'E') v = rE;
            else if (op === 'H') v = rH;
            else if (op === 'L') v = rL;
            else v = getImmediateVal(op, curItem) || 0;
            const cIn = state.flags.c ? 1 : 0;
            const res = rA - v - cIn;
            rA = (res < 0 ? res + 256 : res) & 0xFF;
            const s = (rA & 0x80) ? 1 : 0;
            const z = (rA === 0) ? 1 : 0;
            const cOut = (res < 0) ? 1 : 0;
            state.flags = { ...state.flags, s, z, n: 1, c: cOut };
            rF = (s << 7) | (z << 6) | (1 << 1) | cOut;
            tCycles = 4;
          }
        } else if (curItem.mnem === 'OR') {
          tCycles = 4;
          const op = (curItem.src || curItem.dest || '').replace(',', '').trim();
          let v = 0;
          if (op === '(HL)') v = state.memory[(rH << 8) | rL] || 0;
          else if (op === 'A') v = rA;
          else if (op === 'B') v = rB;
          else if (op === 'C') v = rC;
          else if (op === 'D') v = rD;
          else if (op === 'E') v = rE;
          else if (op === 'H') v = rH;
          else if (op === 'L') v = rL;
          else v = getImmediateVal(op, curItem) || 0;
          rA = (rA | v) & 0xFF;
          const s = (rA & 0x80) ? 1 : 0;
          const z = (rA === 0) ? 1 : 0;
          let p = 0; for (let i = 0; i < 8; i++) if ((rA >> i) & 1) p++;
          const pv = (p % 2 === 0) ? 1 : 0;
          state.flags = { s, z, h: 0, pv, n: 0, c: 0 };
          rF = (s << 7) | (z << 6) | (pv << 2);
        } else if (curItem.mnem === 'XOR') {
          tCycles = 4;
          const op = (curItem.src || curItem.dest || '').replace(',', '').trim();
          let v = 0;
          if (op === '(HL)') v = state.memory[(rH << 8) | rL] || 0;
          else if (op === 'A') v = rA;
          else if (op === 'B') v = rB;
          else if (op === 'C') v = rC;
          else if (op === 'D') v = rD;
          else if (op === 'E') v = rE;
          else if (op === 'H') v = rH;
          else if (op === 'L') v = rL;
          else v = getImmediateVal(op, curItem) || 0;
          rA = (rA ^ v) & 0xFF;
          const s = (rA & 0x80) ? 1 : 0;
          const z = (rA === 0) ? 1 : 0;
          let p = 0; for (let i = 0; i < 8; i++) if ((rA >> i) & 1) p++;
          const pv = (p % 2 === 0) ? 1 : 0;
          state.flags = { s, z, h: 0, pv, n: 0, c: 0 };
          rF = (s << 7) | (z << 6) | (pv << 2);
        } else if (curItem.mnem === 'AND') {
          tCycles = 4;
          const op = (curItem.src || curItem.dest || '').replace(',', '').trim();
          let v = 0;
          if (op === '(HL)') v = state.memory[(rH << 8) | rL] || 0;
          else if (op === 'A') v = rA;
          else if (op === 'B') v = rB;
          else if (op === 'C') v = rC;
          else if (op === 'D') v = rD;
          else if (op === 'E') v = rE;
          else if (op === 'H') v = rH;
          else if (op === 'L') v = rL;
          else v = getImmediateVal(op, curItem) || 0;
          rA = (rA & v) & 0xFF;
          const s = (rA & 0x80) ? 1 : 0;
          const z = (rA === 0) ? 1 : 0;
          let p = 0; for (let i = 0; i < 8; i++) if ((rA >> i) & 1) p++;
          const pv = (p % 2 === 0) ? 1 : 0;
          state.flags = { s, z, h: 1, pv, n: 0, c: 0 };
          rF = (s << 7) | (z << 6) | (1 << 4) | (pv << 2);
        } else if (curItem.mnem === 'CP') {
          const op = (curItem.dest || curItem.src || '').replace(',', '').trim();
          tCycles = (op === '(HL)') ? 7 : 4;
          let v = 0;
          if (op === '(HL)') v = state.memory[(rH << 8) | rL] || 0;
          else if (op === 'A') v = rA;
          else if (op === 'B') v = rB;
          else if (op === 'C') v = rC;
          else if (op === 'D') v = rD;
          else if (op === 'E') v = rE;
          else if (op === 'H') v = rH;
          else if (op === 'L') v = rL;
          else v = getImmediateVal(op, curItem) || 0;
          const diff = rA - v;
          const s = ((diff & 0xFF) & 0x80) ? 1 : 0;
          const z = (rA === v) ? 1 : 0;
          const c = (rA < v) ? 1 : 0;
          const h = ((rA & 0x0F) < (v & 0x0F)) ? 1 : 0;
          const pv = (((rA ^ v) & (rA ^ (diff & 0xFF))) & 0x80) ? 1 : 0;
          state.flags = { s, z, h, pv, n: 1, c };
          rF = (s << 7) | (z << 6) | (h << 4) | (pv << 2) | (1 << 1) | c;
        } else if (curItem.mnem === 'EX') {
          tCycles = 4;
          const d = (curItem.dest || '').replace(',', '').trim();
          const s = (curItem.src || '').trim();
          if ((d === 'DE' && s === 'HL') || (d === 'HL' && s === 'DE')) {
            const tH = rH, tL = rL;
            rH = rD; rL = rE;
            rD = tH; rE = tL;
          } else if (d === "AF" || s === "AF'") {
            const tA = rA, tF = rF;
            const altAF = parseInt(state.regs.af_alt.replace('0x', ''), 16) || 0;
            rA = (altAF >> 8) & 0xFF;
            rF = altAF & 0xFF;
            state.regs.af_alt = '0x' + ((tA << 8) | tF).toString(16).padStart(4, '0').toUpperCase();
            state.flags = {
              s: (rF >> 7) & 1,
              z: (rF >> 6) & 1,
              h: (rF >> 4) & 1,
              pv: (rF >> 2) & 1,
              n: (rF >> 1) & 1,
              c: rF & 1
            };
          }
        } else if (curItem.mnem === 'EXX') {
          tCycles = 4;
          const bcAlt = parseInt(state.regs.bc_alt.replace('0x', ''), 16) || 0;
          const deAlt = parseInt(state.regs.de_alt.replace('0x', ''), 16) || 0;
          const hlAlt = parseInt(state.regs.hl_alt.replace('0x', ''), 16) || 0;
          state.regs.bc_alt = '0x' + (((rB << 8) | rC) & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
          state.regs.de_alt = '0x' + (((rD << 8) | rE) & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
          state.regs.hl_alt = '0x' + (((rH << 8) | rL) & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
          rB = (bcAlt >> 8) & 0xFF; rC = bcAlt & 0xFF;
          rD = (deAlt >> 8) & 0xFF; rE = deAlt & 0xFF;
          rH = (hlAlt >> 8) & 0xFF; rL = hlAlt & 0xFF;
        } else if (curItem.mnem === 'JR') {
          let shouldJump = true;
          let targetCandidate = '';
          const d = (curItem.dest || '').trim();
          const s = (curItem.src || '').trim();

          if (/^NZ,\s*(.*)$/i.test(d)) {
            shouldJump = !state.flags.z;
            targetCandidate = d.replace(/^NZ,\s*/i, '') || s;
          } else if (/^NZ$/i.test(d)) {
            shouldJump = !state.flags.z;
            targetCandidate = s;
          } else if (/^Z,\s*(.*)$/i.test(d)) {
            shouldJump = !!state.flags.z;
            targetCandidate = d.replace(/^Z,\s*/i, '') || s;
          } else if (/^Z$/i.test(d)) {
            shouldJump = !!state.flags.z;
            targetCandidate = s;
          } else if (/^NC,\s*(.*)$/i.test(d)) {
            shouldJump = !state.flags.c;
            targetCandidate = d.replace(/^NC,\s*/i, '') || s;
          } else if (/^NC$/i.test(d)) {
            shouldJump = !state.flags.c;
            targetCandidate = s;
          } else if (/^C,\s*(.*)$/i.test(d)) {
            shouldJump = !!state.flags.c;
            targetCandidate = d.replace(/^C,\s*/i, '') || s;
          } else if (/^C$/i.test(d)) {
            shouldJump = !!state.flags.c;
            targetCandidate = s;
          } else {
            shouldJump = true;
            targetCandidate = d || s;
          }

          if (shouldJump) {
            tCycles = 12;
            const targetNum = resolveJumpTarget(curItem, targetCandidate);
            if (!isNaN(targetNum)) nextPcNum = targetNum;
          } else {
            tCycles = 7;
          }
        } else if (curItem.mnem === 'JP') {
          let shouldJump = true;
          let targetCandidate = '';
          const d = (curItem.dest || '').trim();
          const s = (curItem.src || '').trim();

          if (/^NZ,\s*(.*)$/i.test(d)) {
            shouldJump = !state.flags.z;
            targetCandidate = d.replace(/^NZ,\s*/i, '') || s;
          } else if (/^NZ$/i.test(d)) {
            shouldJump = !state.flags.z;
            targetCandidate = s;
          } else if (/^Z,\s*(.*)$/i.test(d)) {
            shouldJump = !!state.flags.z;
            targetCandidate = d.replace(/^Z,\s*/i, '') || s;
          } else if (/^Z$/i.test(d)) {
            shouldJump = !!state.flags.z;
            targetCandidate = s;
          } else if (/^NC,\s*(.*)$/i.test(d)) {
            shouldJump = !state.flags.c;
            targetCandidate = d.replace(/^NC,\s*/i, '') || s;
          } else if (/^NC$/i.test(d)) {
            shouldJump = !state.flags.c;
            targetCandidate = s;
          } else if (/^C,\s*(.*)$/i.test(d)) {
            shouldJump = !!state.flags.c;
            targetCandidate = d.replace(/^C,\s*/i, '') || s;
          } else if (/^C$/i.test(d)) {
            shouldJump = !!state.flags.c;
            targetCandidate = s;
          } else if (/^PO,\s*(.*)$/i.test(d)) {
            shouldJump = !state.flags.pv;
            targetCandidate = d.replace(/^PO,\s*/i, '') || s;
          } else if (/^PO$/i.test(d)) {
            shouldJump = !state.flags.pv;
            targetCandidate = s;
          } else if (/^PE,\s*(.*)$/i.test(d)) {
            shouldJump = !!state.flags.pv;
            targetCandidate = d.replace(/^PE,\s*/i, '') || s;
          } else if (/^PE$/i.test(d)) {
            shouldJump = !!state.flags.pv;
            targetCandidate = s;
          } else if (/^P,\s*(.*)$/i.test(d)) {
            shouldJump = !state.flags.s;
            targetCandidate = d.replace(/^P,\s*/i, '') || s;
          } else if (/^P$/i.test(d)) {
            shouldJump = !state.flags.s;
            targetCandidate = s;
          } else if (/^M,\s*(.*)$/i.test(d)) {
            shouldJump = !!state.flags.s;
            targetCandidate = d.replace(/^M,\s*/i, '') || s;
          } else if (/^M$/i.test(d)) {
            shouldJump = !!state.flags.s;
            targetCandidate = s;
          } else if (d === '(HL)' || d === 'HL') {
            shouldJump = true;
            nextPcNum = (rH << 8) | rL;
            tCycles = 4;
            targetCandidate = null;
          } else if (d === '(IX)' || d === 'IX') {
            shouldJump = true;
            nextPcNum = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
            tCycles = 8;
            targetCandidate = null;
          } else if (d === '(IY)' || d === 'IY') {
            shouldJump = true;
            nextPcNum = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;
            tCycles = 8;
            targetCandidate = null;
          } else {
            shouldJump = true;
            targetCandidate = d || s;
          }

          if (targetCandidate) {
            tCycles = 10;
            if (shouldJump) {
              const targetNum = resolveJumpTarget(curItem, targetCandidate);
              if (!isNaN(targetNum)) nextPcNum = targetNum;
            }
          }
        } else if (curItem.mnem === 'INC') {
          const dest = curItem.dest.replace(',', '').trim();
          if (dest === 'A') { rA = (rA + 1) & 0xFF; }
          else if (dest === 'B') { rB = (rB + 1) & 0xFF; }
          else if (dest === 'C') { rC = (rC + 1) & 0xFF; }
          else if (dest === 'D') { rD = (rD + 1) & 0xFF; }
          else if (dest === 'E') { rE = (rE + 1) & 0xFF; }
          else if (dest === 'H') { rH = (rH + 1) & 0xFF; }
          else if (dest === 'L') { rL = (rL + 1) & 0xFF; }
          else if (dest === 'BC') { const v = (((rB << 8) | rC) + 1) & 0xFFFF; rB = (v >> 8) & 0xFF; rC = v & 0xFF; tCycles = 6; }
          else if (dest === 'DE') { const v = (((rD << 8) | rE) + 1) & 0xFFFF; rD = (v >> 8) & 0xFF; rE = v & 0xFF; tCycles = 6; }
          else if (dest === 'HL') { const v = (((rH << 8) | rL) + 1) & 0xFFFF; rH = (v >> 8) & 0xFF; rL = v & 0xFF; tCycles = 6; }
          else if (dest === 'SP') { let sp = (getSp() + 1) & 0xFFFF; state.regs.sp = '0x' + sp.toString(16).padStart(4, '0').toUpperCase(); tCycles = 6; }
          else if (dest === 'IX') { let ix = (parseInt(state.regs.ix.replace('0x', ''), 16) + 1) & 0xFFFF; state.regs.ix = '0x' + ix.toString(16).padStart(4, '0').toUpperCase(); tCycles = 10; }
          else if (dest === 'IY') { let iy = (parseInt(state.regs.iy.replace('0x', ''), 16) + 1) & 0xFFFF; state.regs.iy = '0x' + iy.toString(16).padStart(4, '0').toUpperCase(); tCycles = 10; }
          else if (dest === '(HL)') {
            const a = (rH << 8) | rL;
            const newVal = ((state.memory[a] || 0) + 1) & 0xFF;
            memChanges.push({ addr: a, oldVal: state.memory[a] || 0, newVal });
            state.memory[a] = newVal;
            tCycles = 11;
          } else if (dest === 'IXH') {
            let ix = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
            let val = ((ix >> 8) + 1) & 0xFF;
            state.regs.ix = '0x' + (((val & 0xFF) << 8) | (ix & 0xFF)).toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IXL') {
            let ix = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
            let val = ((ix & 0xFF) + 1) & 0xFF;
            state.regs.ix = '0x' + ((ix & 0xFF00) | (val & 0xFF)).toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IYH') {
            let iy = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;
            let val = ((iy >> 8) + 1) & 0xFF;
            state.regs.iy = '0x' + (((val & 0xFF) << 8) | (iy & 0xFF)).toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IYL') {
            let iy = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;
            let val = ((iy & 0xFF) + 1) & 0xFF;
            state.regs.iy = '0x' + ((iy & 0xFF00) | (val & 0xFF)).toString(16).padStart(4, '0').toUpperCase();
          }
          if (['A', 'B', 'C', 'D', 'E', 'H', 'L', '(HL)'].includes(dest)) {
            const val = dest === '(HL)' ? state.memory[(rH << 8) | rL] : (dest === 'A' ? rA : (dest === 'B' ? rB : (dest === 'C' ? rC : (dest === 'D' ? rD : (dest === 'E' ? rE : (dest === 'H' ? rH : rL))))));
            const z = (val & 0xFF) === 0 ? 1 : 0;
            const s = (val & 0x80) ? 1 : 0;
            state.flags = { ...state.flags, s, z };
          }
          tCycles = tCycles || 4;
        } else if (curItem.mnem === 'DEC') {
          const dest = curItem.dest.replace(',', '').trim();
          if (dest === 'A') { rA = (rA - 1) & 0xFF; }
          else if (dest === 'B') { rB = (rB - 1) & 0xFF; }
          else if (dest === 'C') { rC = (rC - 1) & 0xFF; }
          else if (dest === 'D') { rD = (rD - 1) & 0xFF; }
          else if (dest === 'E') { rE = (rE - 1) & 0xFF; }
          else if (dest === 'H') { rH = (rH - 1) & 0xFF; }
          else if (dest === 'L') { rL = (rL - 1) & 0xFF; }
          else if (dest === 'BC') { const v = (((rB << 8) | rC) - 1) & 0xFFFF; rB = (v >> 8) & 0xFF; rC = v & 0xFF; tCycles = 6; }
          else if (dest === 'DE') { const v = (((rD << 8) | rE) - 1) & 0xFFFF; rD = (v >> 8) & 0xFF; rE = v & 0xFF; tCycles = 6; }
          else if (dest === 'HL') { const v = (((rH << 8) | rL) - 1) & 0xFFFF; rH = (v >> 8) & 0xFF; rL = v & 0xFF; tCycles = 6; }
          else if (dest === 'SP') { let sp = (getSp() - 1) & 0xFFFF; state.regs.sp = '0x' + sp.toString(16).padStart(4, '0').toUpperCase(); tCycles = 6; }
          else if (dest === 'IX') { let ix = (parseInt(state.regs.ix.replace('0x', ''), 16) - 1) & 0xFFFF; state.regs.ix = '0x' + ix.toString(16).padStart(4, '0').toUpperCase(); tCycles = 10; }
          else if (dest === 'IY') { let iy = (parseInt(state.regs.iy.replace('0x', ''), 16) - 1) & 0xFFFF; state.regs.iy = '0x' + iy.toString(16).padStart(4, '0').toUpperCase(); tCycles = 10; }
          else if (dest === '(HL)') {
            const a = (rH << 8) | rL;
            const newVal = ((state.memory[a] || 0) - 1) & 0xFF;
            memChanges.push({ addr: a, oldVal: state.memory[a] || 0, newVal });
            state.memory[a] = newVal;
            tCycles = 11;
          } else if (dest === 'IXH') {
            let ix = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
            let val = ((ix >> 8) - 1) & 0xFF;
            state.regs.ix = '0x' + (((val & 0xFF) << 8) | (ix & 0xFF)).toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IXL') {
            let ix = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
            let val = ((ix & 0xFF) - 1) & 0xFF;
            state.regs.ix = '0x' + ((ix & 0xFF00) | (val & 0xFF)).toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IYH') {
            let iy = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;
            let val = ((iy >> 8) - 1) & 0xFF;
            state.regs.iy = '0x' + (((val & 0xFF) << 8) | (iy & 0xFF)).toString(16).padStart(4, '0').toUpperCase();
          } else if (dest === 'IYL') {
            let iy = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;
            let val = ((iy & 0xFF) - 1) & 0xFF;
            state.regs.iy = '0x' + ((iy & 0xFF00) | (val & 0xFF)).toString(16).padStart(4, '0').toUpperCase();
          }
          if (['A', 'B', 'C', 'D', 'E', 'H', 'L', '(HL)'].includes(dest)) {
            const val = dest === '(HL)' ? state.memory[(rH << 8) | rL] : (dest === 'A' ? rA : (dest === 'B' ? rB : (dest === 'C' ? rC : (dest === 'D' ? rD : (dest === 'E' ? rE : (dest === 'H' ? rH : rL))))));
            const z = (val & 0xFF) === 0 ? 1 : 0;
            const s = (val & 0x80) ? 1 : 0;
            state.flags = { ...state.flags, s, z, n: 1 };
          }
          tCycles = tCycles || 4;
        } else if (curItem.mnem === 'DJNZ') {
          rB = (rB - 1) & 0xFF;
          if (rB !== 0) {
            tCycles = 13;
            const targetNum = resolveJumpTarget(curItem, curItem.dest || curItem.src);
            if (!isNaN(targetNum)) nextPcNum = targetNum;
          } else {
            tCycles = 8;
          }
        } else if (curItem.mnem === 'PUSH') {
          tCycles = 11;
          const dest = curItem.dest.replace(',', '').trim();
          let val16 = 0;
          if (dest === 'BC') val16 = (rB << 8) | rC;
          else if (dest === 'DE') val16 = (rD << 8) | rE;
          else if (dest === 'HL') val16 = (rH << 8) | rL;
          else if (dest === 'AF') val16 = (rA << 8) | rF;
          else if (dest === 'IX') val16 = parseInt(state.regs.ix.replace('0x', ''), 16) || 0;
          else if (dest === 'IY') val16 = parseInt(state.regs.iy.replace('0x', ''), 16) || 0;

          let spNum = getSp();
          const hi = (val16 >> 8) & 0xFF;
          const lo = val16 & 0xFF;
          const addrHi = (spNum - 1) & 0xFFFF;
          const addrLo = (spNum - 2) & 0xFFFF;
          memChanges.push({ addr: addrHi, oldVal: state.memory[addrHi] || 0, newVal: hi });
          memChanges.push({ addr: addrLo, oldVal: state.memory[addrLo] || 0, newVal: lo });
          state.memory[addrHi] = hi;
          state.memory[addrLo] = lo;
          spNum = addrLo;
          state.regs.sp = '0x' + spNum.toString(16).padStart(4, '0').toUpperCase();
          busAddr = '0x' + spNum.toString(16).padStart(4, '0').toUpperCase();
          busData = lo.toString(16).padStart(2, '0').toUpperCase();
        } else if (curItem.mnem === 'POP') {
          tCycles = 10;
          const dest = curItem.dest.replace(',', '').trim();
          let spNum = getSp();
          const lo = state.memory[spNum] || 0;
          const hi = state.memory[(spNum + 1) & 0xFFFF] || 0;
          spNum = (spNum + 2) & 0xFFFF;
          state.regs.sp = '0x' + spNum.toString(16).padStart(4, '0').toUpperCase();

          const val16 = (hi << 8) | lo;
          if (dest === 'BC') { rB = hi; rC = lo; }
          else if (dest === 'DE') { rD = hi; rE = lo; }
          else if (dest === 'HL') { rH = hi; rL = lo; }
          else if (dest === 'AF') {
            rA = hi; rF = lo;
            state.flags = {
              s: (lo >> 7) & 1,
              z: (lo >> 6) & 1,
              h: (lo >> 4) & 1,
              pv: (lo >> 2) & 1,
              n: (lo >> 1) & 1,
              c: lo & 1
            };
          }
          else if (dest === 'IX') { state.regs.ix = '0x' + val16.toString(16).padStart(4, '0').toUpperCase(); }
          else if (dest === 'IY') { state.regs.iy = '0x' + val16.toString(16).padStart(4, '0').toUpperCase(); }
          busAddr = '0x' + ((spNum - 2) & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
          busData = lo.toString(16).padStart(2, '0').toUpperCase();
          state.lastUpdatedReg = dest.toLowerCase();
          state.lastOpType = 'POP';
          state.lastOpDesc = `POP ${dest} <= 0x${val16.toString(16).padStart(4, '0').toUpperCase()} (from [0x${((spNum - 2) & 0xFFFF).toString(16).padStart(4, '0').toUpperCase()}])`;
        } else if (curItem.mnem === 'CALL') {
          let shouldCall = true;
          let targetCandidate = '';
          const d = (curItem.dest || '').trim();
          const s = (curItem.src || '').trim();

          if (/^NZ,\s*(.*)$/i.test(d)) {
            shouldCall = !state.flags.z;
            targetCandidate = d.replace(/^NZ,\s*/i, '') || s;
          } else if (/^NZ$/i.test(d)) {
            shouldCall = !state.flags.z;
            targetCandidate = s;
          } else if (/^Z,\s*(.*)$/i.test(d)) {
            shouldCall = !!state.flags.z;
            targetCandidate = d.replace(/^Z,\s*/i, '') || s;
          } else if (/^Z$/i.test(d)) {
            shouldCall = !!state.flags.z;
            targetCandidate = s;
          } else if (/^NC,\s*(.*)$/i.test(d)) {
            shouldCall = !state.flags.c;
            targetCandidate = d.replace(/^NC,\s*/i, '') || s;
          } else if (/^NC$/i.test(d)) {
            shouldCall = !state.flags.c;
            targetCandidate = s;
          } else if (/^C,\s*(.*)$/i.test(d)) {
            shouldCall = !!state.flags.c;
            targetCandidate = d.replace(/^C,\s*/i, '') || s;
          } else if (/^C$/i.test(d)) {
            shouldCall = !!state.flags.c;
            targetCandidate = s;
          } else {
            shouldCall = true;
            targetCandidate = d || s;
          }

          if (shouldCall) {
            tCycles = 17;
            let spNum = getSp();
            const retAddr = nextPcNum;
            const hi = (retAddr >> 8) & 0xFF;
            const lo = retAddr & 0xFF;
            const addrHi = (spNum - 1) & 0xFFFF;
            const addrLo = (spNum - 2) & 0xFFFF;
            memChanges.push({ addr: addrHi, oldVal: state.memory[addrHi] || 0, newVal: hi });
            memChanges.push({ addr: addrLo, oldVal: state.memory[addrLo] || 0, newVal: lo });
            state.memory[addrHi] = hi;
            state.memory[addrLo] = lo;
            spNum = addrLo;
            state.regs.sp = '0x' + spNum.toString(16).padStart(4, '0').toUpperCase();

            const targetNum = resolveJumpTarget(curItem, targetCandidate);
            if (!isNaN(targetNum)) nextPcNum = targetNum;
          } else {
            tCycles = 10;
          }
        } else if (curItem.mnem === 'RET') {
          let shouldRet = true;
          const d = (curItem.dest || '').trim();
          if (/^NZ$/i.test(d)) shouldRet = !state.flags.z;
          else if (/^Z$/i.test(d)) shouldRet = !!state.flags.z;
          else if (/^NC$/i.test(d)) shouldRet = !state.flags.c;
          else if (/^C$/i.test(d)) shouldRet = !!state.flags.c;

          if (shouldRet) {
            tCycles = 10;
            let spNum = getSp();
            const lo = state.memory[spNum] || 0;
            const hi = state.memory[(spNum + 1) & 0xFFFF] || 0;
            spNum = (spNum + 2) & 0xFFFF;
            state.regs.sp = '0x' + spNum.toString(16).padStart(4, '0').toUpperCase();
            nextPcNum = (hi << 8) | lo;
          } else {
            tCycles = 5;
          }
        } else if (curItem.mnem === 'HALT') {
          nextPcNum = pcNum;
          tCycles = 4;
          if (state.isRunning) {
            if (runTimer) {
              clearInterval(runTimer);
              runTimer = null;
            }
            state.isRunning = false;
            state.statusMsg = 'CPU HALTED';
          }
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
      const isHalted = (curItem && curItem.mnem === 'HALT');

      if (hitBp) {
        if (state.isRunning) {
          stopRunning();
        }
        state.hitBpId = hitBp.id;
        state.statusMsg = `BP HIT: 0x${nextPcHex}`;
      } else {
        state.hitBpId = null;
        state.statusMsg = null;
      }

      if (isHalted && state.isRunning) {
        stopRunning();
      }

      if (!isSilent) {
        notify('local');
        setTimeout(() => {
          state.bus = { ...state.bus, active: false };
          notify('local');
        }, 200);
      }

      return isHalted || !!hitBp;
    }

    function runTurboChunk() {
      if (!state.isRunning) return;

      const BATCH_SIZE = 1000;
      const TIME_SLICE_MS = 20; // 20ms execution budget per slice (~50 FPS)
      const startT = (typeof performance !== 'undefined' ? performance.now() : Date.now());

      let count = 0;
      let shouldStop = false;

      while (count < BATCH_SIZE && !shouldStop && state.isRunning) {
        const hit = step(true); // silent = true: zero DOM/cloning overhead
        count++;
        if (hit) {
          shouldStop = true;
          break;
        }
        if (count % 100 === 0) {
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          if (now - startT >= TIME_SLICE_MS) {
            break;
          }
        }
      }

      if (shouldStop || !state.isRunning) {
        stopRunning();
        const newSteps = state.history.slice(turboStartHistoryLen);
        if (newSteps.length > 0) {
          syncMmioBatchToFbb(newSteps.slice(-500));
          turboStartHistoryLen = state.history.length;
          skipNextSingleSync = true;
        }
        notify('local'); // Full synchronization to all panes upon stop/breakpoint/HALT
        return;
      }

      // Throttled UI update (~30ms) for Registers & Controller
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - lastTurboUiTime >= 30) {
        lastTurboUiTime = now;
        notify('turbo_tick');
      }

      // Periodic stream to F-BB Tracer every 300ms during long Turbo runs
      if (now - lastTurboFlushTime >= 300) {
        lastTurboFlushTime = now;
        const newSteps = state.history.slice(turboStartHistoryLen);
        if (newSteps.length > 0) {
          syncMmioBatchToFbb(newSteps.slice(-500));
          turboStartHistoryLen = state.history.length;
        }
      }

      if (state.isRunning) {
        if (typeof requestAnimationFrame !== 'undefined') {
          turboRaf = requestAnimationFrame(runTurboChunk);
        } else {
          turboRaf = setTimeout(runTurboChunk, 0);
        }
      }
    }

    function backstep() {
      if (state.isTimeTraveling) return;
      if (state.history.length === 0) return;
      const prev = state.history.pop();
      if (prev.memChanges) {
        for (const ch of prev.memChanges) {
          state.memory[ch.addr] = ch.oldVal;
        }
      }
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
      stopRunning();
      state.isRunning = false;
      state.stepCount = 0;
      state.cycleCount = 0;
      state.currentPc = (loadedProgramData && loadedProgramData.startPc) ? loadedProgramData.startPc : '0000';
      state.lastExecuted = 'NOP';
      state.regs = {
        af: '0x0000', bc: '0x0000', de: '0x0000', hl: '0x0000',
        af_alt: '0x5500', bc_alt: '0x0000', de_alt: '0x0000', hl_alt: '0x0000',
        ix: '0x1234', iy: '0x0000', sp: '0x0000', pc: '0x' + state.currentPc,
        i: '0x00', r: '0x00', im: 0
      };
      state.flags = { s: 0, z: 0, h: 0, pv: 0, n: 0, c: 0 };
      state.bus = {
        addr: '0x0000', data_in: '0x00', data_out: '0x00',
        mreq: false, iorq: false, rd: false, wr: false, m1: false,
        active: false
      };
      // Reset stack memory area
      for (let i = 0xFF00; i < 0x10000; i++) {
        state.memory[i] = 0x00;
      }
      if (loadedProgramData && loadedProgramData.memoryMap) {
        for (const [addrStr, val] of Object.entries(loadedProgramData.memoryMap)) {
          const a = parseInt(addrStr, 10);
          if (!isNaN(a) && a >= 0 && a < 65536) state.memory[a] = val;
        }
      } else if (loadedProgramData && loadedProgramData.memory) {
        for (let i = 0; i < loadedProgramData.memory.length; i++) {
          state.memory[i] = loadedProgramData.memory[i];
        }
      }
      state.history = [];
      turboStartHistoryLen = 0;
      if (typeof window !== 'undefined' && window.FBB && window.FBB.socket) {
        window.FBB.socket.emit('trace-history-clear');
      }
      notify('local');
    }

    function setRunning(running) {
      if (state.isTimeTraveling && running) return;
      stopRunning();
      state.isRunning = running;

      if (running) {
        turboStartHistoryLen = state.history.length;
        lastTurboFlushTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (state.clockSpeed === 0) {
          lastTurboUiTime = lastTurboFlushTime;
          notify('local'); // Update button to 'Stop' immediately
          if (typeof requestAnimationFrame !== 'undefined') {
            turboRaf = requestAnimationFrame(runTurboChunk);
          } else {
            turboRaf = setTimeout(runTurboChunk, 0);
          }
        } else {
          runTimer = setInterval(() => {
            step(false);
          }, state.clockSpeed);
          notify('local');
        }
      } else {
        const newSteps = state.history.slice(turboStartHistoryLen);
        if (newSteps.length > 0) {
          syncMmioBatchToFbb(newSteps.slice(-500));
          turboStartHistoryLen = state.history.length;
          skipNextSingleSync = true;
        }
        notify('local');
      }
    }

    function setClockSpeed(speed) {
      state.clockSpeed = speed;
      if (state.isRunning) {
        setRunning(false);
        setRunning(true);
      } else {
        notify('local');
      }
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
          const { memChanges, memoryProg, memoryStack, stackBase, memory, ...rest } = e.data.payload;
          state = { ...state, ...rest };
          if (memChanges && state.memory) {
            for (const ch of memChanges) {
              if (typeof ch.addr === 'number' && typeof ch.newVal === 'number') {
                state.memory[ch.addr] = ch.newVal;
              }
            }
          }
          notify('remote');
        } else if (e.data && e.data.type === 'TURBO_TICK') {
          const { regs, flags, currentPc, stepCount, cycleCount, isRunning } = e.data.payload;
          state.regs = regs;
          state.flags = flags;
          state.currentPc = currentPc;
          state.stepCount = stepCount;
          state.cycleCount = cycleCount;
          state.isRunning = isRunning;
          notify('turbo_tick');
        }
      };
    }

    window.__RCT_STORE__ = {
      version: 11,
      _channel: channel,
      _listeners: listeners,
      getState: () => state,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      actions: {
        step: () => step(false),
        backstep: () => backstep(),
        reset: () => reset(),
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
    return store.subscribe((newState, origin) => { if (origin === 'turbo_tick') return; setState({ ...newState }); });
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


const DEFAULT_COL_WIDTHS = {
  addr: 48,
  bp: 22,
  bytes: 58,
  label: 140,
  mnem: 68,
  dest: 60,
  src: 60,
  comment: 280
};

const COLUMNS = [
  { key: 'addr', label: 'Addr' },
  { key: 'bp', label: '' },
  { key: 'bytes', label: 'Bytes' },
  { key: 'label', label: 'Label' },
  { key: 'mnem', label: 'Mnemonic' },
  { key: 'dest', label: 'Dest' },
  { key: 'src', label: 'Src' },
  { key: 'comment', label: 'Comment' }
];

export default function RctCodeViewPane(props = {}) {
  const FBB = window.FBB || {};
  const React = FBB.React || window.React;
  const { useState, useRef, useEffect, useMemo } = FBB.hooks || React;
  const [state, actions] = useRctStore();

  const findPcBreakpoint = (breakpoints, addrStr) => {
    if (!breakpoints || !addrStr) return null;
    const targetHex = addrStr.replace(/^0x/i, '').padStart(4, '0').toUpperCase();
    return breakpoints.find(bp => {
      if (bp.type !== 'PC_MATCH') return false;
      const match = bp.condition.match(/(?:0x)?([0-9a-fA-F]{1,4})/);
      return match && match[1].padStart(4, '0').toUpperCase() === targetHex;
    });
  };

  const togglePcBreakpoint = (addrStr) => {
    if (!addrStr || !actions) return;
    const targetHex = addrStr.replace(/^0x/i, '').padStart(4, '0').toUpperCase();
    const existing = findPcBreakpoint(state.breakpoints, targetHex);
    if (existing) {
      if (typeof actions.removeBreakpoint === 'function') {
        actions.removeBreakpoint(existing.id);
      }
    } else {
      if (typeof actions.addBreakpoint === 'function') {
        actions.addBreakpoint('PC_MATCH', `0x${targetHex}`);
      }
    }
  };

  // Keyboard Shortcuts: Enter for Step, Shift+Enter for Backstep, 'r' for Reset, 'g' for Run
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleKeyDown = (e) => {
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) {
        return;
      }
      // Never intercept browser system shortcuts (e.g. Ctrl+R, Cmd+R for reload)
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      const store = window.__RCT_STORE__;
      if (!store || !store.actions) return;
      const curState = store.getState();
      if (curState.isTimeTraveling) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          if (typeof store.actions.backstep === 'function') {
            store.actions.backstep();
          }
        } else {
          if (typeof store.actions.step === 'function') {
            store.actions.step();
          }
        }
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (typeof store.actions.reset === 'function') {
          store.actions.reset();
        }
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        if (typeof store.actions.setRunning === 'function') {
          store.actions.setRunning(!curState.isRunning);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const program = state.program || [];
  const currentPc = state.currentPc || '0000';
  const activeRowRef = useRef(null);
  const tableContainerRef = useRef(null);

  // Floating hover tooltip state
  const [tooltip, setTooltip] = useState(null);

  // Configurable scroll margin (remaining lines kept visible ahead/behind cursor)
  const getInitialScrollMargin = () => {
    if (props.params && typeof props.params.scrollMargin === 'number') {
      return props.params.scrollMargin;
    }
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = parseInt(localStorage.getItem('fbb_rct_code_view_scroll_margin'), 10);
        if (!isNaN(saved) && saved >= 0 && saved <= 30) {
          return saved;
        }
      } catch (e) {}
    }
    return 5;
  };

  const [scrollMargin, setScrollMargin] = useState(getInitialScrollMargin);

  const saveScrollMargin = (newMargin) => {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('fbb_rct_code_view_scroll_margin', String(newMargin));
      } catch (e) {}
    }
    if (props.api && typeof props.api.updateParameters === 'function') {
      try {
        props.api.updateParameters({ ...(props.params || {}), scrollMargin: newMargin });
      } catch (e) {}
    }
  };

  // Fast symbol table lookup (Labels and EQU constants)
  const safeUseMemo = useMemo || ((fn) => fn());
  const symbolTable = safeUseMemo(() => {
    const map = new Map();
    for (let i = 0; i < program.length; i++) {
      const p = program[i];
      if (p.label) {
        const clean = p.label.replace(/:+$/, '').trim();
        if (clean) {
          let addr = p.addr ? parseInt(p.addr, 16) : null;
          if (addr !== null && !isNaN(addr)) {
            map.set(clean, {
              name: clean,
              type: 'label',
              addr: addr,
              hex: '0x' + addr.toString(16).padStart(4, '0').toUpperCase(),
              dec: addr,
              lineIndex: i
            });
          }
        }
      }
      if (p.mnem && /\bEQU\b/i.test(p.mnem)) {
        const equMatch = p.mnem.match(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*EQU\s+([^;\n\r]+)/i) ||
                         p.mnem.match(/([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+([^;\n\r]+)/i);
        if (equMatch) {
          const name = equMatch[1].trim();
          const raw = equMatch[2].trim();
          let val = null;
          if (/^0x[0-9a-f]+$/i.test(raw)) val = parseInt(raw, 16);
          else if (/^\$[0-9a-f]+$/i.test(raw)) val = parseInt(raw.slice(1), 16);
          else if (/^[0-9]+$/.test(raw)) val = parseInt(raw, 10);
          map.set(name, {
            name: name,
            type: 'equ',
            raw: raw,
            value: val,
            hex: val !== null ? '0x' + (val & 0xFFFF).toString(16).padStart(4, '0').toUpperCase() : null,
            dec: val,
            lineIndex: i
          });
        }
      }
    }
    return map;
  }, [program]);

  const REG_SET = safeUseMemo(() => new Set([
    'A', 'B', 'C', 'D', 'E', 'H', 'L',
    'AF', 'BC', 'DE', 'HL', 'IX', 'IY', 'SP', 'PC',
    'I', 'R', "AF'", "BC'", "DE'", "HL'"
  ]), []);

  const isTokenResolvable = (tok, cellText) => {
    if (!tok) return false;
    const clean = tok.replace(/^[(),]+|[(),]+$/g, '').trim();
    if (!clean) return false;
    if (symbolTable.has(clean)) return true;
    if (REG_SET.has(clean.toUpperCase())) return true;
    if (/^0x[0-9a-f]+$/i.test(clean) || /^\$[0-9a-f]+$/i.test(clean)) return true;
    if (/^[0-9]+$/.test(clean) && clean.length <= 5) return true;
    return false;
  };

  const resolveTokenInfo = (token, cellText, rowItem, colType) => {
    if (colType === 'addr') {
      const aNum = parseInt(token, 16);
      if (isNaN(aNum)) return null;
      const hex = '0x' + (aNum & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
      const memBytes = [];
      if (state.memory) {
        for (let i = 0; i < 8; i++) {
          memBytes.push(state.memory[(aNum + i) & 0xFFFF] || 0);
        }
      }
      const hexDump = memBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      const asciiDump = memBytes.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
      let matchingLabel = null;
      for (const [k, v] of symbolTable.entries()) {
        if (v.type === 'label' && v.addr === aNum) {
          matchingLabel = k;
          break;
        }
      }
      return {
        name: hex,
        category: 'Memory Address',
        badgeColor: '#06b6d4',
        hex: hex,
        dec: aNum,
        detail: matchingLabel ? `Label: ${matchingLabel}:` : undefined,
        memPreview: { addrHex: hex, hexDump, asciiDump }
      };
    }

    const cleanTok = (token || '').replace(/^[(),]+|[(),]+$/g, '').trim();
    if (!cleanTok) return null;

    // 0. Indexed Memory Expression: (IX + OFF_PC_L) or (IY - 1)
    const idxMatch = (cellText || '').match(/^\s*\(\s*(IX|IY)\s*([+-])\s*([^)]+)\s*\),?\s*$/i);
    if (idxMatch) {
      const baseReg = idxMatch[1].toUpperCase();
      const sign = idxMatch[2];
      const offToken = idxMatch[3].trim();
      let offVal = 0;
      let offHex = '0x00';
      let equDef = null;
      if (symbolTable.has(offToken)) {
        const sym = symbolTable.get(offToken);
        offVal = sym.dec !== null && sym.dec !== undefined ? sym.dec : 0;
        offHex = sym.hex || '0x00';
        if (sym.type === 'equ') equDef = `${offToken}: EQU ${sym.raw}`;
      } else if (/^0x[0-9a-f]+$/i.test(offToken)) {
        offVal = parseInt(offToken, 16);
        offHex = offToken;
      } else if (/^[0-9]+$/.test(offToken)) {
        offVal = parseInt(offToken, 10);
        offHex = '0x' + offVal.toString(16).padStart(2, '0').toUpperCase();
      }
      const baseHex = (state.regs && state.regs[baseReg.toLowerCase()]) || '0x0000';
      const baseVal = parseInt(baseHex, 16);
      const effAddr = (baseVal + (sign === '-' ? -offVal : offVal)) & 0xFFFF;
      const effHex = '0x' + effAddr.toString(16).padStart(4, '0').toUpperCase();
      const memVal = (state.memory && state.memory[effAddr]) || 0;
      return {
        name: `(${baseReg} ${sign} ${offToken})`,
        category: 'Indexed Operand',
        badgeColor: '#f97316',
        hex: effHex,
        dec: effAddr,
        definition: equDef,
        detail: `Base ${baseReg} = ${baseHex} | Offset = ${sign}${offVal} (${offHex})`,
        memAtReg: `Memory @ [${effHex}] = 0x${memVal.toString(16).padStart(2, '0').toUpperCase()} (${memVal})`
      };
    }

    // 1. Symbol Table match (Label or EQU)
    if (symbolTable.has(cleanTok)) {
      const sym = symbolTable.get(cleanTok);
      if (sym.type === 'label') {
        const addr = sym.addr;
        const memBytes = [];
        if (state.memory) {
          for (let i = 0; i < 8; i++) {
            memBytes.push(state.memory[(addr + i) & 0xFFFF] || 0);
          }
        }
        const hexDump = memBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        const asciiDump = memBytes.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        const targetProg = program.find(p => p.addr && parseInt(p.addr, 16) === addr);
        let targetCode = null;
        if (targetProg) {
          targetCode = `${targetProg.addr}: ${targetProg.mnem || ''} ${targetProg.dest || ''} ${targetProg.src || ''} ${targetProg.comment || ''}`.trim();
        }
        return {
          name: cleanTok,
          category: 'Label / Target Address',
          badgeColor: '#38bdf8',
          hex: sym.hex,
          dec: sym.dec,
          targetCode: targetCode,
          memPreview: { addrHex: sym.hex, hexDump, asciiDump }
        };
      } else if (sym.type === 'equ') {
        return {
          name: cleanTok,
          category: 'Constant (EQU)',
          badgeColor: '#a855f7',
          hex: sym.hex || 'N/A',
          dec: sym.dec !== null && sym.dec !== undefined ? sym.dec : 'N/A',
          definition: `${cleanTok}: EQU ${sym.raw}`
        };
      }
    }

    // 2. 16-bit Register
    const upper = cleanTok.toUpperCase();
    const r16Map = {
      'AF': 'af', 'BC': 'bc', 'DE': 'de', 'HL': 'hl',
      'IX': 'ix', 'IY': 'iy', 'SP': 'sp', 'PC': 'pc'
    };
    if (r16Map[upper]) {
      const key = r16Map[upper];
      const valHex = (state.regs && state.regs[key]) || '0x0000';
      const valNum = parseInt(valHex, 16);
      const hi = (valNum >> 8) & 0xFF;
      const lo = valNum & 0xFF;
      const memVal = (state.memory && state.memory[valNum]) || 0;
      const flags = state.flags || {};
      return {
        name: upper,
        category: '16-bit Register',
        badgeColor: '#22c55e',
        hex: valHex,
        dec: valNum,
        detail: upper === 'AF'
          ? `A: 0x${hi.toString(16).padStart(2, '0').toUpperCase()} | Flags: S=${flags.s || 0} Z=${flags.z || 0} H=${flags.h || 0} C=${flags.c || 0}`
          : `${upper[0]}: 0x${hi.toString(16).padStart(2, '0').toUpperCase()} | ${upper[1]}: 0x${lo.toString(16).padStart(2, '0').toUpperCase()}`,
        memAtReg: `[${upper}] = [${valHex}] -> 0x${memVal.toString(16).padStart(2, '0').toUpperCase()} (${memVal})`
      };
    }

    // 3. 8-bit Register
    const r8Map = { 'A': 'af', 'B': 'bc', 'C': 'bc', 'D': 'de', 'E': 'de', 'H': 'hl', 'L': 'hl' };
    if (r8Map[upper]) {
      const parentKey = r8Map[upper];
      const parentVal = parseInt((state.regs && state.regs[parentKey]) || '0', 16);
      const isHigh = ['A', 'B', 'D', 'H'].includes(upper);
      const val8 = isHigh ? ((parentVal >> 8) & 0xFF) : (parentVal & 0xFF);
      return {
        name: upper,
        category: '8-bit Register',
        badgeColor: '#10b981',
        hex: '0x' + val8.toString(16).padStart(2, '0').toUpperCase(),
        dec: val8,
        binary: '0b' + val8.toString(2).padStart(8, '0')
      };
    }

    // 4. Immediate Number / Hex
    let immVal = null;
    if (/^0x[0-9a-f]+$/i.test(cleanTok)) immVal = parseInt(cleanTok, 16);
    else if (/^\$[0-9a-f]+$/i.test(cleanTok)) immVal = parseInt(cleanTok.slice(1), 16);
    else if (/^[0-9]+$/.test(cleanTok)) immVal = parseInt(cleanTok, 10);

    if (immVal !== null) {
      const hex = '0x' + immVal.toString(16).toUpperCase();
      return {
        name: cleanTok,
        category: 'Immediate Value',
        badgeColor: '#eab308',
        hex: hex,
        dec: immVal,
        binary: immVal < 256 ? '0b' + immVal.toString(2).padStart(8, '0') : undefined
      };
    }

    return null;
  };

  const handleTokenMouseEnter = (token, cellText, rowItem, e, colType) => {
    const info = resolveTokenInfo(token, cellText, rowItem, colType);
    if (!info) return;
    setTooltip({
      ...info,
      x: e.clientX + 16,
      y: e.clientY + 16
    });
  };

  const handleMouseMove = (e) => {
    setTooltip(prev => {
      if (!prev) return null;
      return {
        ...prev,
        x: e.clientX + 16,
        y: e.clientY + 16
      };
    });
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  const renderInteractiveCell = (cellText, colType, rowItem, isCur) => {
    if (!cellText) return '';
    const text = String(cellText);

    if (colType === 'addr') {
      const aNum = parseInt(text, 16);
      if (!isNaN(aNum)) {
        return React.createElement('span', {
          title: 'Hover to inspect memory at address',
          onMouseEnter: (e) => handleTokenMouseEnter(text, text, rowItem, e, 'addr'),
          onMouseMove: handleMouseMove,
          onMouseLeave: handleMouseLeave,
          style: {
            cursor: 'help',
            borderBottom: '1px dotted rgba(56, 189, 248, 0.4)'
          }
        }, text);
      }
      return text;
    }

    const parts = text.split(/([A-Za-z_][A-Za-z0-9_]*|\$[0-9A-Fa-f]+|0x[0-9A-Fa-f]+|\b[0-9]+\b)/g);
    return parts.map((part, idx) => {
      if (!part) return null;
      const isResolvable = isTokenResolvable(part, text);
      if (!isResolvable) {
        return part;
      }
      return React.createElement('span', {
        key: idx,
        onMouseEnter: (e) => handleTokenMouseEnter(part, text, rowItem, e, colType),
        onMouseMove: handleMouseMove,
        onMouseLeave: handleMouseLeave,
        style: {
          cursor: 'help',
          borderBottom: '1px dotted rgba(56, 189, 248, 0.7)',
          transition: 'all 0.15s ease'
        }
      }, part);
    });
  };

  const getInitialWidths = () => {
    if (props.params && props.params.colWidths) {
      return { ...DEFAULT_COL_WIDTHS, ...props.params.colWidths };
    }
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = JSON.parse(localStorage.getItem('fbb_rct_code_view_col_widths') || '{}');
        if (saved && typeof saved === 'object' && Object.keys(saved).length > 0) {
          return { ...DEFAULT_COL_WIDTHS, ...saved };
        }
      } catch (e) {}
    }
    return DEFAULT_COL_WIDTHS;
  };

  const [colWidths, setColWidths] = useState(getInitialWidths);
  const [resizingCol, setResizingCol] = useState(null);
  const resizeInfoRef = useRef({ colKey: null, startX: 0, startWidth: 0 });
  const colWidthsRef = useRef(colWidths);
  colWidthsRef.current = colWidths;

  const saveWidths = (newWidths) => {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('fbb_rct_code_view_col_widths', JSON.stringify(newWidths));
      } catch (e) {}
    }
    if (props.api && typeof props.api.updateParameters === 'function') {
      try {
        props.api.updateParameters({ ...(props.params || {}), colWidths: newWidths });
      } catch (e) {}
    }
  };

  const startResize = (colKey, e) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingCol(colKey);
    resizeInfoRef.current = {
      colKey,
      startX: e.clientX,
      startWidth: colWidthsRef.current[colKey] || DEFAULT_COL_WIDTHS[colKey] || 60
    };

    const handleMouseMove = (moveEvent) => {
      const { colKey, startX, startWidth } = resizeInfoRef.current;
      if (!colKey) return;
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(28, startWidth + delta);
      setColWidths(prev => {
        const next = { ...prev, [colKey]: newWidth };
        colWidthsRef.current = next;
        return next;
      });
    };

    const handleMouseUp = (upEvent) => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      setResizingCol(null);
      const { colKey, startX, startWidth } = resizeInfoRef.current;
      if (colKey) {
        const delta = upEvent.clientX - startX;
        const finalWidth = Math.max(28, startWidth + delta);
        const next = { ...colWidthsRef.current, [colKey]: finalWidth };
        colWidthsRef.current = next;
        setColWidths(next);
        saveWidths(next);
      }
      resizeInfoRef.current = { colKey: null, startX: 0, startWidth: 0 };
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  useEffect(() => {
    if (!activeRowRef.current || !tableContainerRef.current) return;
    const container = tableContainerRef.current;
    const activeRow = activeRowRef.current;

    const thead = container.querySelector('thead');
    const theadHeight = thead ? thead.offsetHeight : 26;
    const rowHeight = activeRow.offsetHeight || 24;
    const clientHeight = container.clientHeight;
    const scrollHeight = container.scrollHeight;
    const currentScrollTop = container.scrollTop;

    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const visibleHeight = Math.max(rowHeight, clientHeight - theadHeight);

    // Limit margin so top and bottom margins never overlap even in small panes
    const maxMarginPx = Math.max(0, Math.floor((visibleHeight - rowHeight) / 2));
    const marginPx = Math.min(scrollMargin * rowHeight, maxMarginPx);

    const rowTop = activeRow.offsetTop;
    const rowBottom = rowTop + rowHeight;

    const minVisibleTop = currentScrollTop + theadHeight + marginPx;
    const maxVisibleBottom = currentScrollTop + clientHeight - marginPx;

    let targetScrollTop = currentScrollTop;

    if (rowTop < minVisibleTop) {
      targetScrollTop = rowTop - theadHeight - marginPx;
    } else if (rowBottom > maxVisibleBottom) {
      targetScrollTop = rowBottom - clientHeight + marginPx;
    }

    // Clamp to [0, maxScrollTop] so PC reaches top edge (PC=0) and bottom edge (HALT) seamlessly
    targetScrollTop = Math.max(0, Math.min(maxScrollTop, targetScrollTop));

    if (Math.abs(targetScrollTop - currentScrollTop) > 1) {
      const isFast = state.isRunning || Math.abs(targetScrollTop - currentScrollTop) > 300;
      container.scrollTo({
        top: targetScrollTop,
        behavior: isFast ? 'auto' : 'smooth'
      });
    }
  }, [currentPc, scrollMargin, state.isRunning]);

  const totalTableWidth = Object.values(colWidths).reduce((a, b) => a + b, 0);

  return React.createElement(
    'div',
    { style: S.container },

    React.createElement('div', { style: S.header },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        React.createElement('span', null, 'Disassembly View'),
        React.createElement('button', {
          title: 'Reset column widths to default (Addr:48, Bytes:58, Label:140, ...)',
          onClick: () => {
            setColWidths(DEFAULT_COL_WIDTHS);
            colWidthsRef.current = DEFAULT_COL_WIDTHS;
            saveWidths(DEFAULT_COL_WIDTHS);
          },
          style: {
            background: 'transparent',
            border: '1px solid #334155',
            color: '#94a3b8',
            borderRadius: '3px',
            padding: '1px 5px',
            fontSize: '10px',
            cursor: 'pointer'
          }
        }, 'Reset Cols'),
        React.createElement('div', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '3px',
            padding: '1px 5px',
            fontSize: '10px',
            color: '#94a3b8'
          },
          title: 'Remaining lines kept visible ahead/behind cursor before scrolling begins (0: edge scroll, 1-20: margin)'
        },
          React.createElement('span', null, 'Margin:'),
          React.createElement('input', {
            type: 'number',
            min: 0,
            max: 20,
            value: scrollMargin,
            onChange: (e) => {
              const val = Math.max(0, Math.min(20, parseInt(e.target.value, 10) || 0));
              setScrollMargin(val);
              saveScrollMargin(val);
            },
            style: {
              width: '28px',
              background: '#1e293b',
              color: '#38bdf8',
              border: '1px solid #475569',
              borderRadius: '2px',
              padding: '0 2px',
              fontSize: '10px',
              textAlign: 'center',
              outline: 'none',
              fontFamily: 'monospace'
            }
          }),
          React.createElement('span', null, 'lines')
        )
      ),
      state.isTimeTraveling && React.createElement('span', {
        style: { background: '#f59e0b', color: '#000', padding: '1px 6px', borderRadius: '3px', fontSize: '10px', fontWeight: 'bold' }
      }, '⏱ TIME-TRAVEL'),
      React.createElement('span', { style: { color: '#38bdf8', fontFamily: 'monospace' } }, `PC: 0x${currentPc}`)
    ),

    React.createElement('style', null, `
      .bp-gutter-cell:hover .bp-ghost {
        opacity: 0.5 !important;
        background-color: #e51400 !important;
      }
      .bp-gutter-cell {
        position: relative;
      }
    `),

    React.createElement('div', {
      ref: tableContainerRef,
      style: { ...S.content, background: '#0f131a', fontFamily: 'monospace', overflowX: 'auto', overflowY: 'auto' }
    },
      React.createElement('table', { style: { width: '100%', minWidth: `${totalTableWidth}px`, borderCollapse: 'collapse', fontSize: '11px', tableLayout: 'fixed' } },
        React.createElement('thead', null,
          React.createElement('tr', { style: { color: '#64748b', borderBottom: '1px solid #1e293b', background: '#131822', position: 'sticky', top: 0, zIndex: 5 } },
            COLUMNS.map(col => React.createElement('th', {
              key: col.key,
              style: {
                width: `${colWidths[col.key]}px`,
                minWidth: `${colWidths[col.key]}px`,
                maxWidth: `${colWidths[col.key]}px`,
                padding: col.key === 'bp' ? '5px 0' : '5px 6px',
                textAlign: col.key === 'bp' ? 'center' : 'left',
                position: 'relative',
                boxSizing: 'border-box',
                userSelect: 'none',
                overflow: 'hidden'
              }
            },
              React.createElement('span', {
                style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: col.key === 'bp' ? '#475569' : '#64748b' },
                title: col.key === 'bp' ? 'Breakpoints (Click in row to toggle)' : undefined
              }, col.key === 'bp' ? '●' : col.label),
              col.key !== 'bp' && React.createElement('div', {
                title: 'Drag to adjust column width',
                onMouseDown: (e) => startResize(col.key, e),
                style: {
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: '6px',
                  cursor: 'col-resize',
                  zIndex: 10,
                  background: resizingCol === col.key ? '#38bdf8' : 'transparent',
                  borderRight: resizingCol === col.key ? '2px solid #38bdf8' : '1px solid #2d3748'
                }
              })
            ))
          )
        ),
        React.createElement('tbody', null,
          program.map((p, idx) => {
            if (p.isComment) {
              const isHeader = p.comment && p.comment.includes('=====');
              return React.createElement('tr', {
                key: idx,
                style: {
                  background: isHeader ? '#1a2234' : 'transparent',
                  color: isHeader ? '#38bdf8' : '#64748b',
                  fontStyle: 'italic',
                  fontWeight: isHeader ? 'bold' : 'normal',
                  borderBottom: isHeader ? '1px solid #1e293b' : 'none'
                }
              },
                React.createElement('td', { style: { padding: '2px 6px', color: '#475569' } }, ''),
                React.createElement('td', { colSpan: 7, style: { padding: '2px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, p.comment || '')
              );
            }
            if (p.isLabel) {
              const isBpSet = !!findPcBreakpoint(state.breakpoints, p.addr);
              return React.createElement('tr', {
                key: idx,
                style: { background: 'transparent', color: '#38bdf8', fontWeight: 'bold' }
              },
                React.createElement('td', { style: { padding: '3px 6px', color: '#475569' } }, renderInteractiveCell(p.addr || '', 'addr', p, false)),
                React.createElement('td', {
                  className: 'bp-gutter-cell',
                  style: {
                    width: `${colWidths.bp || 22}px`,
                    maxWidth: `${colWidths.bp || 22}px`,
                    minWidth: `${colWidths.bp || 22}px`,
                    padding: '3px 0',
                    textAlign: 'center',
                    verticalAlign: 'middle',
                    cursor: p.addr ? 'pointer' : 'default',
                    userSelect: 'none'
                  },
                  onClick: p.addr ? (e) => { e.stopPropagation(); togglePcBreakpoint(p.addr); } : undefined,
                  title: p.addr ? (isBpSet ? `Breakpoint at 0x${p.addr} (Click to remove)` : `Click to set Breakpoint at 0x${p.addr}`) : undefined
                },
                  isBpSet ? React.createElement('div', {
                    style: {
                      width: '9px',
                      height: '9px',
                      borderRadius: '50%',
                      backgroundColor: '#e51400',
                      boxShadow: '0 0 6px #e51400',
                      margin: '0 auto',
                      transition: 'all 0.12s ease'
                    }
                  }) : (p.addr ? React.createElement('div', {
                    className: 'bp-ghost',
                    style: {
                      width: '9px',
                      height: '9px',
                      borderRadius: '50%',
                      border: '1px solid transparent',
                      margin: '0 auto',
                      opacity: 0,
                      transition: 'opacity 0.15s ease'
                    }
                  }) : null)
                ),
                React.createElement('td', { colSpan: 6, style: { padding: '3px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, renderInteractiveCell(p.label || '', 'label', p, false))
              );
            }
            const isCur = p.addr && p.addr === currentPc;
            const isBpSet = !!findPcBreakpoint(state.breakpoints, p.addr);
            return React.createElement('tr', {
              key: idx,
              ref: isCur ? activeRowRef : null,
              style: {
                background: isCur ? '#3f3810' : 'transparent',
                borderLeft: isCur ? '3px solid #facc15' : '3px solid transparent',
                color: isCur ? '#facc15' : '#cbd5e1'
              }
            },
              React.createElement('td', { style: { width: `${colWidths.addr}px`, maxWidth: `${colWidths.addr}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '4px 6px', color: isCur ? '#fde047' : '#64748b' } }, renderInteractiveCell(p.addr, 'addr', p, isCur)),
              React.createElement('td', {
                className: 'bp-gutter-cell',
                style: {
                  width: `${colWidths.bp || 22}px`,
                  maxWidth: `${colWidths.bp || 22}px`,
                  minWidth: `${colWidths.bp || 22}px`,
                  padding: '4px 0',
                  textAlign: 'center',
                  verticalAlign: 'middle',
                  cursor: p.addr ? 'pointer' : 'default',
                  userSelect: 'none'
                },
                onClick: p.addr ? (e) => { e.stopPropagation(); togglePcBreakpoint(p.addr); } : undefined,
                title: p.addr ? (isBpSet ? `Breakpoint at 0x${p.addr} (Click to remove)` : `Click to set Breakpoint at 0x${p.addr}`) : undefined
              },
                isBpSet ? React.createElement('div', {
                  style: {
                    width: '9px',
                    height: '9px',
                    borderRadius: '50%',
                    backgroundColor: '#e51400',
                    boxShadow: '0 0 6px #e51400',
                    margin: '0 auto',
                    transition: 'all 0.12s ease'
                  }
                }) : (p.addr ? React.createElement('div', {
                  className: 'bp-ghost',
                  style: {
                    width: '9px',
                    height: '9px',
                    borderRadius: '50%',
                    border: '1px solid transparent',
                    margin: '0 auto',
                    opacity: 0,
                    transition: 'opacity 0.15s ease'
                  }
                }) : null)
              ),
              React.createElement('td', { style: { width: `${colWidths.bytes}px`, maxWidth: `${colWidths.bytes}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '4px 6px', color: '#94a3b8' } }, p.bytes),
              React.createElement('td', { style: { width: `${colWidths.label}px`, maxWidth: `${colWidths.label}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '4px 6px', color: '#38bdf8', fontWeight: 'bold' } }, renderInteractiveCell(p.label || '', 'label', p, isCur)),
              React.createElement('td', { style: { width: `${colWidths.mnem}px`, maxWidth: `${colWidths.mnem}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '4px 6px', color: isCur ? '#fde047' : '#4ade80', fontWeight: 'bold' } }, p.mnem),
              React.createElement('td', { style: { width: `${colWidths.dest}px`, maxWidth: `${colWidths.dest}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '4px 6px', color: isCur ? '#fef08a' : '#facc15' } }, renderInteractiveCell(p.dest || '', 'dest', p, isCur)),
              React.createElement('td', { style: { width: `${colWidths.src}px`, maxWidth: `${colWidths.src}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '4px 6px', color: isCur ? '#fed7aa' : '#fb923c' } }, renderInteractiveCell(p.src || '', 'src', p, isCur)),
              React.createElement('td', { style: { width: `${colWidths.comment}px`, maxWidth: `${colWidths.comment}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '4px 6px', color: '#64748b', fontStyle: 'italic' } }, p.comment || '')
            );
          })
        )
      )
    ),

    // Floating Symbol & Operand Inspector Tooltip
    tooltip && React.createElement('div', {
      style: {
        position: 'fixed',
        left: `${typeof window !== 'undefined' && tooltip.x + 320 > window.innerWidth ? Math.max(10, tooltip.x - 340) : tooltip.x}px`,
        top: `${typeof window !== 'undefined' && tooltip.y + 220 > window.innerHeight ? Math.max(10, tooltip.y - 230) : tooltip.y}px`,
        zIndex: 9999,
        pointerEvents: 'none',
        backgroundColor: '#0f172a',
        border: `1px solid ${tooltip.badgeColor || '#38bdf8'}`,
        boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.7), 0 8px 10px -6px rgba(0, 0, 0, 0.7)',
        borderRadius: '6px',
        padding: '8px 12px',
        fontSize: '11px',
        lineHeight: '1.4',
        fontFamily: 'monospace',
        color: '#e2e8f0',
        maxWidth: '340px',
        minWidth: '240px',
        boxSizing: 'border-box'
      }
    },
      React.createElement('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          borderBottom: '1px solid #1e293b',
          paddingBottom: '4px',
          marginBottom: '6px'
        }
      },
        React.createElement('span', { style: { fontWeight: 'bold', fontSize: '12px', color: '#f8fafc' } }, tooltip.name),
        React.createElement('span', {
          style: {
            fontSize: '9px',
            fontWeight: 'bold',
            padding: '1px 6px',
            borderRadius: '3px',
            color: '#fff',
            backgroundColor: tooltip.badgeColor || '#38bdf8'
          }
        }, tooltip.category)
      ),
      tooltip.hex && React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '2px' } },
        React.createElement('span', { style: { color: '#94a3b8' } }, 'Resolved Value:'),
        React.createElement('span', { style: { color: '#facc15', fontWeight: 'bold' } }, `${tooltip.hex} (${tooltip.dec})`)
      ),
      tooltip.binary && React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '2px' } },
        React.createElement('span', { style: { color: '#94a3b8' } }, 'Binary:'),
        React.createElement('span', { style: { color: '#38bdf8' } }, tooltip.binary)
      ),
      tooltip.definition && React.createElement('div', {
        style: {
          color: '#c084fc',
          fontStyle: 'italic',
          marginTop: '4px',
          borderTop: '1px dashed #334155',
          paddingTop: '4px'
        }
      }, tooltip.definition),
      tooltip.detail && React.createElement('div', {
        style: { color: '#94a3b8', fontSize: '10px', marginTop: '3px' }
      }, tooltip.detail),
      tooltip.memAtReg && React.createElement('div', {
        style: { color: '#4ade80', fontSize: '10px', marginTop: '3px' }
      }, tooltip.memAtReg),
      tooltip.targetCode && React.createElement('div', {
        style: {
          marginTop: '4px',
          borderTop: '1px dashed #334155',
          paddingTop: '4px',
          color: '#fde047',
          fontSize: '10px'
        }
      },
        React.createElement('span', { style: { color: '#94a3b8' } }, 'Target: '),
        tooltip.targetCode
      ),
      tooltip.memPreview && React.createElement('div', {
        style: {
          marginTop: '6px',
          borderTop: '1px solid #1e293b',
          paddingTop: '4px',
          background: '#090d16',
          padding: '4px 6px',
          borderRadius: '4px'
        }
      },
        React.createElement('div', { style: { color: '#94a3b8', fontSize: '9px', marginBottom: '2px' } }, `Memory @ [${tooltip.memPreview.addrHex}]:`),
        React.createElement('div', { style: { color: '#38bdf8', fontSize: '10px', letterSpacing: '0.5px' } }, tooltip.memPreview.hexDump),
        React.createElement('div', { style: { color: '#a7f3d0', fontSize: '10px', marginTop: '2px' } }, `ASCII: "${tooltip.memPreview.asciiDump}"`)
      )
    )
  );
}
