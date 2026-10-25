export const minApiVersion = 1;


function getRctStore() {
  if (typeof window === 'undefined') return null;
  if (!window.__RCT_STORE__ || (window.__RCT_STORE__.version || 0) < 2) {
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

    let loadedProgramData = null;

    let state = {
      stepCount: 0,
      cycleCount: 0,
      isRunning: false,
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
      breakpoints: [
        { id: 1, type: 'PC_MATCH', condition: '== 0x0003 (EX_TEST)', status: 'Active' }
      ],
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
            memoryProg: Array.from(state.memory.slice(0, 512)),
            memoryStack: Array.from(state.memory.slice(0xFF00, 0x10000)),
            stackBase: 0xFF00
          }
        });
      }
    }

    function getSp() {
      const v = parseInt(state.regs.sp.replace('0x', ''), 16);
      return isNaN(v) ? 0 : v;
    }

    // Accurate Z80 Instruction Stepping Engine
    function step() {
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

      state.lastUpdatedReg = null;
      state.lastOpType = curItem ? curItem.mnem : 'NOP';
      state.lastOpDesc = null;

      const resolveJumpTarget = (item, candidate) => {
        const candidates = [candidate, item && item.dest, item && item.src].filter(Boolean);
        for (let cand of candidates) {
          const cleaned = cand.replace('$', '').replace('(', '').replace(')', '').replace(',', '').trim();
          // 1. Try finding by label in program
          const match = state.program.find(p => {
            if (!p.label) return false;
            const l = p.label.replace(':', '').trim();
            return l.toLowerCase() === cleaned.toLowerCase();
          });
          if (match) {
            const a = parseInt(match.addr, 16);
            if (!isNaN(a)) return a;
          }
          // 2. Try hex address (e.g. 0005, 0x0005, $0005)
          if (/^(0x)?[0-9a-fA-F]{1,4}$/i.test(cleaned)) {
            const a = parseInt(cleaned.replace(/^0x/i, ''), 16);
            if (!isNaN(a)) return a;
          }
          // 3. Try relative offset e.g. (-5), +5, -5
          const offMatch = cand.match(/^[\(\[]?\s*([+-]?\d+)\s*[\)\]]?$/);
          if (offMatch) {
            const offset = parseInt(offMatch[1], 10);
            const instrLen = item && item.bytes ? item.bytes.trim().split(/\s+/).length : 2;
            const basePc = item && item.addr ? parseInt(item.addr, 16) : pcNum;
            return (basePc + instrLen + offset) & 0xFFFF;
          }
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
          if (src.startsWith('$')) {
            srcVal = parseInt(src.replace('$', '0x'), 16);
            tCycles = dest.length === 2 ? 10 : 7;
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
          else if (dest === 'SP') {
            state.regs.sp = '0x' + (srcVal & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
          }
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
        } else if (curItem.mnem === 'SUB') {
          const operand = (curItem.dest || curItem.src || '').replace(',', '').trim();
          let srcVal = 0;
          if (operand === 'B') srcVal = rB;
          else if (operand === 'C') srcVal = rC;
          else if (operand === 'D') srcVal = rD;
          else if (operand === 'E') srcVal = rE;
          else if (operand === 'H') srcVal = rH;
          else if (operand === 'L') srcVal = rL;
          else if (operand === 'A') srcVal = rA;
          else if (operand.startsWith('$')) srcVal = parseInt(operand.replace('$', '0x'), 16);

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
          memChanges.push({ addr: addrHi, oldVal: state.memory[addrHi] });
          memChanges.push({ addr: addrLo, oldVal: state.memory[addrLo] });
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
          else if (dest === 'AF') { rA = hi; rF = lo; }
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
            memChanges.push({ addr: addrHi, oldVal: state.memory[addrHi] });
            memChanges.push({ addr: addrLo, oldVal: state.memory[addrLo] });
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
      if (runTimer) {
        clearInterval(runTimer);
        runTimer = null;
      }
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
      if (loadedProgramData && loadedProgramData.memory) {
        for (let i = 0; i < loadedProgramData.memory.length; i++) {
          state.memory[i] = loadedProgramData.memory[i];
        }
      }
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
          const { memoryProg, memoryStack, stackBase, memory, ...rest } = e.data.payload;
          state = { ...state, ...rest };
          if (memoryProg && state.memory) {
            for (let i = 0; i < memoryProg.length; i++) {
              state.memory[i] = memoryProg[i];
            }
          }
          if (memoryStack && state.memory && typeof stackBase === 'number') {
            for (let i = 0; i < memoryStack.length; i++) {
              state.memory[stackBase + i] = memoryStack[i];
            }
          }
          notify('remote');
        }
      };
    }

    window.__RCT_STORE__ = {
      version: 2,
      _listeners: listeners,
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


export default function RctMemoryPane() {
  const FBB = window.FBB || {};
  const React = FBB.React || window.React;
  const { useState, useEffect, useRef } = FBB.hooks || React;
  const [state] = useRctStore();

  const memory = state.memory || new Uint8Array(65536);
  const currentPcNum = parseInt(state.currentPc || '0000', 16);

  const containerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [gotoAddr, setGotoAddr] = useState('');

  const ROW_HEIGHT = 20;
  const TOTAL_ROWS = 4096;
  const TOTAL_HEIGHT = TOTAL_ROWS * ROW_HEIGHT;

  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (containerRef.current) {
        setViewportHeight(containerRef.current.clientHeight);
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const handleScroll = (e) => {
    setScrollTop(e.target.scrollTop);
  };

  const handleGoto = () => {
    if (!gotoAddr) return;
    const target = parseInt(gotoAddr.replace('0x', ''), 16);
    if (!isNaN(target) && target >= 0 && target <= 0xFFFF) {
      const row = Math.floor(target / 16);
      if (containerRef.current) {
        containerRef.current.scrollTop = row * ROW_HEIGHT;
      }
    }
  };

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + 8;
  const endIndex = Math.min(TOTAL_ROWS, startIndex + visibleCount);

  const rows = [];
  for (let r = startIndex; r < endIndex; r++) {
    const rowAddr = r * 16;
    const addrHex = rowAddr.toString(16).padStart(4, '0').toUpperCase();

    const byteSpans = [];
    let asciiStr = '';
    for (let b = 0; b < 16; b++) {
      const byteAddr = rowAddr + b;
      const val = memory[byteAddr] || 0;
      const hexVal = val.toString(16).padStart(2, '0').toUpperCase();
      const isPc = byteAddr === currentPcNum;

      byteSpans.push(React.createElement('span', {
        key: b,
        style: {
          color: isPc ? '#facc15' : (val !== 0 ? '#4ade80' : '#475569'),
          background: isPc ? '#3f3810' : 'transparent',
          fontWeight: isPc ? 'bold' : 'normal',
          width: '18px',
          textAlign: 'center',
          display: 'inline-block',
          borderRadius: '2px'
        }
      }, hexVal));

      asciiStr += (val >= 32 && val <= 126) ? String.fromCharCode(val) : '.';
    }

    const isRom = rowAddr < 0x4000;
    rows.push(React.createElement('div', {
      key: r,
      style: {
        height: `${ROW_HEIGHT}px`,
        lineHeight: `${ROW_HEIGHT}px`,
        display: 'flex',
        gap: '8px',
        whiteSpace: 'nowrap',
        padding: '0 8px',
        fontSize: '11px',
        fontFamily: 'monospace'
      }
    },
      React.createElement('span', {
        style: { color: isRom ? '#f87171' : '#38bdf8', width: '45px', flexShrink: 0 }
      }, `${addrHex}:`),
      React.createElement('div', {
        style: { display: 'flex', gap: '6px', width: '380px', flexShrink: 0 }
      }, byteSpans),
      React.createElement('span', {
        style: { color: '#64748b', marginLeft: '14px', letterSpacing: '1px' }
      }, asciiStr)
    ));
  }

  return React.createElement(
    'div',
    { style: S.container },

    React.createElement('div', { style: S.header },
      React.createElement('span', null, 'Memory Map & Hex Dump (0x0000 - 0xFFFF)'),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        React.createElement('span', { style: { fontSize: '10px', color: '#64748b' } }, 'Goto:'),
        React.createElement('input', {
          placeholder: '0x8000',
          value: gotoAddr,
          onChange: e => setGotoAddr(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter') handleGoto(); },
          style: { width: '55px', background: '#0b0f17', color: '#fff', border: '1px solid #334155', padding: '1px 4px', fontSize: '10px', borderRadius: '2px' }
        }),
        React.createElement('button', {
          style: { ...S.btn('#0284c7'), padding: '2px 6px', fontSize: '10px' },
          onClick: handleGoto
        }, 'Go')
      )
    ),

    React.createElement('div', {
      style: {
        background: '#131822',
        padding: '4px 10px',
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: '10px',
        fontFamily: 'monospace',
        borderBottom: '1px solid #232b3b',
        flexShrink: 0
      }
    },
      React.createElement('span', { style: { color: '#f87171' } }, '0000 - 3FFF: ROM (RO)'),
      React.createElement('span', { style: { color: '#4ade80' } }, '8000 - FFFF: RAM (RW)')
    ),

    React.createElement('div', {
      ref: containerRef,
      onScroll: handleScroll,
      style: {
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        background: '#090d14',
        position: 'relative'
      }
    },
      React.createElement('div', { style: { height: `${TOTAL_HEIGHT}px`, width: '100%', position: 'relative' } },
        React.createElement('div', {
          style: {
            position: 'absolute',
            top: `${startIndex * ROW_HEIGHT}px`,
            left: 0,
            right: 0
          }
        }, rows)
      )
    )
  );
}
