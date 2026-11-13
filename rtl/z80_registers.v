// @intent:responsibility Z80 レジスタファイル（メイン、裏レジスタ、IX, IY, SP, PC）の保持
// @intent:undo-snapshot 外部からの直接状態復元（restore_en）および常時プローブ公開
// @intent:direct-wires デコード・ALU パイプライン直結ワイヤ（acc_out, hl_out, bc_out, de_out, sp_out）

module z80_registers (
    input  wire        clk,
    input  wire        rst_n,

    // レジスタ読出ポート
    input  wire [1:0]  index_mode,  // 0: none, 1: IX, 2: IY
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

    // SP 直接書込ポート (スタック PUSH/POP/CALL/RET 独立制御用)
    input  wire        sp_wr_en,
    input  wire [15:0] sp_new,

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

    // 直結参照ワイヤ（パイプライン競合解消用）
    output wire [7:0]  acc_out,
    output wire [15:0] hl_out,
    output wire [15:0] bc_out,
    output wire [15:0] de_out,
    output wire [15:0] sp_out,
    output wire [15:0] ix_out,
    output wire [15:0] iy_out,

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
    input  wire [15:0] restore_af_alt,
    input  wire [15:0] restore_bc_alt,
    input  wire [15:0] restore_de_alt,
    input  wire [15:0] restore_hl_alt,

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
    output wire [15:0] probe_sp,

    // Phase 5 ブロック転送・検索制御
    input  wire        block_trans_en,
    input  wire        block_trans_dec,
    input  wire        block_search_en,
    input  wire        block_search_dec,

    // 特殊レジスタ制御 (I, R, IFF, IM)
    input  wire        i_wr_en,
    input  wire [7:0]  i_wr_data,
    output wire [7:0]  i_out,

    input  wire        r_wr_en,
    input  wire [7:0]  r_wr_data,
    output wire [7:0]  r_out,

    input  wire        im_wr_en,
    input  wire [1:0]  im_wr_data,

    input  wire        iff_wr_en,
    input  wire        iff1_val,
    input  wire        iff2_val,
    output wire        iff2_out,

    // 特殊レジスタプローブ
    output wire [7:0]  probe_i,
    output wire [7:0]  probe_r,
    output wire [1:0]  probe_im,
    output wire        probe_iff1,
    output wire        probe_iff2
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

    // 特殊レジスタ (Phase 5)
    reg [7:0]  r_i, r_r;
    reg        r_iff1, r_iff2;
    reg [1:0]  r_im;

    assign pc_out    = r_pc;
    assign flags_out = r_f;

    // 直結参照ワイヤ
    assign acc_out = r_a;
    assign hl_out  = {r_h, r_l};
    assign bc_out  = {r_b, r_c};
    assign de_out  = {r_d, r_e};
    assign sp_out  = r_sp;
    assign ix_out  = r_ix;
    assign iy_out  = r_iy;

    // 特殊レジスタ参照
    assign i_out    = r_i;
    assign r_out    = r_r;
    assign iff2_out = r_iff2;

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
    assign probe_i      = r_i;
    assign probe_r      = r_r;
    assign probe_im     = r_im;
    assign probe_iff1   = r_iff1;
    assign probe_iff2   = r_iff2;

    // 8-bit ソースレジスタ読出 MUX
    always @(*) begin
        case (reg_src_sel)
            3'd0: reg_src_data = r_b;
            3'd1: reg_src_data = r_c;
            3'd2: reg_src_data = r_d;
            3'd3: reg_src_data = r_e;
            3'd4: reg_src_data = (index_mode == 2'd1) ? r_ix[15:8] : (index_mode == 2'd2) ? r_iy[15:8] : r_h;
            3'd5: reg_src_data = (index_mode == 2'd1) ? r_ix[7:0]  : (index_mode == 2'd2) ? r_iy[7:0]  : r_l;
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
            r_i  <= 8'h00;
            r_r  <= 8'h00;
            r_iff1 <= 1'b0;
            r_iff2 <= 1'b0;
            r_im <= 2'b00;
        end else if (restore_en) begin
            // タイムトラベル（過去状態の即時直接注入）
            r_pc <= restore_pc;
            r_a  <= restore_af[15:8]; r_f  <= restore_af[7:0];
            r_b  <= restore_bc[15:8]; r_c  <= restore_bc[7:0];
            r_d  <= restore_de[15:8]; r_e  <= restore_de[7:0];
            r_h  <= restore_hl[15:8]; r_l  <= restore_hl[7:0];
            r_a_alt <= restore_af_alt[15:8]; r_f_alt <= restore_af_alt[7:0];
            r_b_alt <= restore_bc_alt[15:8]; r_c_alt <= restore_bc_alt[7:0];
            r_d_alt <= restore_de_alt[15:8]; r_e_alt <= restore_de_alt[7:0];
            r_h_alt <= restore_hl_alt[15:8]; r_l_alt <= restore_hl_alt[7:0];
            r_sp <= restore_sp;
            r_ix <= restore_ix;
            r_iy <= restore_iy;
            r_i  <= 8'h00;
            r_r  <= 8'h00;
            r_iff1 <= 1'b0;
            r_iff2 <= 1'b0;
            r_im <= 2'b00;
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

            // 4. SP 更新 (直接ポート優先)
            if (sp_wr_en) begin
                r_sp <= sp_new;
            end

            // 5. 8-bit 書込
            if (reg_wr_en) begin
                case (reg_dst_sel)
                    3'd0: r_b <= reg_wr_data;
                    3'd1: r_c <= reg_wr_data;
                    3'd2: r_d <= reg_wr_data;
                    3'd3: r_e <= reg_wr_data;
                    3'd4: begin
                        if (index_mode == 2'd1) r_ix[15:8] <= reg_wr_data;
                        else if (index_mode == 2'd2) r_iy[15:8] <= reg_wr_data;
                        else r_h <= reg_wr_data;
                    end
                    3'd5: begin
                        if (index_mode == 2'd1) r_ix[7:0] <= reg_wr_data;
                        else if (index_mode == 2'd2) r_iy[7:0] <= reg_wr_data;
                        else r_l <= reg_wr_data;
                    end
                    3'd7: r_a <= reg_wr_data;
                    default: ;
                endcase
            end

            // 6. 16-bit 書込
            if (pair_wr_en) begin
                if (pair_is_af) begin
                    r_a <= pair_wr_data[15:8];
                    r_f <= pair_wr_data[7:0];
                end else begin
                    case (pair_sel)
                        2'd0: begin r_b <= pair_wr_data[15:8]; r_c <= pair_wr_data[7:0]; end
                        2'd1: begin r_d <= pair_wr_data[15:8]; r_e <= pair_wr_data[7:0]; end
                        2'd2: begin
                            if (index_mode == 2'd1) r_ix <= pair_wr_data;
                            else if (index_mode == 2'd2) r_iy <= pair_wr_data;
                            else begin r_h <= pair_wr_data[15:8]; r_l <= pair_wr_data[7:0]; end
                        end
                        2'd3: begin if (!sp_wr_en) r_sp <= pair_wr_data; end
                    endcase
                end
            end

            // 7. ブロック転送 (LDI/LDIR/LDD/LDDR)
            if (block_trans_en) begin
                if (!block_trans_dec) begin
                    {r_h, r_l} <= {r_h, r_l} + 16'd1;
                    {r_d, r_e} <= {r_d, r_e} + 16'd1;
                end else begin
                    {r_h, r_l} <= {r_h, r_l} - 16'd1;
                    {r_d, r_e} <= {r_d, r_e} - 16'd1;
                end
                {r_b, r_c} <= {r_b, r_c} - 16'd1;
            end

            // 8. ブロック検索 (CPI/CPIR/CPD/CPDR)
            if (block_search_en) begin
                if (!block_search_dec) begin
                    {r_h, r_l} <= {r_h, r_l} + 16'd1;
                end else begin
                    {r_h, r_l} <= {r_h, r_l} - 16'd1;
                end
                {r_b, r_c} <= {r_b, r_c} - 16'd1;
            end

            // 9. 特殊レジスタ更新 (I, R, IFF, IM)
            if (pc_inc) r_r[6:0] <= r_r[6:0] + 7'd1;
            if (i_wr_en) r_i <= i_wr_data;
            if (r_wr_en) r_r <= r_wr_data;
            if (im_wr_en) r_im <= im_wr_data;
            if (iff_wr_en) begin
                r_iff1 <= iff1_val;
                r_iff2 <= iff2_val;
            end
        end
    end

endmodule
