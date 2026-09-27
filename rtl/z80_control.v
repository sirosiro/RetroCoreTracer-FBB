// @intent:responsibility 命令フェッチ、デコード、マシンサイクル制御 FSM
// @intent:state-machine M1 (Opcode Fetch), M2/M3 (Operand / Memory Access)

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

    // 交換命令
    output reg         ex_de_hl,
    output reg         ex_af_af_alt,
    output reg         exx,

    // ALU 制御
    output reg  [3:0]  alu_op,
    output reg  [7:0]  alu_in_a,
    output reg  [7:0]  alu_in_b,
    input  wire [7:0]  alu_out_res,
    output reg         flags_wr_en,

    // 現在の命令情報 (UI プローブ用)
    output reg  [7:0]  probe_opcode,
    output reg         probe_bus_active,
    output reg         halted
);

    // FSM ステート定義
    localparam S_M1_T1     = 4'd0;
    localparam S_M1_T2     = 4'd1;
    localparam S_M1_T3     = 4'd2;
    localparam S_M1_T4     = 4'd3;
    localparam S_M2_T1_RD  = 4'd4;
    localparam S_M2_T2_RD  = 4'd5;
    localparam S_M3_T1_RD  = 4'd6;
    localparam S_M3_T2_RD  = 4'd7;
    localparam S_HALT      = 4'd8;

    reg [3:0] state;
    reg [7:0] opcode;
    reg [7:0] imm_low;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state <= S_M1_T1;
            opcode <= 8'h00;
            imm_low <= 8'h00;
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
            alu_op <= 4'd0;
            alu_in_a <= 8'h00;
            alu_in_b <= 8'h00;
            flags_wr_en <= 1'b0;
            probe_opcode <= 8'h00;
            probe_bus_active <= 1'b0;
            halted <= 1'b0;
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
                    bus_m1_n <= 1'b0;
                    bus_mreq_n <= 1'b0;
                    bus_rd_n <= 1'b0;
                    probe_bus_active <= 1'b1;
                    state <= S_M1_T2;
                end

                S_M1_T2: begin
                    opcode <= bus_din;
                    probe_opcode <= bus_din;
                    pc_inc <= 1'b1; // PC++
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    bus_m1_n <= 1'b1;
                    state <= S_M1_T3;
                end

                S_M1_T3: begin
                    // 命令デコード & 単一サイクル命令実行
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

                        // LD r, r' (01dddsss)
                        8'h40, 8'h41, 8'h42, 8'h43, 8'h44, 8'h45, 8'h47,
                        8'h48, 8'h49, 8'h4A, 8'h4B, 8'h4C, 8'h4D, 8'h4F,
                        8'h50, 8'h51, 8'h52, 8'h53, 8'h54, 8'h55, 8'h57,
                        8'h58, 8'h59, 8'h5A, 8'h5B, 8'h5C, 8'h5D, 8'h5F,
                        8'h60, 8'h61, 8'h62, 8'h63, 8'h64, 8'h65, 8'h67,
                        8'h68, 8'h69, 8'h6A, 8'h6B, 8'h6C, 8'h6D, 8'h6F,
                        8'h78, 8'h79, 8'h7A, 8'h7B, 8'h7C, 8'h7D, 8'h7F: begin
                            reg_src_sel <= opcode[2:0];
                            reg_dst_sel <= opcode[5:3];
                            state <= S_M1_T4;
                        end

                        // LD r, n (00rrr110)
                        8'h06, 8'h0E, 8'h16, 8'h1E, 8'h26, 8'h2E, 8'h3E: begin
                            reg_dst_sel <= opcode[5:3];
                            bus_addr <= pc_in;
                            bus_mreq_n <= 1'b0;
                            bus_rd_n <= 1'b0;
                            probe_bus_active <= 1'b1;
                            state <= S_M2_T1_RD;
                        end

                        // INC r (00rrr100)
                        8'h04, 8'h0C, 8'h14, 8'h1C, 8'h24, 8'h2C, 8'h3C: begin
                            reg_src_sel <= opcode[5:3];
                            alu_op <= 4'd8; // INC
                            state <= S_M1_T4;
                        end

                        // DEC r (00rrr101)
                        8'h05, 8'h0D, 8'h15, 8'h1D, 8'h25, 8'h2D, 8'h3D: begin
                            reg_src_sel <= opcode[5:3];
                            alu_op <= 4'd9; // DEC
                            state <= S_M1_T4;
                        end

                        // ADD A, r (10000rrr)
                        8'h80, 8'h81, 8'h82, 8'h83, 8'h84, 8'h85, 8'h87: begin
                            reg_src_sel <= opcode[2:0];
                            alu_op <= 4'd0; // ADD
                            state <= S_M1_T4;
                        end

                        // SUB A, r (10010rrr)
                        8'h90, 8'h91, 8'h92, 8'h93, 8'h94, 8'h95, 8'h97: begin
                            reg_src_sel <= opcode[2:0];
                            alu_op <= 4'd2; // SUB
                            state <= S_M1_T4;
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
                            // 未サポート命令は NOP 扱いとして次へ
                            state <= S_M1_T1;
                        end
                    endcase
                end

                S_M1_T4: begin
                    // 単一サイクル命令のコミット
                    if (opcode[7:6] == 2'b01) begin // LD r, r'
                        reg_wr_en <= 1'b1;
                        reg_wr_data <= reg_src_data;
                    end else if (opcode[7:6] == 2'b00) begin // INC/DEC r
                        alu_in_a <= reg_src_data;
                        reg_wr_en <= 1'b1;
                        reg_dst_sel <= opcode[5:3];
                        reg_wr_data <= alu_out_res;
                        flags_wr_en <= 1'b1;
                    end else if (opcode[7:6] == 2'b10) begin // ADD/SUB A, r
                        reg_src_sel <= 3'd7; // A
                        alu_in_a <= reg_src_data; // A
                        reg_src_sel <= opcode[2:0]; // r
                        alu_in_b <= reg_src_data;
                        reg_wr_en <= 1'b1;
                        reg_dst_sel <= 3'd7; // A
                        reg_wr_data <= alu_out_res;
                        flags_wr_en <= 1'b1;
                    end
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
                    if (opcode[7:6] == 2'b00 && opcode[2:0] == 3'b110) begin // LD r, n
                        reg_wr_en <= 1'b1;
                        reg_wr_data <= imm_low;
                        state <= S_M1_T1;
                    end else if (opcode == 8'hC3) begin // JP nn (low byte received, fetch high)
                        bus_addr <= pc_in;
                        bus_mreq_n <= 1'b0;
                        bus_rd_n <= 1'b0;
                        probe_bus_active <= 1'b1;
                        state <= S_M3_T1_RD;
                    end else if (opcode == 8'h18) begin // JR e (relative jump)
                        pc_load <= 1'b1;
                        // signed 8-bit offset
                        pc_new <= pc_in + {{8{imm_low[7]}}, imm_low};
                        state <= S_M1_T1;
                    end else begin
                        state <= S_M1_T1;
                    end
                end

                S_M3_T1_RD: begin
                    // JP nn の上位バイト受信
                    pc_load <= 1'b1;
                    pc_new <= {bus_din, imm_low};
                    bus_rd_n <= 1'b1;
                    bus_mreq_n <= 1'b1;
                    state <= S_M1_T1;
                end

                S_HALT: begin
                    // HALT 待機
                    probe_bus_active <= 1'b0;
                end

                default: state <= S_M1_T1;
            endcase
        end
    end

endmodule
