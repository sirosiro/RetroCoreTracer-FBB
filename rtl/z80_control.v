// @intent:responsibility 命令フェッチ、デコード、マシンサイクル制御 FSM (Phase 3: 16-bit 演算・スタック・サブルーチン・分岐網羅)
// @intent:state-machine M1..M5 サイクル制御、スタック PUSH/POP/CALL/RET、条件ジャンプ
// @intent:timing-precision 組合せデータパス制御（Zero Pipeline Lag）と正確な T-state バス駆動

module z80_control (
    input  wire        clk,
    input  wire        rst_n,

    // バス制御ピン
    output reg  [15:0] bus_addr,
    input  wire [7:0]  bus_din,
    output reg  [7:0]  bus_dout,
    output reg         bus_mreq_n,
    output reg         bus_iorq_n,
    output reg         bus_rd_n,
    output reg         bus_wr_n,
    output reg         bus_m1_n,

    // PC 制御
    input  wire [15:0] pc_in,
    output reg         pc_inc,
    output reg         pc_load,
    output reg  [15:0] pc_new,

    // レジスタ制御
    output reg  [2:0]  reg_src_sel,
    input  wire [7:0]  reg_src_data,
    output reg         reg_wr_en,
    output reg  [2:0]  reg_dst_sel,
    output reg  [7:0]  reg_wr_data,

    // 16-bit ペア制御
    output reg         pair_wr_en,
    output reg  [1:0]  pair_sel,
    output reg  [15:0] pair_wr_data,
    output reg         pair_is_af,

    // SP 直接制御
    output reg         sp_wr_en,
    output reg  [15:0] sp_new,

    // レジスタ直結参照（パイプライン即時伝播）
    input  wire [7:0]  acc_out,
    input  wire [15:0] hl_out,
    input  wire [15:0] bc_out,
    input  wire [15:0] de_out,
    input  wire [15:0] sp_out,
    input  wire [15:0] ix_out,
    input  wire [15:0] iy_out,
    output reg  [1:0]  index_mode, // 0: none, 1: IX, 2: IY
    input  wire [7:0]  flags_in_wire,

    // 交換命令
    output reg         ex_de_hl,
    output reg         ex_af_af_alt,
    output reg         exx,

    // 8-bit ALU 制御
    output reg  [5:0]  alu_op,
    output reg  [7:0]  alu_in_a,
    output reg  [7:0]  alu_in_b,
    input  wire [7:0]  alu_out_res,
    output reg         flags_wr_en,

    // 16-bit ALU 制御
    output reg  [15:0] alu_in_a16,
    output reg  [15:0] alu_in_b16,
    input  wire [15:0] alu_out_res16,

    // Phase 5 ブロック転送・検索制御
    output reg         block_trans_en,
    output reg         block_trans_dec,
    output reg         block_search_en,
    output reg         block_search_dec,

    // 特殊レジスタ制御 (I, R, IFF, IM)
    output reg         i_wr_en,
    output reg  [7:0]  i_wr_data,
    input  wire [7:0]  i_out,

    output reg         r_wr_en,
    output reg  [7:0]  r_wr_data,
    input  wire [7:0]  r_out,

    output reg         im_wr_en,
    output reg  [1:0]  im_wr_data,

    output reg         iff_wr_en,
    output reg         iff1_val,
    output reg         iff2_val,
    input  wire        iff2_out,

    // タイムトラベル（Undo 復元）
    input  wire        restore_en,
    input  wire        restore_halted,

    // 現在の命令情報 (UI プローブ用)
    output reg  [7:0]  probe_opcode,
    output reg         probe_bus_active,
    output wire        probe_instr_boundary,
    output wire [2:0]  probe_prefix,
    output wire [6:0]  probe_state,
    output reg         halted
);

    // FSM ステート定義
    localparam S_M1_T1           = 7'd0;
    localparam S_M1_T2           = 7'd1;
    localparam S_M1_T3           = 7'd2;
    localparam S_M1_T4           = 7'd3;
    localparam S_M2_T1_RD        = 7'd4;
    localparam S_M2_T2_RD        = 7'd5;
    localparam S_M3_T1_RD        = 7'd6;
    localparam S_MEM_RD_T1       = 7'd7;
    localparam S_MEM_WR_PREP     = 7'd8;
    localparam S_MEM_WR_T1       = 7'd9;
    localparam S_MEM_RMW_RD      = 7'd10;
    localparam S_MEM_RMW_WR      = 7'd11;
    localparam S_MEM_ALU_RD      = 7'd12;
    localparam S_MEM_ALU_EXEC    = 7'd13;
    localparam S_ALU_IMM_EXEC    = 7'd14;
    localparam S_HALT            = 7'd15;

    // Phase 3 追加ステート
    localparam S_PUSH_HI         = 7'd16;
    localparam S_PUSH_LO         = 7'd17;
    localparam S_POP_HI          = 7'd18;
    localparam S_POP_EXEC        = 7'd19;
    localparam S_CALL_FETCH_HI   = 7'd20;
    localparam S_CALL_PUSH_HI    = 7'd21;
    localparam S_CALL_PUSH_LO    = 7'd22;
    localparam S_RET_RD_HI       = 7'd23;
    localparam S_RET_EXEC        = 7'd24;
    localparam S_RST_PUSH_HI     = 7'd25;
    localparam S_RST_PUSH_LO     = 7'd26;
    localparam S_LD_NN_HL_WR_HI  = 7'd27;
    localparam S_LD_HL_NN_RD_HI  = 7'd28;
    localparam S_LD_HL_NN_EXEC   = 7'd29;
    localparam S_EX_SP_HL_RD_HI  = 7'd30;
    localparam S_EX_SP_HL_WR_LO  = 7'd31;
    localparam S_EX_SP_HL_WR_HI  = 7'd32;

    // Phase 4 追加ステート (CB プレフィックス全 256 命令)
    localparam S_CB_FETCH_T1     = 7'd33;
    localparam S_CB_FETCH_T2     = 7'd34;
    localparam S_CB_EXEC         = 7'd35;
    localparam S_CB_MEM_RD_T1    = 7'd36;
    localparam S_CB_MEM_RD_T2    = 7'd37;
    localparam S_CB_MEM_BIT_EX   = 7'd38;
    localparam S_CB_MEM_WR_T1    = 7'd39;
    localparam S_CB_MEM_WR_T2    = 7'd40;

    // Phase 5 追加ステート (ED プレフィックス全拡張命令 & I/O)
    localparam S_ED_FETCH_T2     = 7'd41;
    localparam S_ED_EXEC         = 7'd42;
    localparam S_ED_NN_RD_LO     = 7'd43;
    localparam S_ED_NN_RD_HI     = 7'd44;
    localparam S_ED_NN_WR_HI     = 7'd45;
    localparam S_ED_NN_EXEC      = 7'd46;
    localparam S_ED_LDIR_RD      = 7'd47;
    localparam S_ED_LDIR_WR      = 7'd48;
    localparam S_ED_LDIR_EXEC    = 7'd49;
    localparam S_ED_CPIR_RD      = 7'd50;
    localparam S_ED_CPIR_EXEC    = 7'd51;
    localparam S_ED_RRD_RD       = 7'd52;
    localparam S_ED_RRD_WR       = 7'd53;
    localparam S_ED_RRD_EXEC     = 7'd54;
    localparam S_IO_RD_T1        = 7'd55;
    localparam S_IO_RD_T2        = 7'd56;
    localparam S_IO_WR_T1        = 7'd57;
    localparam S_IO_WR_T2        = 7'd58;

    // Phase 6 追加ステート (DD / FD / DD CB / FD CB インデックス命令)
    localparam S_IDX_DISP_FETCH  = 7'd59;
    localparam S_IDX_IMM_N       = 7'd60;
    localparam S_IDX_MEM_RD      = 7'd61;
    localparam S_IDX_ALU_RD      = 7'd62;
    localparam S_IDX_RMW_RD      = 7'd63;
    localparam S_IDX_RMW_WR      = 7'd64;
    localparam S_IDX_CB_DISP     = 7'd65;
    localparam S_IDX_CB_OP       = 7'd66;
    localparam S_IDX_CB_MEM      = 7'd67;
    localparam S_IDX_CB_WR       = 7'd68;

    reg [6:0]  state;
    reg [7:0]  opcode;
    reg [7:0]  imm_low;
    reg [7:0]  mem_data_buf;
    reg [15:0] target_addr;
    reg [15:0] temp16;
    reg [2:0]  reg_dst_sel_buf;

    reg [2:0]  probe_prefix_latch;
    assign probe_prefix = probe_prefix_latch;
    reg        prefix_cb;
    reg [7:0]  cb_opcode;
    reg        prefix_ed;
    reg [7:0]  ed_opcode;
    reg        prefix_dd;
    reg        prefix_fd;

    assign probe_instr_boundary = (state == S_M1_T1 && !prefix_cb && !prefix_ed && !prefix_dd && !prefix_fd);
    assign probe_state          = state;

    /* verilator lint_off UNUSED */
    // 条件判定関数 (Z80 フラグ仕様: NZ, Z, NC, C, PO, PE, P, M)
    function eval_cc;
        input [2:0] cc;
        input [7:0] f;
        begin
            case (cc)
                3'b000: eval_cc = ~f[6]; // NZ (Zero == 0)
                3'b001: eval_cc =  f[6]; // Z  (Zero == 1)
                3'b010: eval_cc = ~f[0]; // NC (Carry == 0)
                3'b011: eval_cc =  f[0]; // C  (Carry == 1)
                3'b100: eval_cc = ~f[2]; // PO (PV == 0)
                3'b101: eval_cc =  f[2]; // PE (PV == 1)
                3'b110: eval_cc = ~f[7]; // P  (Sign == 0)
                3'b111: eval_cc =  f[7]; // M  (Sign == 1)
            endcase
        end
    endfunction

    // 16-bit レジスタペア読出セレクタ
    function [15:0] get_pair16;
        input [1:0]  sel;
        input [15:0] r_bc, r_de, r_hl, r_sp;
        begin
            case (sel)
                2'd0: get_pair16 = r_bc;
                2'd1: get_pair16 = r_de;
                2'd2: get_pair16 = r_hl;
                2'd3: get_pair16 = r_sp;
            endcase
        end
    endfunction
    /* verilator lint_on UNUSED */

    // -------------------------------------------------------------
    // 組合せデータパス & レジスタ制御デコーダ (Zero Pipeline Lag)
    // -------------------------------------------------------------
    always @(*) begin
        // デフォルト: 非アクティブ
        pc_inc       = 1'b0;
        pc_load      = 1'b0;
        pc_new       = 16'h0000;
        reg_wr_en    = 1'b0;
        reg_dst_sel  = 3'd0;
        reg_wr_data  = 8'h00;
        pair_wr_en   = 1'b0;
        pair_sel     = 2'd0;
        pair_wr_data = 16'h0000;
        pair_is_af   = 1'b0;
        sp_wr_en     = 1'b0;
        sp_new       = 16'h0000;
        flags_wr_en  = 1'b0;
        ex_de_hl     = 1'b0;
        ex_af_af_alt = 1'b0;
        exx          = 1'b0;

        // Phase 5 デフォルト
        block_trans_en   = 1'b0;
        block_trans_dec  = 1'b0;
        block_search_en  = 1'b0;
        block_search_dec = 1'b0;
        i_wr_en          = 1'b0;
        i_wr_data        = 8'h00;
        r_wr_en          = 1'b0;
        r_wr_data        = 8'h00;
        im_wr_en         = 1'b0;
        im_wr_data       = 2'b00;
        iff_wr_en        = 1'b0;
        iff1_val         = 1'b0;
        iff2_val         = 1'b0;

        // Phase 6 デフォルト
        index_mode       = (prefix_dd ? 2'd1 : prefix_fd ? 2'd2 : 2'd0);

        // ソースレジスタセレクタ
        if (opcode[7:6] == 2'b01 || opcode[7:6] == 2'b10) begin
            reg_src_sel = opcode[2:0];
        end else begin
            reg_src_sel = opcode[5:3];
        end

        // ALU オペランド & 演算選択
        alu_in_a   = acc_out;
        alu_in_b   = reg_src_data;
        alu_in_a16 = (prefix_dd ? ix_out : prefix_fd ? iy_out : hl_out);
        alu_in_b16 = bc_out;
        alu_op     = 6'd0;

        case (state)
            S_M1_T1: begin
                pc_inc = 1'b1; // M1 フェッチ開始時に PC++ を予約
            end

            S_M1_T3: begin
                case (opcode)
                    8'hEB: ex_de_hl = 1'b1;     // EX DE, HL
                    8'h08: ex_af_af_alt = 1'b1; // EX AF, AF'
                    8'hD9: exx = 1'b1;          // EXX
                    8'hF9: begin                // LD SP, HL / IX / IY
                        sp_wr_en = 1'b1;
                        sp_new = (prefix_dd ? ix_out : prefix_fd ? iy_out : hl_out);
                    end
                    8'hE9: begin                // JP (HL) / JP (IX) / JP (IY)
                        pc_load = 1'b1;
                        pc_new = (prefix_dd ? ix_out : prefix_fd ? iy_out : hl_out);
                    end
                    8'hF3: begin                // DI
                        iff_wr_en = 1'b1;
                        iff1_val = 1'b0;
                        iff2_val = 1'b0;
                    end
                    8'hFB: begin                // EI
                        iff_wr_en = 1'b1;
                        iff1_val = 1'b1;
                        iff2_val = 1'b1;
                    end
                    default: ;
                endcase
            end

            S_M1_T4: begin
                // 単一サイクル実行コミット
                if (opcode[7:6] == 2'b01) begin // LD r, r'
                    reg_wr_en = 1'b1;
                    reg_dst_sel = opcode[5:3];
                    reg_wr_data = reg_src_data;
                end else if (opcode[7:6] == 2'b00) begin
                    if (opcode[3:0] == 4'b1001) begin // ADD HL, ss / ADD IX, ss / ADD IY, ss
                        alu_in_a16 = (prefix_dd ? ix_out : prefix_fd ? iy_out : hl_out);
                        alu_in_b16 = ((prefix_dd || prefix_fd) && opcode[5:4] == 2'd2) ?
                                     (prefix_dd ? ix_out : iy_out) :
                                     get_pair16(opcode[5:4], bc_out, de_out, hl_out, sp_out);
                        alu_op     = 6'd19; // ADD16
                        pair_wr_en = 1'b1;
                        pair_sel = 2'd2; // HL / IX / IY
                        pair_wr_data = alu_out_res16;
                        flags_wr_en = 1'b1;
                    end else if (opcode[3:0] == 4'b0011) begin // INC ss
                        if (opcode[5:4] == 2'd3) begin
                            sp_wr_en = 1'b1;
                            sp_new = sp_out + 16'd1;
                        end else begin
                            pair_wr_en = 1'b1;
                            pair_sel = opcode[5:4];
                            pair_wr_data = ((prefix_dd || prefix_fd) && opcode[5:4] == 2'd2) ?
                                           ((prefix_dd ? ix_out : iy_out) + 16'd1) :
                                           (get_pair16(opcode[5:4], bc_out, de_out, hl_out, sp_out) + 16'd1);
                        end
                    end else if (opcode[3:0] == 4'b1011) begin // DEC ss
                        if (opcode[5:4] == 2'd3) begin
                            sp_wr_en = 1'b1;
                            sp_new = sp_out - 16'd1;
                        end else begin
                            pair_wr_en = 1'b1;
                            pair_sel = opcode[5:4];
                            pair_wr_data = ((prefix_dd || prefix_fd) && opcode[5:4] == 2'd2) ?
                                           ((prefix_dd ? ix_out : iy_out) - 16'd1) :
                                           (get_pair16(opcode[5:4], bc_out, de_out, hl_out, sp_out) - 16'd1);
                        end
                    end else if (opcode[2:0] == 3'b100) begin // INC r
                        alu_in_a = reg_src_data;
                        alu_op   = 6'd8; // INC
                        reg_wr_en = 1'b1;
                        reg_dst_sel = opcode[5:3];
                        reg_wr_data = alu_out_res;
                        flags_wr_en = 1'b1;
                    end else if (opcode[2:0] == 3'b101) begin // DEC r
                        alu_in_a = reg_src_data;
                        alu_op   = 6'd9; // DEC
                        reg_wr_en = 1'b1;
                        reg_dst_sel = opcode[5:3];
                        reg_wr_data = alu_out_res;
                        flags_wr_en = 1'b1;
                    end else if (opcode == 8'h37) begin // SCF
                        alu_in_a = acc_out;
                        alu_op   = 6'd14;
                        flags_wr_en = 1'b1;
                    end else if (opcode == 8'h3F) begin // CCF
                        alu_in_a = acc_out;
                        alu_op   = 6'd13;
                        flags_wr_en = 1'b1;
                    end else begin // DAA, CPL, RLCA, RRCA, RLA, RRA
                        alu_in_a = acc_out;
                        case (opcode)
                            8'h27: alu_op = 6'd10; // DAA
                            8'h2F: alu_op = 6'd11; // CPL
                            8'h07: alu_op = 6'd15; // RLCA
                            8'h0F: alu_op = 6'd16; // RRCA
                            8'h17: alu_op = 6'd17; // RLA
                            8'h1F: alu_op = 6'd18; // RRA
                            default: alu_op = 6'd0;
                        endcase
                        reg_wr_en = 1'b1;
                        reg_dst_sel = 3'd7; // A
                        reg_wr_data = alu_out_res;
                        flags_wr_en = 1'b1;
                    end
                end else if (opcode[7:6] == 2'b10) begin // ALU A, r
                    alu_in_a = acc_out;
                    alu_in_b = reg_src_data;
                    case (opcode[5:3])
                        3'b000: alu_op = 6'd0; // ADD
                        3'b001: alu_op = 6'd1; // ADC
                        3'b010: alu_op = 6'd2; // SUB
                        3'b011: alu_op = 6'd3; // SBC
                        3'b100: alu_op = 6'd4; // AND
                        3'b101: alu_op = 6'd5; // XOR
                        3'b110: alu_op = 6'd6; // OR
                        3'b111: alu_op = 6'd7; // CP
                    endcase
                    if (opcode[5:3] != 3'b111) begin
                        reg_wr_en = 1'b1;
                        reg_dst_sel = 3'd7; // A
                        reg_wr_data = alu_out_res;
                    end
                    flags_wr_en = 1'b1;
                end
            end

            S_M2_T1_RD: begin
                pc_inc = 1'b1; // 2バイト目フェッチ完了に伴い PC++
            end

            S_M2_T2_RD: begin
                if (opcode == 8'h10) begin // DJNZ e
                    reg_wr_en = 1'b1;
                    reg_dst_sel = 3'd0; // B
                    reg_wr_data = bc_out[15:8] - 8'd1;
                    if ((bc_out[15:8] - 8'd1) != 8'd0) begin
                        pc_load = 1'b1;
                        pc_new = pc_in + {{8{imm_low[7]}}, imm_low};
                    end
                end else if (opcode == 8'h18) begin // JR e
                    pc_load = 1'b1;
                    pc_new = pc_in + {{8{imm_low[7]}}, imm_low};
                end else if (opcode[7:6] == 2'b00 && opcode[2:0] == 3'b000) begin // JR cc, e
                    if (eval_cc({1'b0, opcode[4:3]}, flags_in_wire)) begin
                        pc_load = 1'b1;
                        pc_new = pc_in + {{8{imm_low[7]}}, imm_low};
                    end
                end else if (opcode[7:6] == 2'b00 && opcode[2:0] == 3'b110 && opcode != 8'h36) begin // LD r, n
                    reg_wr_en = 1'b1;
                    reg_dst_sel = opcode[5:3];
                    reg_wr_data = imm_low;
                end
            end

            S_ALU_IMM_EXEC: begin // ALU A, n
                alu_in_a = acc_out;
                alu_in_b = imm_low;
                case (opcode[5:3])
                    3'b000: alu_op = 6'd0; // ADD
                    3'b001: alu_op = 6'd1; // ADC
                    3'b010: alu_op = 6'd2; // SUB
                    3'b011: alu_op = 6'd3; // SBC
                    3'b100: alu_op = 6'd4; // AND
                    3'b101: alu_op = 6'd5; // XOR
                    3'b110: alu_op = 6'd6; // OR
                    3'b111: alu_op = 6'd7; // CP
                endcase
                if (opcode[5:3] != 3'b111) begin
                    reg_wr_en = 1'b1;
                    reg_dst_sel = 3'd7; // A
                    reg_wr_data = alu_out_res;
                end
                flags_wr_en = 1'b1;
            end

            S_M3_T1_RD: begin
                pc_inc = 1'b1; // 3バイト目フェッチ完了に伴い PC++
                if (opcode == 8'hC3) begin // JP nn
                    pc_load = 1'b1;
                    pc_new = {bus_din, imm_low};
                end else if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b010) begin // JP cc, nn
                    if (eval_cc(opcode[5:3], flags_in_wire)) begin
                        pc_load = 1'b1;
                        pc_new = {bus_din, imm_low};
                    end
                end else if (opcode[7:6] == 2'b00 && opcode[3:0] == 4'b0001) begin // LD dd, nn
                    if (opcode[5:4] == 2'd3) begin
                        sp_wr_en = 1'b1;
                        sp_new = {bus_din, imm_low};
                    end else begin
                        pair_wr_en = 1'b1;
                        pair_sel = opcode[5:4];
                        pair_wr_data = {bus_din, imm_low};
                    end
                end
            end

            S_MEM_RD_T1: begin // LD r, (HL) / LD A, (BC/DE/nn)
                reg_wr_en = 1'b1;
                reg_dst_sel = reg_dst_sel_buf;
                reg_wr_data = bus_din;
            end

            S_MEM_RMW_WR: begin // INC/DEC (HL)
                alu_in_a = mem_data_buf;
                alu_op   = (opcode == 8'h34) ? 6'd8 : 6'd9;
                flags_wr_en = 1'b1;
            end

            S_MEM_ALU_EXEC: begin // ALU A, (HL)
                alu_in_a = acc_out;
                alu_in_b = mem_data_buf;
                case (opcode[5:3])
                    3'b000: alu_op = 6'd0; // ADD
                    3'b001: alu_op = 6'd1; // ADC
                    3'b010: alu_op = 6'd2; // SUB
                    3'b011: alu_op = 6'd3; // SBC
                    3'b100: alu_op = 6'd4; // AND
                    3'b101: alu_op = 6'd5; // XOR
                    3'b110: alu_op = 6'd6; // OR
                    3'b111: alu_op = 6'd7; // CP
                endcase
                if (opcode[5:3] != 3'b111) begin
                    reg_wr_en = 1'b1;
                    reg_dst_sel = 3'd7; // A
                    reg_wr_data = alu_out_res;
                end
                flags_wr_en = 1'b1;
            end

            S_PUSH_LO: begin // PUSH qq
                sp_wr_en = 1'b1;
                sp_new = sp_out - 16'd2;
            end

            S_POP_EXEC: begin // POP qq
                sp_wr_en = 1'b1;
                sp_new = sp_out + 16'd2;
                if (opcode == 8'hF1) begin
                    pair_wr_en = 1'b1;
                    pair_is_af = 1'b1;
                    pair_wr_data = {bus_din, mem_data_buf};
                end else begin
                    pair_wr_en = 1'b1;
                    pair_sel = opcode[5:4];
                    pair_wr_data = {bus_din, mem_data_buf};
                end
            end

            S_CALL_FETCH_HI: begin
                pc_inc = 1'b1; // リターンアドレス (PC+3) へ進む
            end

            S_CALL_PUSH_LO: begin
                sp_wr_en = 1'b1;
                sp_new = sp_out - 16'd2;
                pc_load = 1'b1;
                pc_new = target_addr;
            end

            S_RET_EXEC: begin
                pc_load = 1'b1;
                pc_new = {bus_din, mem_data_buf};
                sp_wr_en = 1'b1;
                sp_new = sp_out + 16'd2;
            end

            S_RST_PUSH_LO: begin
                sp_wr_en = 1'b1;
                sp_new = sp_out - 16'd2;
                pc_load = 1'b1;
                pc_new = {10'd0, opcode[5:3], 3'b000};
            end

            S_LD_HL_NN_EXEC: begin // LD HL, (nn) or LD dd, (nn) コミット
                pair_wr_en = 1'b1;
                pair_sel = prefix_ed ? ed_opcode[5:4] : 2'd2; // dd or HL
                pair_wr_data = {bus_din, mem_data_buf};
            end

            S_MEM_WR_T1: begin
                if (opcode == 8'hE3) begin // EX (SP), HL コミット
                    pair_wr_en = 1'b1;
                    pair_sel = 2'd2; // HL
                    pair_wr_data = temp16;
                end
            end

            // Phase 4: CB プレフィックス組合せ制御
            S_CB_FETCH_T2: begin
                pc_inc = 1'b1; // CB 命令の第2バイトフェッチ時に PC++
            end

            S_CB_EXEC: begin // レジスタ CB 命令コミット
                reg_src_sel = cb_opcode[2:0];
                alu_in_a = (cb_opcode[2:0] == 3'd7) ? acc_out : reg_src_data;
                alu_in_b = {5'd0, cb_opcode[5:3]};

                if (cb_opcode[7:6] == 2'b00) begin // シフト / ローテート
                    alu_op = 6'd20 + {3'd0, cb_opcode[5:3]};
                    reg_wr_en = 1'b1;
                    reg_dst_sel = cb_opcode[2:0];
                    reg_wr_data = alu_out_res;
                    flags_wr_en = 1'b1;
                end else if (cb_opcode[7:6] == 2'b01) begin // BIT b, r
                    alu_op = 6'd28;
                    flags_wr_en = 1'b1;
                end else if (cb_opcode[7:6] == 2'b10) begin // RES b, r
                    alu_op = 6'd29;
                    reg_wr_en = 1'b1;
                    reg_dst_sel = cb_opcode[2:0];
                    reg_wr_data = alu_out_res;
                end else begin // SET b, r
                    alu_op = 6'd30;
                    reg_wr_en = 1'b1;
                    reg_dst_sel = cb_opcode[2:0];
                    reg_wr_data = alu_out_res;
                end
            end

            S_CB_MEM_BIT_EX: begin // BIT b, (HL) コミット
                alu_in_a = mem_data_buf;
                alu_in_b = {5'd0, cb_opcode[5:3]};
                alu_op   = 6'd28; // BIT
                flags_wr_en = 1'b1;
            end

            S_CB_MEM_WR_T1: begin // シフト/ローテート/RES/SET (HL) コミット
                alu_in_a = mem_data_buf;
                alu_in_b = {5'd0, cb_opcode[5:3]};
                if (cb_opcode[7:6] == 2'b00) begin
                    alu_op = 6'd20 + {3'd0, cb_opcode[5:3]};
                    flags_wr_en = 1'b1;
                end else if (cb_opcode[7:6] == 2'b10) begin
                    alu_op = 6'd29;
                end else begin
                    alu_op = 6'd30;
                end
            end

            // Phase 5: ED プレフィックス組合せ制御
            S_ED_FETCH_T2: begin
                pc_inc = 1'b1; // ED 命令第2バイトフェッチ時に PC++
            end

            S_ED_NN_RD_LO: begin
                pc_inc = 1'b1; // 16-bit アドレス下位バイトフェッチ時に PC++
            end

            S_ED_NN_RD_HI: begin
                pc_inc = 1'b1; // 16-bit アドレス上位バイトフェッチ時に PC++
            end

            S_IO_RD_T1: begin
                pc_inc = 1'b1; // IN A, (n) ポート番号フェッチ時に PC++
            end

            S_IO_WR_T1: begin
                pc_inc = 1'b1; // OUT (n), A ポート番号フェッチ時に PC++
            end

            S_ED_EXEC: begin
                case (ed_opcode)
                    // NEG (ED 44 / 4C / 54 / 5C / 64 / 6C / 74 / 7C)
                    8'h44, 8'h4C, 8'h54, 8'h5C, 8'h64, 8'h6C, 8'h74, 8'h7C: begin
                        alu_op = 6'd12; // NEG
                        alu_in_a = acc_out;
                        reg_wr_en = 1'b1;
                        reg_dst_sel = 3'd7; // A
                        reg_wr_data = alu_out_res;
                        flags_wr_en = 1'b1;
                    end

                    // IM 0/1/2 (ED 46, 56, 5E)
                    8'h46: begin im_wr_en = 1'b1; im_wr_data = 2'b00; end
                    8'h56: begin im_wr_en = 1'b1; im_wr_data = 2'b01; end
                    8'h5E: begin im_wr_en = 1'b1; im_wr_data = 2'b10; end

                    // 特殊レジスタ転送
                    8'h47: begin i_wr_en = 1'b1; i_wr_data = acc_out; end // LD I, A
                    8'h4F: begin r_wr_en = 1'b1; r_wr_data = acc_out; end // LD R, A
                    8'h57: begin // LD A, I
                        reg_wr_en = 1'b1; reg_dst_sel = 3'd7; reg_wr_data = i_out;
                        alu_op = 6'd36; // LDA_I_FLAGS
                        alu_in_a = i_out;
                        alu_in_b = {7'd0, iff2_out};
                        flags_wr_en = 1'b1;
                    end
                    8'h5F: begin // LD A, R
                        reg_wr_en = 1'b1; reg_dst_sel = 3'd7; reg_wr_data = r_out;
                        alu_op = 6'd36; // LDA_I_FLAGS
                        alu_in_a = r_out;
                        alu_in_b = {7'd0, iff2_out};
                        flags_wr_en = 1'b1;
                    end

                    // 16-bit 算術演算 (ADC HL, ss / SBC HL, ss)
                    8'h4A, 8'h5A, 8'h6A, 8'h7A: begin // ADC HL, ss
                        alu_in_a16 = hl_out;
                        alu_in_b16 = get_pair16(ed_opcode[5:4], bc_out, de_out, hl_out, sp_out);
                        alu_op = 6'd31; // ADC16
                        pair_wr_en = 1'b1;
                        pair_sel = 2'd2; // HL
                        pair_wr_data = alu_out_res16;
                        flags_wr_en = 1'b1;
                    end
                    8'h42, 8'h52, 8'h62, 8'h72: begin // SBC HL, ss
                        alu_in_a16 = hl_out;
                        alu_in_b16 = get_pair16(ed_opcode[5:4], bc_out, de_out, hl_out, sp_out);
                        alu_op = 6'd32; // SBC16
                        pair_wr_en = 1'b1;
                        pair_sel = 2'd2; // HL
                        pair_wr_data = alu_out_res16;
                        flags_wr_en = 1'b1;
                    end

                    // RETI / RETN (ED 4D / 45)
                    8'h4D, 8'h45: begin
                        iff_wr_en = 1'b1;
                        iff1_val = iff2_out;
                        iff2_val = iff2_out;
                    end

                    default: ;
                endcase
            end

            S_ED_LDIR_EXEC: begin
                block_trans_en = 1'b1;
                block_trans_dec = (ed_opcode == 8'hA8 || ed_opcode == 8'hB8);
                alu_op = 6'd33; // LDIR_FLAGS
                alu_in_b16 = bc_out;
                flags_wr_en = 1'b1;
                if ((ed_opcode == 8'hB0 || ed_opcode == 8'hB8) && (bc_out != 16'd1)) begin
                    pc_load = 1'b1;
                    pc_new = pc_in - 16'd2;
                end
            end

            S_ED_CPIR_EXEC: begin
                block_search_en = 1'b1;
                block_search_dec = (ed_opcode == 8'hA9 || ed_opcode == 8'hB9);
                alu_op = 6'd34; // CPIR_FLAGS
                alu_in_a = acc_out;
                alu_in_b = mem_data_buf;
                alu_in_b16 = bc_out;
                flags_wr_en = 1'b1;
                if ((ed_opcode == 8'hB1 || ed_opcode == 8'hB9) && (bc_out != 16'd1) && (acc_out != mem_data_buf)) begin
                    pc_load = 1'b1;
                    pc_new = pc_in - 16'd2;
                end
            end

            S_ED_RRD_EXEC: begin
                reg_wr_en = 1'b1;
                reg_dst_sel = 3'd7; // A
                if (ed_opcode == 8'h6F) begin // RLD
                    reg_wr_data = {acc_out[7:4], mem_data_buf[7:4]};
                    alu_in_a = {acc_out[7:4], mem_data_buf[7:4]};
                end else begin // RRD
                    reg_wr_data = {acc_out[7:4], mem_data_buf[3:0]};
                    alu_in_a = {acc_out[7:4], mem_data_buf[3:0]};
                end
                alu_op = 6'd37; // RRD_FLAGS
                flags_wr_en = 1'b1;
            end

            S_ED_NN_EXEC: begin // LD dd, (nn) コミット
                pair_wr_en = 1'b1;
                pair_sel = ed_opcode[5:4];
                pair_wr_data = {bus_din, mem_data_buf};
            end

            S_IO_RD_T2: begin // IN 命令コミット
                reg_wr_en = (opcode == 8'hDB) ? 1'b1 : (ed_opcode[5:3] != 3'd6);
                reg_dst_sel = (opcode == 8'hDB) ? 3'd7 : ed_opcode[5:3];
                reg_wr_data = bus_din;
                if (opcode != 8'hDB) begin // IN r, (C) sets flags
                    alu_op = 6'd35; // IN_FLAGS
                    alu_in_a = bus_din;
                    flags_wr_en = 1'b1;
                end
            end

            // Phase 6: インデックス (IX+d) / (IY+d) 組合せ制御
            S_IDX_DISP_FETCH: begin
                pc_inc = 1'b1; // ディスプレースメント d 読出時に PC++
            end

            S_IDX_IMM_N: begin
                pc_inc = 1'b1; // 即値 n 読出時に PC++
            end

            S_IDX_MEM_RD: begin // LD r, (IX+d) コミット
                reg_wr_en = 1'b1;
                reg_dst_sel = opcode[5:3];
                reg_wr_data = bus_din;
            end

            S_IDX_ALU_RD: begin // ALU A, (IX+d) コミット
                alu_in_a = acc_out;
                alu_in_b = bus_din;
                flags_wr_en = 1'b1;
                case (opcode[5:3])
                    3'd0: alu_op = 6'd0;  // ADD
                    3'd1: alu_op = 6'd1;  // ADC
                    3'd2: alu_op = 6'd2;  // SUB
                    3'd3: alu_op = 6'd3;  // SBC
                    3'd4: alu_op = 6'd4;  // AND
                    3'd5: alu_op = 6'd5;  // XOR
                    3'd6: alu_op = 6'd6;  // OR
                    3'd7: alu_op = 6'd7;  // CP
                endcase
                if (opcode[5:3] != 3'd7) begin
                    reg_wr_en = 1'b1;
                    reg_dst_sel = 3'd7; // A
                    reg_wr_data = alu_out_res;
                end
            end

            S_IDX_RMW_WR: begin // INC / DEC (IX+d) 演算 & フラグ計算
                alu_op = (opcode == 8'h34) ? 6'd8 : 6'd9;
                alu_in_a = mem_data_buf;
                flags_wr_en = 1'b1;
            end

            S_IDX_CB_DISP: begin
                pc_inc = 1'b1; // DD CB d op の d 読出時に PC++
            end

            S_IDX_CB_OP: begin
                pc_inc = 1'b1; // DD CB d op の op 読出時に PC++
            end

            S_IDX_CB_MEM: begin // BIT b, (IX+d) フラグ判定
                alu_in_a = bus_din;
                alu_in_b = {5'd0, cb_opcode[5:3]};
                if ((cb_opcode & 8'hC0) == 8'h40) begin
                    alu_op = 6'd28; // BIT
                    flags_wr_en = 1'b1;
                end
            end

            S_IDX_CB_WR: begin // RES / SET / Shift / Rotate 演算
                alu_in_a = mem_data_buf;
                alu_in_b = {5'd0, cb_opcode[5:3]};
                if ((cb_opcode & 8'hC0) == 8'h80) begin
                    alu_op = 6'd29; // RES
                end else if ((cb_opcode & 8'hC0) == 8'hC0) begin
                    alu_op = 6'd30; // SET
                end else begin
                    flags_wr_en = 1'b1;
                    case (cb_opcode[5:3])
                        3'd0: alu_op = 6'd20; // RLC
                        3'd1: alu_op = 6'd21; // RRC
                        3'd2: alu_op = 6'd22; // RL
                        3'd3: alu_op = 6'd23; // RR
                        3'd4: alu_op = 6'd24; // SLA
                        3'd5: alu_op = 6'd25; // SRA
                        3'd6: alu_op = 6'd26; // SLL
                        3'd7: alu_op = 6'd27; // SRL
                    endcase
                end
            end

            default: ;
        endcase
    end

    // -------------------------------------------------------------
    // シーケンシャル FSM & バス駆動制御
    // -------------------------------------------------------------
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state <= S_M1_T1;
            bus_addr <= 16'h0000;
            bus_dout <= 8'h00;
            bus_mreq_n <= 1'b1;
            bus_iorq_n <= 1'b1;
            bus_rd_n <= 1'b1;
            bus_wr_n <= 1'b1;
            bus_m1_n <= 1'b1;
            opcode <= 8'h00;
            imm_low <= 8'h00;
            mem_data_buf <= 8'h00;
            target_addr <= 16'h0000;
            temp16 <= 16'h0000;
            reg_dst_sel_buf <= 3'd0;
            prefix_cb <= 1'b0;
            probe_prefix_latch <= 3'd0;
            cb_opcode <= 8'h00;
            prefix_ed <= 1'b0;
            ed_opcode <= 8'h00;
            prefix_dd <= 1'b0;
            prefix_fd <= 1'b0;
            probe_opcode <= 8'h00;
            probe_bus_active <= 1'b0;
            halted <= 1'b0;
        end else if (restore_en) begin
            state <= S_M1_T1;
            bus_mreq_n <= 1'b1;
            bus_iorq_n <= 1'b1;
            bus_rd_n <= 1'b1;
            bus_wr_n <= 1'b1;
            bus_m1_n <= 1'b1;
            probe_bus_active <= 1'b0;
            prefix_cb <= 1'b0;
            probe_prefix_latch <= 3'd0;
            cb_opcode <= 8'h00;
            prefix_ed <= 1'b0;
            ed_opcode <= 8'h00;
            prefix_dd <= 1'b0;
            prefix_fd <= 1'b0;
            halted <= restore_halted;
        end else begin
            probe_bus_active <= 1'b0;

            case (state)
                S_M1_T1: begin
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_M1_T2;
                end

                S_M1_T2: begin
                    opcode <= bus_din;
                    probe_opcode <= bus_din;
                    if (!prefix_dd && !prefix_fd && !prefix_cb && !prefix_ed)
                        probe_prefix_latch <= 3'd0;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    bus_m1_n <= 1'b1;
                    state <= S_M1_T3;
                end

                S_M1_T3: begin
                    case (opcode)
                        8'h00: begin prefix_dd <= 1'b0; prefix_fd <= 1'b0; state <= S_M1_T1; end // NOP
                        8'h76: begin halted <= 1'b1; state <= S_HALT; end // HALT

                        // Phase 4: CB プレフィックス
                        8'hCB: begin
                            if (prefix_dd || prefix_fd) begin
                                probe_prefix_latch <= prefix_dd ? 3'd5 : 3'd6;
                                bus_addr <= pc_in;
                                bus_mreq_n <= 1'b0;
                                bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1;
                                state <= S_IDX_CB_DISP;
                            end else begin
                                prefix_cb <= 1'b1;
                                probe_prefix_latch <= 3'd1;
                                bus_addr <= pc_in;
                                bus_mreq_n <= 1'b0;
                                bus_rd_n <= 1'b0;
                                bus_m1_n <= 1'b0;
                                probe_bus_active <= 1'b1;
                                state <= S_CB_FETCH_T2;
                            end
                        end

                        // Phase 5: ED プレフィックス
                        8'hED: begin
                            prefix_ed <= 1'b1;
                            probe_prefix_latch <= 3'd2;
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            bus_m1_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_ED_FETCH_T2;
                        end

                        // Phase 6: DD プレフィックス (IX)
                        8'hDD: begin
                            prefix_dd <= 1'b1;
                            prefix_fd <= 1'b0;
                            probe_prefix_latch <= 3'd3;
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            bus_m1_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_M1_T1;
                        end

                        // Phase 6: FD プレフィックス (IY)
                        8'hFD: begin
                            prefix_dd <= 1'b0;
                            prefix_fd <= 1'b1;
                            probe_prefix_latch <= 3'd4;
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            bus_m1_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_M1_T1;
                        end

                        // Phase 5: I/O 命令 (IN A, (n) / OUT (n), A)
                        8'hDB: begin // IN A, (n)
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_IO_RD_T1;
                        end
                        8'hD3: begin // OUT (n), A
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_IO_WR_T1;
                        end

                        // DI / EI
                        8'hF3, 8'hFB: begin prefix_dd <= 1'b0; prefix_fd <= 1'b0; state <= S_M1_T1; end

                        // 交換命令
                        8'hEB, 8'h08, 8'hD9: begin prefix_dd <= 1'b0; prefix_fd <= 1'b0; state <= S_M1_T1; end // EX DE, HL / EX AF, AF' / EXX
                        8'hE3: begin // EX (SP), HL / EX (SP), IX / EX (SP), IY
                            bus_addr <= sp_out;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_EX_SP_HL_RD_HI;
                        end

                        // 特殊アキュムレータ / フラグ
                        8'h27, 8'h2F, 8'h37, 8'h3F, // DAA, CPL, SCF, CCF
                        8'h07, 8'h0F, 8'h17, 8'h1F: begin // RLCA, RRCA, RLA, RRA
                            state <= S_M1_T4;
                        end

                        // 16-bit 演算 (ADD HL/IX/IY, ss / INC ss / DEC ss)
                        8'h09, 8'h19, 8'h29, 8'h39, // ADD HL, ss
                        8'h03, 8'h13, 8'h23, 8'h33, // INC ss
                        8'h0B, 8'h1B, 8'h2B, 8'h3B: begin // DEC ss
                            state <= S_M1_T4;
                        end

                        // LD SP, HL / IX / IY
                        8'hF9: begin
                            prefix_dd <= 1'b0;
                            prefix_fd <= 1'b0;
                            state <= S_M1_T1;
                        end

                        // 8-bit メモリ間接ロード / ストア
                        8'h0A: begin // LD A, (BC)
                            bus_addr <= bc_out; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; reg_dst_sel_buf <= 3'd7; state <= S_MEM_RD_T1;
                        end
                        8'h1A: begin // LD A, (DE)
                            bus_addr <= de_out; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; reg_dst_sel_buf <= 3'd7; state <= S_MEM_RD_T1;
                        end
                        8'h02: begin // LD (BC), A
                            bus_addr <= bc_out; bus_dout <= acc_out; bus_mreq_n <= 1'b0; bus_wr_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_MEM_WR_T1;
                        end
                        8'h12: begin // LD (DE), A
                            bus_addr <= de_out; bus_dout <= acc_out; bus_mreq_n <= 1'b0; bus_wr_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_MEM_WR_T1;
                        end
                        8'h34, 8'h35: begin // INC/DEC (HL) / INC/DEC (IX+d) / (IY+d)
                            if (prefix_dd || prefix_fd) begin
                                bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1; state <= S_IDX_DISP_FETCH;
                            end else begin
                                bus_addr <= hl_out; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1; state <= S_MEM_RMW_RD;
                            end
                        end
                        8'h36: begin // LD (HL), n / LD (IX+d), n
                            bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= (prefix_dd || prefix_fd) ? S_IDX_DISP_FETCH : S_M2_T1_RD;
                        end
                        8'h32, 8'h3A, 8'h22, 8'h2A: begin // LD (nn),A / LD A,(nn) / LD (nn),HL / LD HL,(nn)
                            bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                        end

                        // 分岐命令
                        8'hC3: begin // JP nn
                            bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                        end
                        8'hE9: begin // JP (HL) / JP (IX) / JP (IY)
                            prefix_dd <= 1'b0;
                            prefix_fd <= 1'b0;
                            state <= S_M1_T1;
                        end
                        8'h18: begin // JR e
                            bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                        end
                        8'h20, 8'h28, 8'h30, 8'h38: begin // JR cc, e (NZ, Z, NC, C)
                            bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                        end
                        8'h10: begin // DJNZ e
                            bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                        end

                        // サブルーチン CALL / RET
                        8'hCD: begin // CALL nn
                            bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                        end
                        8'hC9: begin // RET
                            bus_addr <= sp_out; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_RET_RD_HI;
                        end

                        // スタック PUSH / POP
                        8'hC5, 8'hD5, 8'hE5, 8'hF5: begin // PUSH qq
                            if (opcode == 8'hF5) temp16 <= {acc_out, flags_in_wire};
                            else if ((prefix_dd || prefix_fd) && opcode == 8'hE5) temp16 <= prefix_dd ? ix_out : iy_out;
                            else temp16 <= get_pair16(opcode[5:4], bc_out, de_out, hl_out, sp_out);
                            state <= S_PUSH_HI;
                        end
                        8'hC1, 8'hD1, 8'hE1, 8'hF1: begin // POP qq
                            bus_addr <= sp_out; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1; state <= S_POP_HI;
                        end

                        default: begin
                            if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b010) begin // JP cc, nn
                                bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                            end else if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b100) begin // CALL cc, nn
                                bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                            end else if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b000) begin // RET cc
                                if (eval_cc(opcode[5:3], flags_in_wire)) begin
                                    bus_addr <= sp_out; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                    probe_bus_active <= 1'b1; state <= S_RET_RD_HI;
                                end else begin
                                    prefix_dd <= 1'b0;
                                    prefix_fd <= 1'b0;
                                    state <= S_M1_T1;
                                end
                            end else if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b111) begin // RST p
                                state <= S_RST_PUSH_HI;
                            end else if (opcode[7:6] == 2'b00 && opcode[3:0] == 4'b0001) begin // LD dd, nn
                                bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                            end else if (opcode[7:6] == 2'b01) begin
                                if (prefix_dd || prefix_fd) begin
                                    if (opcode[2:0] == 3'b110 || opcode[5:3] == 3'b110) begin // LD r, (IX+d) / LD (IX+d), r
                                        bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                        probe_bus_active <= 1'b1; state <= S_IDX_DISP_FETCH;
                                    end else begin // LD r, r' (IXH / IXL / IYH / IYL を含む)
                                        state <= S_M1_T4;
                                    end
                                end else begin
                                    if (opcode[2:0] == 3'b110) begin // LD r, (HL)
                                        reg_dst_sel_buf <= opcode[5:3]; bus_addr <= hl_out;
                                        bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0; probe_bus_active <= 1'b1;
                                        state <= S_MEM_RD_T1;
                                    end else if (opcode[5:3] == 3'b110) begin // LD (HL), r
                                        state <= S_MEM_WR_PREP;
                                    end else begin // LD r, r'
                                        state <= S_M1_T4;
                                    end
                                end
                            end else if (opcode[7:6] == 2'b00 && opcode[2:0] == 3'b110) begin // LD r, n
                                bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                            end else if (opcode[7:6] == 2'b00 && (opcode[2:0] == 3'b100 || opcode[2:0] == 3'b101)) begin // INC/DEC r
                                state <= S_M1_T4;
                            end else if (opcode[7:6] == 2'b10) begin
                                if (prefix_dd || prefix_fd) begin
                                    if (opcode[2:0] == 3'b110) begin // ALU A, (IX+d)
                                        bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                        probe_bus_active <= 1'b1; state <= S_IDX_DISP_FETCH;
                                    end else begin // ALU A, r (IXH / IXL / IYH / IYL を含む)
                                        state <= S_M1_T4;
                                    end
                                end else begin
                                    if (opcode[2:0] == 3'b110) begin // ALU A, (HL)
                                        bus_addr <= hl_out; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                        probe_bus_active <= 1'b1; state <= S_MEM_ALU_RD;
                                    end else begin // ALU A, r
                                        state <= S_M1_T4;
                                    end
                                end
                            end else if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b110) begin // ALU A, n
                                bus_addr <= pc_in; bus_mreq_n <= 1'b0; bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1; state <= S_M2_T1_RD;
                            end else begin
                                prefix_dd <= 1'b0;
                                prefix_fd <= 1'b0;
                                state <= S_M1_T1;
                            end
                        end
                    endcase
                end

                S_M1_T4: begin
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_MEM_RD_T1: begin
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_MEM_WR_PREP: begin
                    bus_addr <= hl_out;
                    bus_dout <= reg_src_data;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_MEM_WR_T1: begin
                    bus_wr_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_MEM_RMW_RD: begin
                    mem_data_buf <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_MEM_RMW_WR;
                end

                S_MEM_RMW_WR: begin
                    bus_addr <= hl_out;
                    bus_dout <= alu_out_res;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_MEM_ALU_RD: begin
                    mem_data_buf <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_MEM_ALU_EXEC;
                end

                S_MEM_ALU_EXEC: begin
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_M2_T1_RD: begin
                    imm_low <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_M2_T2_RD;
                end

                S_M2_T2_RD: begin
                    if (opcode == 8'h36) begin // LD (HL), n
                        bus_addr <= hl_out;
                        bus_dout <= imm_low;
                        bus_mreq_n <= 1'b0;
                        bus_wr_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_MEM_WR_T1;
                    end else if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b110) begin // ALU A, n
                        state <= S_ALU_IMM_EXEC;
                    end else if (opcode == 8'hCD || (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b100)) begin // CALL nn / CALL cc, nn
                        bus_addr <= pc_in;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_CALL_FETCH_HI;
                    end else if (opcode == 8'hC3 || (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b010) || // JP nn / JP cc, nn
                               (opcode[7:6] == 2'b00 && opcode[3:0] == 4'b0001) || // LD dd, nn
                               opcode == 8'h32 || opcode == 8'h3A || opcode == 8'h22 || opcode == 8'h2A) begin
                        bus_addr <= pc_in;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_M3_T1_RD;
                    end else begin
                        prefix_dd <= 1'b0;
                        prefix_fd <= 1'b0;
                        state <= S_M1_T1;
                    end
                end

                S_ALU_IMM_EXEC: begin
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_M3_T1_RD: begin
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    if (opcode == 8'h32) begin // LD (nn), A
                        bus_addr <= {bus_din, imm_low};
                        bus_dout <= acc_out;
                        bus_mreq_n <= 1'b0;
                        bus_wr_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_MEM_WR_T1;
                    end else if (opcode == 8'h3A) begin // LD A, (nn)
                        bus_addr <= {bus_din, imm_low};
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        reg_dst_sel_buf <= 3'd7; // A
                        state <= S_MEM_RD_T1;
                    end else if (opcode == 8'h22) begin // LD (nn), HL / LD (nn), IX / LD (nn), IY
                        target_addr <= {bus_din, imm_low};
                        bus_addr <= {bus_din, imm_low};
                        bus_dout <= (prefix_dd ? ix_out[7:0] : prefix_fd ? iy_out[7:0] : hl_out[7:0]);
                        bus_mreq_n <= 1'b0;
                        bus_wr_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_LD_NN_HL_WR_HI;
                    end else if (opcode == 8'h2A) begin // LD HL, (nn) / LD IX, (nn) / LD IY, (nn)
                        target_addr <= {bus_din, imm_low};
                        bus_addr <= {bus_din, imm_low};
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_LD_HL_NN_RD_HI;
                    end else begin
                        prefix_dd <= 1'b0;
                        prefix_fd <= 1'b0;
                        state <= S_M1_T1;
                    end
                end

                // --- Phase 3: スタック & サブルーチン制御 ---
                S_PUSH_HI: begin
                    bus_addr <= sp_out - 16'd1;
                    bus_dout <= temp16[15:8];
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_PUSH_LO;
                end

                S_PUSH_LO: begin
                    bus_addr <= sp_out - 16'd2;
                    bus_dout <= temp16[7:0];
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_POP_HI: begin
                    mem_data_buf <= bus_din; // low byte
                    bus_addr <= sp_out + 16'd1;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_POP_EXEC;
                end

                S_POP_EXEC: begin
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_CALL_FETCH_HI: begin
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    target_addr <= {bus_din, imm_low};
                    if (opcode == 8'hCD || eval_cc(opcode[5:3], flags_in_wire)) begin
                        state <= S_CALL_PUSH_HI;
                    end else begin
                        state <= S_M1_T1;
                    end
                end

                S_CALL_PUSH_HI: begin
                    bus_addr <= sp_out - 16'd1;
                    bus_dout <= pc_in[15:8];
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_CALL_PUSH_LO;
                end

                S_CALL_PUSH_LO: begin
                    bus_addr <= sp_out - 16'd2;
                    bus_dout <= pc_in[7:0];
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_RET_RD_HI: begin
                    mem_data_buf <= bus_din; // low byte
                    bus_addr <= sp_out + 16'd1;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_RET_EXEC;
                end

                S_RET_EXEC: begin
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_RST_PUSH_HI: begin
                    bus_addr <= sp_out - 16'd1;
                    bus_dout <= pc_in[15:8];
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_RST_PUSH_LO;
                end

                S_RST_PUSH_LO: begin
                    bus_addr <= sp_out - 16'd2;
                    bus_dout <= pc_in[7:0];
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_LD_NN_HL_WR_HI: begin // LD (nn), HL / LD (nn), IX / LD (nn), IY ハイバイト書込
                    bus_addr <= target_addr + 16'd1;
                    bus_dout <= (prefix_dd ? ix_out[15:8] : prefix_fd ? iy_out[15:8] : hl_out[15:8]);
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_LD_HL_NN_RD_HI: begin // LD HL, (nn) / LD IX, (nn) / LD IY, (nn) ハイバイト読出
                    mem_data_buf <= bus_din;
                    bus_addr <= target_addr + 16'd1;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_LD_HL_NN_EXEC;
                end

                S_LD_HL_NN_EXEC: begin // LD HL, (nn) / LD IX, (nn) / LD IY, (nn) 完了
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_EX_SP_HL_RD_HI: begin // EX (SP), HL SP+1 読出
                    mem_data_buf <= bus_din; // low byte from SP
                    bus_addr <= sp_out + 16'd1;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_EX_SP_HL_WR_LO;
                end

                S_EX_SP_HL_WR_LO: begin // EX (SP), HL / IX / IY 下位バイトを SP へ書込
                    temp16 <= {bus_din, mem_data_buf}; // 新しい値
                    bus_addr <= sp_out;
                    bus_dout <= (prefix_dd ? ix_out[7:0] : prefix_fd ? iy_out[7:0] : hl_out[7:0]);
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b1;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_EX_SP_HL_WR_HI;
                end

                S_EX_SP_HL_WR_HI: begin // EX (SP), HL / IX / IY 上位バイトを SP+1 へ書込
                    bus_addr <= sp_out + 16'd1;
                    bus_dout <= (prefix_dd ? ix_out[15:8] : prefix_fd ? iy_out[15:8] : hl_out[15:8]);
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                // Phase 4: CB プレフィックス命令シーケンシャル実行
                S_CB_FETCH_T2: begin
                    cb_opcode <= bus_din;
                    probe_opcode <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    bus_m1_n <= 1'b1;
                    if (bus_din[2:0] != 3'd6) begin
                        state <= S_CB_EXEC;
                    end else begin
                        bus_addr <= hl_out;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        bus_wr_n <= 1'b1;
                        probe_bus_active <= 1'b1;
                        state <= S_CB_MEM_RD_T2;
                    end
                end

                S_CB_EXEC: begin
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_cb <= 1'b0;
                    state <= S_M1_T1;
                end

                S_CB_MEM_RD_T2: begin
                    mem_data_buf <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    if (cb_opcode[7:6] == 2'b01) begin // BIT b, (HL)
                        state <= S_CB_MEM_BIT_EX;
                    end else begin // Shift/Rotate/RES/SET (HL)
                        state <= S_CB_MEM_WR_T1;
                    end
                end

                S_CB_MEM_BIT_EX: begin
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_cb <= 1'b0;
                    state <= S_M1_T1;
                end

                S_CB_MEM_WR_T1: begin
                    bus_addr <= hl_out;
                    bus_dout <= alu_out_res;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    bus_rd_n <= 1'b1;
                    probe_bus_active <= 1'b1;
                    state <= S_CB_MEM_WR_T2;
                end

                S_CB_MEM_WR_T2: begin
                    bus_mreq_n <= 1'b1;
                    bus_wr_n <= 1'b1;
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_cb <= 1'b0;
                    state <= S_M1_T1;
                end

                // Phase 5: ED プレフィックス命令シーケンシャル実行
                S_ED_FETCH_T2: begin
                    ed_opcode <= bus_din;
                    probe_opcode <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    bus_m1_n <= 1'b1;
                    if ((bus_din & 8'hC7) == 8'h43) begin // LD (nn), dd
                        bus_addr <= pc_in;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_ED_NN_RD_LO;
                    end else if ((bus_din & 8'hC7) == 8'h4B) begin // LD dd, (nn)
                        bus_addr <= pc_in;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_ED_NN_RD_LO;
                    end else if (bus_din == 8'hA0 || bus_din == 8'hB0 || bus_din == 8'hA8 || bus_din == 8'hB8) begin // LDI / LDIR / LDD / LDDR
                        bus_addr <= hl_out;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        bus_wr_n <= 1'b1;
                        probe_bus_active <= 1'b1;
                        state <= S_ED_LDIR_RD;
                    end else if (bus_din == 8'hA1 || bus_din == 8'hB1 || bus_din == 8'hA9 || bus_din == 8'hB9) begin // CPI / CPIR / CPD / CPDR
                        bus_addr <= hl_out;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        bus_wr_n <= 1'b1;
                        probe_bus_active <= 1'b1;
                        state <= S_ED_CPIR_RD;
                    end else if (bus_din == 8'h6F || bus_din == 8'h67) begin // RLD / RRD
                        bus_addr <= hl_out;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        bus_wr_n <= 1'b1;
                        probe_bus_active <= 1'b1;
                        state <= S_ED_RRD_RD;
                    end else if ((bus_din & 8'hC7) == 8'h40) begin // IN r, (C)
                        bus_addr <= bc_out;
                        bus_iorq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        bus_wr_n <= 1'b1;
                        bus_mreq_n <= 1'b1;
                        probe_bus_active <= 1'b1;
                        state <= S_IO_RD_T2;
                    end else if ((bus_din & 8'hC7) == 8'h41) begin // OUT (C), r
                        bus_addr <= bc_out;
                        bus_dout <= (bus_din[5:3] == 3'd6) ? 8'h00 :
                                    (bus_din[5:3] == 3'd0) ? bc_out[15:8] :
                                    (bus_din[5:3] == 3'd1) ? bc_out[7:0] :
                                    (bus_din[5:3] == 3'd2) ? de_out[15:8] :
                                    (bus_din[5:3] == 3'd3) ? de_out[7:0] :
                                    (bus_din[5:3] == 3'd4) ? hl_out[15:8] :
                                    (bus_din[5:3] == 3'd5) ? hl_out[7:0] :
                                    acc_out;
                        bus_iorq_n <= 1'b0;
                        bus_wr_n <= 1'b0;
                        bus_rd_n <= 1'b1;
                        bus_mreq_n <= 1'b1;
                        probe_bus_active <= 1'b1;
                        state <= S_IO_WR_T2;
                    end else if (bus_din == 8'h4D || bus_din == 8'h45) begin // RETI / RETN
                        bus_addr <= sp_out;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        bus_wr_n <= 1'b1;
                        probe_bus_active <= 1'b1;
                        state <= S_RET_RD_HI;
                    end else begin
                        state <= S_ED_EXEC;
                    end
                end

                S_ED_EXEC: begin
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_ed <= 1'b0;
                    state <= S_M1_T1;
                end

                S_ED_NN_RD_LO: begin
                    imm_low <= bus_din;
                    bus_addr <= pc_in;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_ED_NN_RD_HI;
                end

                S_ED_NN_RD_HI: begin
                    target_addr <= {bus_din, imm_low};
                    if ((ed_opcode & 8'hC7) == 8'h43) begin // LD (nn), dd
                        temp16 <= get_pair16(ed_opcode[5:4], bc_out, de_out, hl_out, sp_out);
                        bus_addr <= {bus_din, imm_low};
                        case (ed_opcode[5:4])
                            2'd0: bus_dout <= bc_out[7:0];
                            2'd1: bus_dout <= de_out[7:0];
                            2'd2: bus_dout <= hl_out[7:0];
                            2'd3: bus_dout <= sp_out[7:0];
                        endcase
                        bus_mreq_n <= 1'b0;
                        bus_wr_n <= 1'b0;
                        bus_rd_n <= 1'b1;
                        probe_bus_active <= 1'b1;
                        state <= S_ED_NN_WR_HI;
                    end else begin // LD dd, (nn)
                        bus_addr <= {bus_din, imm_low};
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_LD_HL_NN_RD_HI;
                    end
                end

                S_ED_NN_WR_HI: begin
                    bus_addr <= target_addr + 16'd1;
                    bus_dout <= temp16[15:8];
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_ED_LDIR_RD: begin
                    mem_data_buf <= bus_din;
                    bus_addr <= de_out;
                    bus_dout <= bus_din;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    bus_rd_n <= 1'b1;
                    probe_bus_active <= 1'b1;
                    state <= S_ED_LDIR_WR;
                end

                S_ED_LDIR_WR: begin
                    bus_mreq_n <= 1'b1;
                    bus_wr_n <= 1'b1;
                    state <= S_ED_LDIR_EXEC;
                end

                S_ED_LDIR_EXEC: begin
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_ed <= 1'b0;
                    state <= S_M1_T1;
                end

                S_ED_CPIR_RD: begin
                    mem_data_buf <= bus_din;
                    bus_mreq_n <= 1'b1;
                    bus_rd_n <= 1'b1;
                    state <= S_ED_CPIR_EXEC;
                end

                S_ED_CPIR_EXEC: begin
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_ed <= 1'b0;
                    state <= S_M1_T1;
                end

                S_ED_RRD_RD: begin
                    mem_data_buf <= bus_din;
                    bus_addr <= hl_out;
                    bus_dout <= (ed_opcode == 8'h6F) ? {bus_din[3:0], acc_out[3:0]} : {acc_out[3:0], bus_din[7:4]};
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    bus_rd_n <= 1'b1;
                    probe_bus_active <= 1'b1;
                    state <= S_ED_RRD_WR;
                end

                S_ED_RRD_WR: begin
                    bus_mreq_n <= 1'b1;
                    bus_wr_n <= 1'b1;
                    state <= S_ED_RRD_EXEC;
                end

                S_ED_RRD_EXEC: begin
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_ed <= 1'b0;
                    state <= S_M1_T1;
                end

                S_IO_RD_T1: begin
                    imm_low <= bus_din;
                    bus_addr <= {acc_out, bus_din};
                    bus_iorq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    bus_wr_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    probe_bus_active <= 1'b1;
                    state <= S_IO_RD_T2;
                end

                S_IO_RD_T2: begin
                    bus_iorq_n <= 1'b1;
                    bus_rd_n <= 1'b1;
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_ed <= 1'b0;
                    state <= S_M1_T1;
                end

                S_IO_WR_T1: begin
                    bus_addr <= {acc_out, bus_din};
                    bus_dout <= acc_out;
                    bus_iorq_n <= 1'b0;
                    bus_rd_n <= 1'b1;
                    bus_wr_n <= 1'b0;
                    bus_mreq_n <= 1'b1;
                    probe_bus_active <= 1'b1;
                    state <= S_IO_WR_T2;
                end

                S_IO_WR_T2: begin
                    bus_iorq_n <= 1'b1;
                    bus_wr_n <= 1'b1;
                    bus_addr <= pc_in;
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    prefix_ed <= 1'b0;
                    state <= S_M1_T1;
                end

                // Phase 6: インデックス命令シーケンシャル実行
                S_IDX_DISP_FETCH: begin
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    target_addr <= (prefix_dd ? ix_out : iy_out) + {{8{bus_din[7]}}, bus_din};
                    if (opcode == 8'h36) begin // LD (IX+d), n
                        bus_addr <= pc_in + 16'd1;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_IDX_IMM_N;
                    end else if (opcode == 8'h34 || opcode == 8'h35) begin // INC/DEC (IX+d)
                        bus_addr <= (prefix_dd ? ix_out : iy_out) + {{8{bus_din[7]}}, bus_din};
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_IDX_RMW_RD;
                    end else if (opcode[7:6] == 2'b10 && opcode[2:0] == 3'b110) begin // ALU A, (IX+d)
                        bus_addr <= (prefix_dd ? ix_out : iy_out) + {{8{bus_din[7]}}, bus_din};
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_IDX_ALU_RD;
                    end else if (opcode[7:6] == 2'b01 && opcode[2:0] == 3'b110) begin // LD r, (IX+d)
                        bus_addr <= (prefix_dd ? ix_out : iy_out) + {{8{bus_din[7]}}, bus_din};
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_IDX_MEM_RD;
                    end else if (opcode[7:6] == 2'b01 && opcode[5:3] == 3'b110) begin // LD (IX+d), r
                        bus_addr <= (prefix_dd ? ix_out : iy_out) + {{8{bus_din[7]}}, bus_din};
                        bus_dout <= reg_src_data;
                        bus_mreq_n <= 1'b0;
                        bus_wr_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_MEM_WR_T1;
                    end else begin
                        prefix_dd <= 1'b0;
                        prefix_fd <= 1'b0;
                        state <= S_M1_T1;
                    end
                end

                S_IDX_IMM_N: begin // LD (IX+d), n の n 読出完了 -> メモリ書込
                    bus_rd_n <= 1'b1;
                    bus_addr <= target_addr;
                    bus_dout <= bus_din;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_IDX_MEM_RD: begin // LD r, (IX+d) 読出完了
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_IDX_ALU_RD: begin // ALU A, (IX+d) 読出完了
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    prefix_dd <= 1'b0;
                    prefix_fd <= 1'b0;
                    state <= S_M1_T1;
                end

                S_IDX_RMW_RD: begin // INC/DEC (IX+d) 読出完了
                    mem_data_buf <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_IDX_RMW_WR;
                end

                S_IDX_RMW_WR: begin // INC/DEC (IX+d) 書込開始
                    bus_addr <= target_addr;
                    bus_dout <= alu_out_res;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_IDX_CB_DISP: begin // DD CB d op の d 読出完了 -> op フェッチ
                    bus_rd_n <= 1'b1;
                    target_addr <= (prefix_dd ? ix_out : iy_out) + {{8{bus_din[7]}}, bus_din};
                    bus_addr <= pc_in + 16'd1;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_IDX_CB_OP;
                end

                S_IDX_CB_OP: begin // op 読出完了 -> (IX+d) メモリ読出
                    bus_rd_n <= 1'b1;
                    cb_opcode <= bus_din;
                    probe_opcode <= bus_din;
                    bus_addr <= target_addr;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_IDX_CB_MEM;
                end

                S_IDX_CB_MEM: begin // (IX+d) メモリ読出完了
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    if ((cb_opcode & 8'hC0) == 8'h40) begin // BIT
                        prefix_dd <= 1'b0;
                        prefix_fd <= 1'b0;
                        state <= S_M1_T1;
                    end else begin // RES / SET / Shift / Rotate
                        mem_data_buf <= bus_din;
                        state <= S_IDX_CB_WR;
                    end
                end

                S_IDX_CB_WR: begin // RES / SET / Shift / Rotate メモリ書込開始
                    bus_addr <= target_addr;
                    bus_dout <= alu_out_res;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_HALT: begin
                    probe_bus_active <= 1'b0;
                end

                default: state <= S_M1_T1;
            endcase
        end
    end

endmodule
