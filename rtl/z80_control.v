// @intent:responsibility 命令フェッチ、デコード、マシンサイクル制御 FSM (Phase 2: フル 8-bit 演算 & メモリ間接)
// @intent:state-machine M1 (Opcode Fetch), M2/M3 (Operand / Memory Read/Write / RMW)
// @intent:timing-precision 競合フリー組合せ ALU 供給と正確な T-state バス駆動

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

    // PC 入力
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

    // レジスタ直結参照（パイプライン即時伝播）
    input  wire [7:0]  acc_out,
    input  wire [15:0] hl_out,
    input  wire [15:0] bc_out,
    input  wire [15:0] de_out,
    /* verilator lint_off UNUSED */
    input  wire [15:0] sp_out,
    /* verilator lint_on UNUSED */

    // 交換命令
    output reg         ex_de_hl,
    output reg         ex_af_af_alt,
    output reg         exx,

    // ALU 制御
    output reg  [4:0]  alu_op,
    output reg  [7:0]  alu_in_a,
    output reg  [7:0]  alu_in_b,
    input  wire [7:0]  alu_out_res,
    output reg         flags_wr_en,

    // タイムトラベル（Undo 復元）
    input  wire        restore_en,
    input  wire        restore_halted,

    // 現在の命令情報 (UI プローブ用)
    output reg  [7:0]  probe_opcode,
    output reg         probe_bus_active,
    output wire        probe_instr_boundary,
    output reg         halted
);

    // FSM ステート定義
    localparam S_M1_T1        = 5'd0;
    localparam S_M1_T2        = 5'd1;
    localparam S_M1_T3        = 5'd2;
    localparam S_M1_T4        = 5'd3;
    localparam S_M2_T1_RD     = 5'd4;
    localparam S_M2_T2_RD     = 5'd5;
    localparam S_M3_T1_RD     = 5'd6;
    localparam S_MEM_RD_T1    = 5'd7;
    localparam S_MEM_WR_PREP  = 5'd8;
    localparam S_MEM_WR_T1    = 5'd9;
    localparam S_MEM_RMW_RD   = 5'd10;
    localparam S_MEM_RMW_WR   = 5'd11;
    localparam S_MEM_ALU_RD   = 5'd12;
    localparam S_MEM_ALU_EXEC = 5'd13;
    localparam S_ALU_IMM_EXEC = 5'd14;
    localparam S_HALT         = 5'd15;

    reg [4:0] state;
    reg [7:0] opcode;
    reg [7:0] imm_low;
    reg [7:0] mem_data_buf;

    assign probe_instr_boundary = (state == S_M1_T1);

    // 組合せ ALU オペランド & 演算種別生成
    always @(*) begin
        alu_in_a = acc_out;
        alu_in_b = reg_src_data;
        alu_op   = 5'd0;

        case (state)
            S_M1_T4: begin
                if (opcode[7:6] == 2'b00) begin
                    if (opcode[2:0] == 3'b100) begin // INC r
                        alu_in_a = reg_src_data;
                        alu_op   = 5'd8; // INC
                    end else if (opcode[2:0] == 3'b101) begin // DEC r
                        alu_in_a = reg_src_data;
                        alu_op   = 5'd9; // DEC
                    end else if (opcode == 8'h27) begin // DAA
                        alu_in_a = acc_out;
                        alu_op   = 5'd10;
                    end else if (opcode == 8'h2F) begin // CPL
                        alu_in_a = acc_out;
                        alu_op   = 5'd11;
                    end else if (opcode == 8'h37) begin // SCF
                        alu_in_a = acc_out;
                        alu_op   = 5'd14;
                    end else if (opcode == 8'h3F) begin // CCF
                        alu_in_a = acc_out;
                        alu_op   = 5'd13;
                    end else if (opcode == 8'h07) begin // RLCA
                        alu_in_a = acc_out;
                        alu_op   = 5'd15;
                    end else if (opcode == 8'h0F) begin // RRCA
                        alu_in_a = acc_out;
                        alu_op   = 5'd16;
                    end else if (opcode == 8'h17) begin // RLA
                        alu_in_a = acc_out;
                        alu_op   = 5'd17;
                    end else if (opcode == 8'h1F) begin // RRA
                        alu_in_a = acc_out;
                        alu_op   = 5'd18;
                    end
                end else if (opcode[7:6] == 2'b10) begin // ALU A, r
                    alu_in_a = acc_out;
                    alu_in_b = reg_src_data;
                    case (opcode[5:3])
                        3'b000: alu_op = 5'd0; // ADD
                        3'b001: alu_op = 5'd1; // ADC
                        3'b010: alu_op = 5'd2; // SUB
                        3'b011: alu_op = 5'd3; // SBC
                        3'b100: alu_op = 5'd4; // AND
                        3'b101: alu_op = 5'd5; // XOR
                        3'b110: alu_op = 5'd6; // OR
                        3'b111: alu_op = 5'd7; // CP
                    endcase
                end
            end

            S_MEM_RMW_WR: begin // INC/DEC (HL)
                alu_in_a = mem_data_buf;
                alu_op   = (opcode == 8'h34) ? 5'd8 : 5'd9;
            end

            S_MEM_ALU_EXEC: begin // ALU A, (HL)
                alu_in_a = acc_out;
                alu_in_b = mem_data_buf;
                case (opcode[5:3])
                    3'b000: alu_op = 5'd0; // ADD
                    3'b001: alu_op = 5'd1; // ADC
                    3'b010: alu_op = 5'd2; // SUB
                    3'b011: alu_op = 5'd3; // SBC
                    3'b100: alu_op = 5'd4; // AND
                    3'b101: alu_op = 5'd5; // XOR
                    3'b110: alu_op = 5'd6; // OR
                    3'b111: alu_op = 5'd7; // CP
                endcase
            end

            S_ALU_IMM_EXEC: begin // ALU A, n
                alu_in_a = acc_out;
                alu_in_b = imm_low;
                case (opcode[5:3])
                    3'b000: alu_op = 5'd0; // ADD
                    3'b001: alu_op = 5'd1; // ADC
                    3'b010: alu_op = 5'd2; // SUB
                    3'b011: alu_op = 5'd3; // SBC
                    3'b100: alu_op = 5'd4; // AND
                    3'b101: alu_op = 5'd5; // XOR
                    3'b110: alu_op = 5'd6; // OR
                    3'b111: alu_op = 5'd7; // CP
                endcase
            end

            default: ;
        endcase
    end

    // メイン制御 FSM
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state <= S_M1_T1;
            opcode <= 8'h00;
            imm_low <= 8'h00;
            mem_data_buf <= 8'h00;
            bus_addr <= 16'h0000;
            bus_dout <= 8'h00;
            bus_mreq_n <= 1'b1;
            bus_iorq_n <= 1'b1;
            bus_rd_n <= 1'b1;
            bus_wr_n <= 1'b1;
            bus_m1_n <= 1'b1;
            pc_inc <= 1'b0;
            pc_load <= 1'b0;
            pc_new <= 16'h0000;
            reg_src_sel <= 3'd0;
            reg_wr_en <= 1'b0;
            reg_dst_sel <= 3'd0;
            reg_wr_data <= 8'h00;
            pair_wr_en <= 1'b0;
            pair_sel <= 2'd0;
            pair_wr_data <= 16'h0000;
            pair_is_af <= 1'b0;
            ex_de_hl <= 1'b0;
            ex_af_af_alt <= 1'b0;
            exx <= 1'b0;
            flags_wr_en <= 1'b0;
            probe_opcode <= 8'h00;
            probe_bus_active <= 1'b0;
            halted <= 1'b0;
        end else if (restore_en) begin
            // タイムトラベル（Undo 復元）
            state <= S_M1_T1;
            opcode <= 8'h00;
            imm_low <= 8'h00;
            mem_data_buf <= 8'h00;
            bus_mreq_n <= 1'b1;
            bus_iorq_n <= 1'b1;
            bus_rd_n <= 1'b1;
            bus_wr_n <= 1'b1;
            bus_m1_n <= 1'b1;
            probe_bus_active <= 1'b0;
            pc_inc <= 1'b0;
            pc_load <= 1'b0;
            reg_wr_en <= 1'b0;
            pair_wr_en <= 1'b0;
            flags_wr_en <= 1'b0;
            halted <= restore_halted;
        end else begin
            // デフォルトパルスリセット
            pc_inc <= 1'b0;
            pc_load <= 1'b0;
            reg_wr_en <= 1'b0;
            pair_wr_en <= 1'b0;
            ex_de_hl <= 1'b0;
            ex_af_af_alt <= 1'b0;
            exx <= 1'b0;
            flags_wr_en <= 1'b0;
            probe_bus_active <= 1'b0;

            case (state)
                S_M1_T1: begin
                    bus_addr <= pc_in;
                    pc_inc <= 1'b1; // M1 命令フェッチに伴い PC++
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_M1_T2;
                end

                S_M1_T2: begin
                    opcode <= bus_din;
                    probe_opcode <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    bus_m1_n <= 1'b1;
                    state <= S_M1_T3;
                end

                S_M1_T3: begin
                    // 命令デコード
                    case (opcode)
                        8'h00: begin // NOP
                            state <= S_M1_T1;
                        end

                        8'h76: begin // HALT
                            halted <= 1'b1;
                            state <= S_HALT;
                        end

                        8'hEB: begin // EX DE, HL
                            ex_de_hl <= 1'b1;
                            state <= S_M1_T1;
                        end

                        8'h08: begin // EX AF, AF'
                            ex_af_af_alt <= 1'b1;
                            state <= S_M1_T1;
                        end

                        8'hD9: begin // EXX
                            exx <= 1'b1;
                            state <= S_M1_T1;
                        end

                        // 単一サイクル特殊アキュムレータ / フラグ操作
                        8'h27, 8'h2F, 8'h37, 8'h3F, // DAA, CPL, SCF, CCF
                        8'h07, 8'h0F, 8'h17, 8'h1F: begin // RLCA, RRCA, RLA, RRA
                            state <= S_M1_T4;
                        end

                        // LD A, (BC)
                        8'h0A: begin
                            bus_addr <= bc_out;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            reg_dst_sel <= 3'd7; // A
                            state <= S_MEM_RD_T1;
                        end

                        // LD A, (DE)
                        8'h1A: begin
                            bus_addr <= de_out;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            reg_dst_sel <= 3'd7; // A
                            state <= S_MEM_RD_T1;
                        end

                        // LD (BC), A
                        8'h02: begin
                            bus_addr <= bc_out;
                            bus_dout <= acc_out;
                            bus_mreq_n <= 1'b0;
                            bus_wr_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_MEM_WR_T1;
                        end

                        // LD (DE), A
                        8'h12: begin
                            bus_addr <= de_out;
                            bus_dout <= acc_out;
                            bus_mreq_n <= 1'b0;
                            bus_wr_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_MEM_WR_T1;
                        end

                        // LD (nn), A
                        8'h32: begin
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_M2_T1_RD;
                        end

                        // LD A, (nn)
                        8'h3A: begin
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_M2_T1_RD;
                        end

                        // INC (HL)
                        8'h34: begin
                            bus_addr <= hl_out;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_MEM_RMW_RD;
                        end

                        // DEC (HL)
                        8'h35: begin
                            bus_addr <= hl_out;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_MEM_RMW_RD;
                        end

                        // LD (HL), n
                        8'h36: begin
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_M2_T1_RD;
                        end

                        // JP nn (0xC3)
                        8'hC3: begin
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_M2_T1_RD;
                        end

                        // JR e (0x18)
                        8'h18: begin
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_M2_T1_RD;
                        end

                        default: begin
                            // グループ判定
                            if (opcode[7:6] == 2'b01) begin
                                if (opcode[2:0] == 3'b110) begin // LD r, (HL) (01rrr110)
                                    reg_dst_sel <= opcode[5:3];
                                    bus_addr <= hl_out;
                                    bus_mreq_n <= 1'b0;
                                    bus_rd_n <= 1'b0;
                                    probe_bus_active <= 1'b1;
                                    state <= S_MEM_RD_T1;
                                end else if (opcode[5:3] == 3'b110) begin // LD (HL), r (01110rrr)
                                    reg_src_sel <= opcode[2:0];
                                    state <= S_MEM_WR_PREP;
                                end else begin // LD r, r' (01dddsss)
                                    reg_src_sel <= opcode[2:0];
                                    reg_dst_sel <= opcode[5:3];
                                    state <= S_M1_T4;
                                end
                            end else if (opcode[7:6] == 2'b00 && opcode[2:0] == 3'b110) begin // LD r, n
                                reg_dst_sel <= opcode[5:3];
                                bus_addr <= pc_in;
                                bus_mreq_n <= 1'b0;
                                bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1;
                                state <= S_M2_T1_RD;
                            end else if (opcode[7:6] == 2'b00 && opcode[2:0] == 3'b100) begin // INC r
                                reg_src_sel <= opcode[5:3];
                                state <= S_M1_T4;
                            end else if (opcode[7:6] == 2'b00 && opcode[2:0] == 3'b101) begin // DEC r
                                reg_src_sel <= opcode[5:3];
                                state <= S_M1_T4;
                            end else if (opcode[7:6] == 2'b10) begin
                                if (opcode[2:0] == 3'b110) begin // ALU A, (HL) (10ooo110)
                                    bus_addr <= hl_out;
                                    bus_mreq_n <= 1'b0;
                                    bus_rd_n <= 1'b0;
                                    probe_bus_active <= 1'b1;
                                    state <= S_MEM_ALU_RD;
                                end else begin // ALU A, r (10ooorrr)
                                    reg_src_sel <= opcode[2:0];
                                    state <= S_M1_T4;
                                end
                            end else if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b110) begin // ALU A, n (11ooo110)
                                bus_addr <= pc_in;
                                bus_mreq_n <= 1'b0;
                                bus_rd_n <= 1'b0;
                                probe_bus_active <= 1'b1;
                                state <= S_M2_T1_RD;
                            end else begin
                                // 未サポート命令は NOP 扱い
                                state <= S_M1_T1;
                            end
                        end
                    endcase
                end

                S_M1_T4: begin
                    // 単一サイクル命令のコミット（組合せ ALU 出力を即時ラッチ）
                    if (opcode[7:6] == 2'b01) begin // LD r, r'
                        reg_wr_en <= 1'b1;
                        reg_wr_data <= reg_src_data;
                    end else if (opcode[7:6] == 2'b00) begin
                        if (opcode[2:0] == 3'b100 || opcode[2:0] == 3'b101) begin // INC/DEC r
                            reg_wr_en <= 1'b1;
                            reg_dst_sel <= opcode[5:3];
                            reg_wr_data <= alu_out_res;
                            flags_wr_en <= 1'b1;
                        end else if (opcode == 8'h37 || opcode == 8'h3F) begin // SCF, CCF
                            flags_wr_en <= 1'b1;
                        end else begin // DAA, CPL, RLCA, RRCA, RLA, RRA
                            reg_wr_en <= 1'b1;
                            reg_dst_sel <= 3'd7; // A
                            reg_wr_data <= alu_out_res;
                            flags_wr_en <= 1'b1;
                        end
                    end else if (opcode[7:6] == 2'b10) begin // ALU A, r
                        if (opcode[5:3] != 3'b111) begin // CP 以外は A を更新
                            reg_wr_en <= 1'b1;
                            reg_dst_sel <= 3'd7; // A
                            reg_wr_data <= alu_out_res;
                        end
                        flags_wr_en <= 1'b1;
                    end
                    state <= S_M1_T1;
                end

                S_MEM_RD_T1: begin
                    // 外部メモリ読出完了 -> レジスタ書込
                    reg_wr_en <= 1'b1;
                    reg_wr_data <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_M1_T1;
                end

                S_MEM_WR_PREP: begin
                    // レジスタ読出値をデータバスへ載せてメモリ書込開始
                    bus_addr <= hl_out;
                    bus_dout <= reg_src_data;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_MEM_WR_T1: begin
                    // メモリ書込完了
                    bus_wr_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_M1_T1;
                end

                S_MEM_RMW_RD: begin
                    // INC/DEC (HL) 読出値のバッファリング
                    mem_data_buf <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_MEM_RMW_WR;
                end

                S_MEM_RMW_WR: begin
                    // INC/DEC (HL) の計算結果書戻し
                    bus_addr <= hl_out;
                    bus_dout <= alu_out_res;
                    bus_mreq_n <= 1'b0;
                    bus_wr_n <= 1'b0;
                    flags_wr_en <= 1'b1;
                    probe_bus_active <= 1'b1;
                    state <= S_MEM_WR_T1;
                end

                S_MEM_ALU_RD: begin
                    // ALU A, (HL) のメモリ値バッファリング
                    mem_data_buf <= bus_din;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_MEM_ALU_EXEC;
                end

                S_MEM_ALU_EXEC: begin
                    // ALU A, (HL) 結果反映
                    if (opcode[5:3] != 3'b111) begin // CP 以外は A を更新
                        reg_wr_en <= 1'b1;
                        reg_dst_sel <= 3'd7; // A
                        reg_wr_data <= alu_out_res;
                    end
                    flags_wr_en <= 1'b1;
                    state <= S_M1_T1;
                end

                S_M2_T1_RD: begin
                    imm_low <= bus_din;
                    pc_inc <= 1'b1;
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_M2_T2_RD;
                end

                S_M2_T2_RD: begin
                    if (opcode == 8'h36) begin // LD (HL), n (メモリ直接書込)
                        bus_addr <= hl_out;
                        bus_dout <= imm_low;
                        bus_mreq_n <= 1'b0;
                        bus_wr_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_MEM_WR_T1;
                    end else if (opcode[7:6] == 2'b00 && opcode[2:0] == 3'b110) begin // LD r, n
                        reg_wr_en <= 1'b1;
                        reg_wr_data <= imm_low;
                        state <= S_M1_T1;
                    end else if (opcode[7:6] == 2'b11 && opcode[2:0] == 3'b110) begin // ALU A, n
                        state <= S_ALU_IMM_EXEC;
                    end else if (opcode == 8'hC3) begin // JP nn (low byte received, fetch high)
                        bus_addr <= pc_in;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_M3_T1_RD;
                    end else if (opcode == 8'h32 || opcode == 8'h3A) begin // LD (nn), A / LD A, (nn)
                        bus_addr <= pc_in;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_M3_T1_RD;
                    end else if (opcode == 8'h18) begin // JR e (relative jump)
                        pc_load <= 1'b1;
                        pc_new <= pc_in + {{8{imm_low[7]}}, imm_low};
                        state <= S_M1_T1;
                    end else begin
                        state <= S_M1_T1;
                    end
                end

                S_ALU_IMM_EXEC: begin
                    // ALU A, n 結果反映
                    if (opcode[5:3] != 3'b111) begin // CP 以外は A を更新
                        reg_wr_en <= 1'b1;
                        reg_dst_sel <= 3'd7; // A
                        reg_wr_data <= alu_out_res;
                    end
                    flags_wr_en <= 1'b1;
                    state <= S_M1_T1;
                end

                S_M3_T1_RD: begin
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    if (opcode == 8'hC3) begin // JP nn
                        pc_load <= 1'b1;
                        pc_new <= {bus_din, imm_low};
                        state <= S_M1_T1;
                    end else if (opcode == 8'h32) begin // LD (nn), A
                        pc_inc <= 1'b1; // 3バイト目フェッチ完了に伴い PC++
                        bus_addr <= {bus_din, imm_low};
                        bus_dout <= acc_out;
                        bus_mreq_n <= 1'b0;
                        bus_wr_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_MEM_WR_T1;
                    end else if (opcode == 8'h3A) begin // LD A, (nn)
                        pc_inc <= 1'b1; // 3バイト目フェッチ完了に伴い PC++
                        bus_addr <= {bus_din, imm_low};
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        reg_dst_sel <= 3'd7; // A
                        state <= S_MEM_RD_T1;
                    end else begin
                        state <= S_M1_T1;
                    end
                end

                S_HALT: begin
                    probe_bus_active <= 1'b0;
                end

                default: state <= S_M1_T1;
            endcase
        end
    end

endmodule
