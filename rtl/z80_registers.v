// @intent:responsibility Z80 レジスタファイル（メイン、裏レジスタ、IX, IY, SP, PC）の保持
// @intent:undo-snapshot 外部からの直接状態復元（restore_en）および常時プローブ公開

module z80_registers (
    input  wire        clk,
    input  wire        rst_n,

    // レジスタ読出ポート
    input  wire [2:0]  reg_src_sel, // 0:B, 1:C, 2:D, 3:E, 4:H, 5:L, 6:(HL)/None, 7:A
    output reg  [7:0]  reg_src_data,

    // レジスタ書込ポート
    input  wire        reg_wr_en,
    input  wire [2:0]  reg_dst_sel,
    input  wire [7:0]  reg_wr_data,

    // 16-bit ペア書込ポート
    input  wire        pair_wr_en,
    input  wire [1:0]  pair_sel,    // 0:BC, 1:DE, 2:HL, 3:SP / AF
    input  wire [15:0] pair_wr_data,
    input  wire        pair_is_af,  // 1: AFペアへの書込

    // PC 制御
    input  wire        pc_inc,
    input  wire        pc_load,
    input  wire [15:0] pc_new,
    output wire [15:0] pc_out,

    // 交換命令制御
    input  wire        ex_de_hl,
    input  wire        ex_af_af_alt,
    input  wire        exx,

    // フラグ書込
    input  wire        flags_wr_en,
    input  wire [7:0]  flags_in,
    output wire [7:0]  flags_out,

    // タイムトラベル（Undo 復元用）ポート
    input  wire        restore_en,
    input  wire [15:0] restore_pc,
    input  wire [15:0] restore_af,
    input  wire [15:0] restore_bc,
    input  wire [15:0] restore_de,
    input  wire [15:0] restore_hl,
    input  wire [15:0] restore_sp,
    input  wire [15:0] restore_ix,
    input  wire [15:0] restore_iy,

    // UI プローブ出力 (全レジスタ常時可視化)
    output wire [15:0] probe_af,
    output wire [15:0] probe_bc,
    output wire [15:0] probe_de,
    output wire [15:0] probe_hl,
    output wire [15:0] probe_af_alt,
    output wire [15:0] probe_bc_alt,
    output wire [15:0] probe_de_alt,
    output wire [15:0] probe_hl_alt,
    output wire [15:0] probe_ix,
    output wire [15:0] probe_iy,
    output wire [15:0] probe_sp
);

    // メインレジスタ
    reg [7:0] r_a, r_f;
    reg [7:0] r_b, r_c;
    reg [7:0] r_d, r_e;
    reg [7:0] r_h, r_l;

    // 裏レジスタ
    reg [7:0] r_a_alt, r_f_alt;
    reg [7:0] r_b_alt, r_c_alt;
    reg [7:0] r_d_alt, r_e_alt;
    reg [7:0] r_h_alt, r_l_alt;

    // インデックス & ポインタ
    reg [15:0] r_ix, r_iy;
    reg [15:0] r_sp;
    reg [15:0] r_pc;

    assign pc_out    = r_pc;
    assign flags_out = r_f;

    // プローブ出力バインド
    assign probe_af     = {r_a, r_f};
    assign probe_bc     = {r_b, r_c};
    assign probe_de     = {r_d, r_e};
    assign probe_hl     = {r_h, r_l};
    assign probe_af_alt = {r_a_alt, r_f_alt};
    assign probe_bc_alt = {r_b_alt, r_c_alt};
    assign probe_de_alt = {r_d_alt, r_e_alt};
    assign probe_hl_alt = {r_h_alt, r_l_alt};
    assign probe_ix     = r_ix;
    assign probe_iy     = r_iy;
    assign probe_sp     = r_sp;

    // 8-bit ソースレジスタ読出 MUX
    always @(*) begin
        case (reg_src_sel)
            3'd0: reg_src_data = r_b;
            3'd1: reg_src_data = r_c;
            3'd2: reg_src_data = r_d;
            3'd3: reg_src_data = r_e;
            3'd4: reg_src_data = r_h;
            3'd5: reg_src_data = r_l;
            3'd6: reg_src_data = 8'h00; // (HL) は外部メモリアクセスで処理
            3'd7: reg_src_data = r_a;
        endcase
    end

    // レジスタ更新 FSM
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            r_a <= 8'h00; r_f <= 8'h00;
            r_b <= 8'h00; r_c <= 8'h00;
            r_d <= 8'h00; r_e <= 8'h00;
            r_h <= 8'h00; r_l <= 8'h00;
            r_a_alt <= 8'h00; r_f_alt <= 8'h00;
            r_b_alt <= 8'h00; r_c_alt <= 8'h00;
            r_d_alt <= 8'h00; r_e_alt <= 8'h00;
            r_h_alt <= 8'h00; r_l_alt <= 8'h00;
            r_ix <= 16'h0000;
            r_iy <= 16'h0000;
            r_sp <= 16'h0000;
            r_pc <= 16'h0000;
        end else if (restore_en) begin
            // タイムトラベル（過去状態の即時直接注入）
            r_pc <= restore_pc;
            r_a  <= restore_af[15:8]; r_f  <= restore_af[7:0];
            r_b  <= restore_bc[15:8]; r_c  <= restore_bc[7:0];
            r_d  <= restore_de[15:8]; r_e  <= restore_de[7:0];
            r_h  <= restore_hl[15:8]; r_l  <= restore_hl[7:0];
            r_sp <= restore_sp;
            r_ix <= restore_ix;
            r_iy <= restore_iy;
        end else begin
            // 1. PC 更新
            if (pc_load) begin
                r_pc <= pc_new;
            end else if (pc_inc) begin
                r_pc <= r_pc + 16'd1;
            end

            // 2. フラグ更新
            if (flags_wr_en) begin
                r_f <= flags_in;
            end

            // 3. レジスタ交換命令
            if (ex_de_hl) begin
                r_d <= r_h; r_e <= r_l;
                r_h <= r_d; r_l <= r_e;
            end
            if (ex_af_af_alt) begin
                r_a <= r_a_alt; r_f <= r_f_alt;
                r_a_alt <= r_a; r_f_alt <= r_f;
            end
            if (exx) begin
                r_b <= r_b_alt; r_c <= r_c_alt;
                r_d <= r_d_alt; r_e <= r_e_alt;
                r_h <= r_h_alt; r_l <= r_l_alt;
                r_b_alt <= r_b; r_c_alt <= r_c;
                r_d_alt <= r_d; r_e_alt <= r_e;
                r_h_alt <= r_h; r_l_alt <= r_l;
            end

            // 4. 8-bit 書込
            if (reg_wr_en) begin
                case (reg_dst_sel)
                    3'd0: r_b <= reg_wr_data;
                    3'd1: r_c <= reg_wr_data;
                    3'd2: r_d <= reg_wr_data;
                    3'd3: r_e <= reg_wr_data;
                    3'd4: r_h <= reg_wr_data;
                    3'd5: r_l <= reg_wr_data;
                    3'd7: r_a <= reg_wr_data;
                    default: ;
                endcase
            end

            // 5. 16-bit 書込
            if (pair_wr_en) begin
                if (pair_is_af) begin
                    r_a <= pair_wr_data[15:8];
                    r_f <= pair_wr_data[7:0];
                end else begin
                    case (pair_sel)
                        2'd0: begin r_b <= pair_wr_data[15:8]; r_c <= pair_wr_data[7:0]; end
                        2'd1: begin r_d <= pair_wr_data[15:8]; r_e <= pair_wr_data[7:0]; end
                        2'd2: begin r_h <= pair_wr_data[15:8]; r_l <= pair_wr_data[7:0]; end
                        2'd3: begin r_sp <= pair_wr_data; end
                    endcase
                end
            end
        end
    end

endmodule
