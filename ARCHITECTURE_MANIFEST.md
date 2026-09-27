# Architecture Manifest: RetroCoreTracer for F-BB (RetroCoreTracer-FBB)

本ドキュメントは、**Core-Intent Prompting (CIP)** フレームワークに基づき、**RetroCoreTracer for F-BB (`RetroCoreTracer-FBB`)** の根本的な設計理念、アーキテクチャ境界、通信規約、およびライセンス戦略を定義する「プロジェクトの憲法」である。

どんなに軽微な実装・変更であっても、本マニフェストの原則および ADR に反してはならない。

---

## 1. 核となる設計理念 (Core Intent & Philosophy)

1. **「計算の本質を可視化する (Visualizing the Essence of Computation)」**:
   単なる命令シミュレーションにとどまらず、Verilog HDL によるサイクル正確なハードウェア回路（RTL）の脈動、アドレス・データバスの信号伝播（Bus Glow）、レジスタとフラグの微細な変化を一切の妥協なく可視化する。
2. **時間を巻き戻すタイムトラベル・デバッグ (Deterministic Time-Travel & Backstepping)**:
   実機の FPGA やシリコンチップでは不可能な「過去への巻き戻し（Undo / Backstep）」を、不変スナップショット履歴バッファにより決定論的かつ 100% の精度で実現する。
3. **F-BB PPA 5.1 & DPPA v1.0 のリファレンス・フラグシップ実装 (Zero-Touch & Zero-Build)**:
   F-BB 本体のコードを 1 行も改変せず、完全な外部リポジトリとして「ハードウェアエミュレーション（PPA）」と「リッチな動的スタジオ UI（DPPA）」をシームレスに結合する。
4. **知財の完全なクリーンルーム開発 (Pure-Intent License Strategy)**:
   外部の GPL/LGPL コア（T80, A-Z80 等）のコード混入を一切排除し、主要命令から第一原理に基づいて自作することで、100% クリーンな MIT ライセンスを維持する。

---

## 2. 疎結合 4 層アーキテクチャ (4-Layer Decoupled Architecture)

本システムは、各層が独立して開発・単体テスト・差し替えができるよう、以下の 4 層に完全分離される。

```
┌────────────────────────────────────────────────────────────────────────┐
│ [Layer 1: DPPA Web Studio] (pane/)                                     │
│  React 19 / Dockview / Canvas. Zero-Build Native ES Module.            │
│  CodeView, MemoryMap, CoreCanvas, Breakpoints, Flags, HexDump, Regs   │
└──────────────────────────────────▲─────────────────────────────────────┘
                                   │ WebSocket / JSON-RPC (完全な疎結合)
┌──────────────────────────────────▼─────────────────────────────────────┐
│ [Layer 2: C++ Simulator Daemon] (src/)                                 │
│  Verilator Harness, 64KB Memory, Intel HEX Loader, Snapshot Buffer     │
│  fbb::PluginCLI 準拠 UNIX Domain Socket サーバー                       │
└──────────────────────────────────▲─────────────────────────────────────┘
                                   │ クロック駆動 & プローブ端子評価
┌──────────────────────────────────▼─────────────────────────────────────┐
│ [Layer 3: Verilog RTL Core] (rtl/)                                     │
│  Pure Verilog-2001 Z80 Core (z80_top.v, z80_alu.v, z80_registers.v)    │
│  Bus Glow / Snapshot 用の内部信号がトップポートに抽出されている         │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│ [Layer 4: Standalone Scenario] (scenario/)                             │
│  config.dts (Device Tree), run.sh (Standalone Launcher)                │
│  F-BB の ./start_lab.sh から直接指定して起動可能                       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 通信プロトコル規約 (JSON-RPC & Telemetry Interface)

Layer 1 (UI) と Layer 2 (C++ Daemon) は、UNIX ドメインソケットおよび WebSocket を介して以下の JSON 仕様で通信する。

### 3.1. UI  Daemon 制御コマンド (Inbound Commands)
```json
{ "cmd": "step", "count": 1 }
{ "cmd": "backstep", "count": 1 }
{ "cmd": "run", "clock_hz": 10 }
{ "cmd": "stop" }
{ "cmd": "reset" }
{ "cmd": "load_hex", "hex_text": ":10000000..." }
{ "cmd": "set_breakpoint", "type": "pc", "value": "0x000A" }
{ "cmd": "remove_breakpoint", "id": 1 }
```

### 3.2. Daemon  UI テレメトリ通知 (Outbound Telemetry)
ステップ実行またはクロック更新ごとに、以下の完全スナップショットを JSON 配信する：
```json
{
  "type": "telemetry",
  "step": 42,
  "cycles": 128,
  "pc": "0x000A",
  "executed_mnemonic": "LD A,(IX+05H)",
  "registers": {
    "af": "0x0000", "bc": "0x0000", "de": "0x0000", "hl": "0x0000",
    "af_alt": "0x5500", "bc_alt": "0x0000", "de_alt": "0x0000", "hl_alt": "0x0000",
    "ix": "0x1234", "iy": "0x0000", "sp": "0x0000", "pc": "0x000A",
    "i": "0x00", "r": "0x00", "im": 0
  },
  "flags": { "s": 0, "z": 0, "h": 0, "pv": 0, "n": 0, "c": 0 },
  "bus": {
    "addr": "0x1239",
    "data_in": "0x55",
    "data_out": "0x00",
    "mreq_n": 0,
    "iorq_n": 1,
    "rd_n": 0,
    "wr_n": 1,
    "m1_n": 1
  },
  "memory_diff": [
    { "addr": "0x1239", "val": "0x55" }
  ]
}
```

---

## 4. タイムトラベル（Undo / Backstep）の決定論仕様

1. **リングバッファ構造 (`SnapshotRingBuffer`)**:
   過去 1,000 ステップ分の CPU 全レジスタ、クロックサイクル数、および「直前のメモリ書き換え差分（Undo Diff: 変更されたアドレスと元の値）」をリングバッファに常時記録する。
2. **状態復元プロトコル (State Restoration)**:
   `backstep` コマンド受信時：
   - バッファのポインタを 1 つ戻す。
   - メモリ差分（Undo Diff）を仮想 64KB メモリに逆書き込みする。
   - Verilog RTL コアの復元用ポート（`probe_restore_*`）へ前状態のレジスタ値を注入し、内部フリップフロップを過去の状態に同期させる。
   - 復元後のテレメトリを即座に UI に送出する。

---

## 5. 機械可読インテント記法 (Machine-Readable Intent Tags)

CIP の規範に基づき、すべてのソースコード（Verilog, C++, React）の主要関数・モジュールには、以下の機械可読インテントタグを義務付ける：

- `// @intent:responsibility <責務の説明>`: そのモジュールが何を担い、何を担わないか。
- `// @intent:state-machine <状態遷移の説明>`: FSM の設計意図と例外処理。
- `// @intent:bus-glow <信号プローブの意図>`: UI 光彩エフェクト用にどの信号をどう公開しているか。
- `// @intent:undo-snapshot <巻き戻し境界>`: スナップショットの取得契機と復元保証。

---

## 6. アーキテクチャ決定記録 (Architecture Decision Records - ADR)

### ADR #001: クリーンルーム Verilog RTL による Z80 段階的自作
- **Status:** 承認済 (Accepted)
- **Context:** T80 (LGPL) や A-Z80 (GPL) などの既存コア流用はライセンス汚染リスクがあり、また内部信号抽出が極めて困難である。
- **Decision:** 純粋な Verilog-2001 によるクリーンルーム自作を採用。主要命令（NOP, LD, ALU, Branch, Stack, I/O）から段階的に実装し、100% MIT ライセンスを維持する。

### ADR #002: 不変リングバッファによる決定論的タイムトラベル
- **Status:** 承認済 (Accepted)
- **Context:** 実機 FPGA の最大弱点である「行き過ぎたデバッグのやり直し不可」を克服する。
- **Decision:** C++ デーモン側にスナップショット履歴リングバッファを設け、メモリ Undo 差分とレジスタ直接注入による完全なタイムトラベルを実現する。

### ADR #003: F-BB 本体リポジトリへの侵入ゼロ（完全外部シナリオ起動）
- **Status:** 承認済 (Accepted)
- **Context:** F-BB のリポジトリを一切汚さず、PPA/DPPA のサードパーティ開発者体験を実証する。
- **Decision:** シナリオ（`config.dts`, `run.sh`）は `RetroCoreTracer-FBB/scenario/` に自己完結させ、`./start_lab.sh <absolute_path>` で直接起動する。
