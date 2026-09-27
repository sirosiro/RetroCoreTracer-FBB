// @intent:responsibility Z80 CPU トップモジュール
// @intent:observability Bus Glow / テレメトリ観測用プローブおよびタイムトラベル復元ポートの完全統合

module z80_top (
    input  wire        clk,
    input  wire        rst_n,

    // 外部 Z80 バスインターフェース
    output wire [15:0] addr,
    input  wire [7:0]  din,
    output wire [7:0]  dout,
    output wire        mreq_n,
    output wire        iorq_n,
    output wire        rd_n,
    output wire        wr_n,
    output wire        m1_n,

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

    // UI 観測用プローブ端子 (Bus Glow & Inspector)
    output wire [15:0] probe_pc,
    output wire [7:0]  probe_opcode,
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
    output wire [7:0]  probe_flags,
    output wire        probe_bus_active,
    output wire        halted
);

    // 内部相互接続ワイヤ
    wire [15:0] pc_wire;
    wire        pc_inc;
    wire        pc_load;
    wire [15:0] pc_new;

    wire [2:0]  reg_src_sel;
    wire [7:0]  reg_src_data;
    wire        reg_wr_en;
    wire [2:0]  reg_dst_sel;
    wire [7:0]  reg_wr_data;

    wire        pair_wr_en;
    wire [1:0]  pair_sel;
    wire [15:0] pair_wr_data;
    wire        pair_is_af;

    wire        ex_de_hl;
    wire        ex_af_af_alt;
    wire        exx;

    wire [3:0]  alu_op;
    wire [7:0]  alu_in_a;
    wire [7:0]  alu_in_b;
    wire [7:0]  alu_out_res;
    wire [7:0]  alu_out_f;
    wire        flags_wr_en;
    wire [7:0]  flags_wire;

    assign probe_pc    = pc_wire;
    assign probe_flags = flags_wire;

    // 1. レジスタファイル
    z80_registers u_regs (
        .clk(clk),
        .rst_n(rst_n),
        .reg_src_sel(reg_src_sel),
        .reg_src_data(reg_src_data),
        .reg_wr_en(reg_wr_en),
        .reg_dst_sel(reg_dst_sel),
        .reg_wr_data(reg_wr_data),
        .pair_wr_en(pair_wr_en),
        .pair_sel(pair_sel),
        .pair_wr_data(pair_wr_data),
        .pair_is_af(pair_is_af),
        .pc_inc(pc_inc),
        .pc_load(pc_load),
        .pc_new(pc_new),
        .pc_out(pc_wire),
        .ex_de_hl(ex_de_hl),
        .ex_af_af_alt(ex_af_af_alt),
        .exx(exx),
        .flags_wr_en(flags_wr_en),
        .flags_in(alu_out_f),
        .flags_out(flags_wire),
        .restore_en(restore_en),
        .restore_pc(restore_pc),
        .restore_af(restore_af),
        .restore_bc(restore_bc),
        .restore_de(restore_de),
        .restore_hl(restore_hl),
        .restore_sp(restore_sp),
        .restore_ix(restore_ix),
        .restore_iy(restore_iy),
        .probe_af(probe_af),
        .probe_bc(probe_bc),
        .probe_de(probe_de),
        .probe_hl(probe_hl),
        .probe_af_alt(probe_af_alt),
        .probe_bc_alt(probe_bc_alt),
        .probe_de_alt(probe_de_alt),
        .probe_hl_alt(probe_hl_alt),
        .probe_ix(probe_ix),
        .probe_iy(probe_iy),
        .probe_sp(probe_sp)
    );

    // 2. 算術論理演算ユニット (ALU)
    z80_alu u_alu (
        .alu_op(alu_op),
        .in_a(alu_in_a),
        .in_b(alu_in_b),
        .in_f(flags_wire),
        .out_res(alu_out_res),
        .out_f(alu_out_f)
    );

    // 3. 命令制御 & バスステートマシン
    z80_control u_ctrl (
        .clk(clk),
        .rst_n(rst_n),
        .bus_addr(addr),
        .bus_din(din),
        .bus_dout(dout),
        .bus_mreq_n(mreq_n),
        .bus_iorq_n(iorq_n),
        .bus_rd_n(rd_n),
        .bus_wr_n(wr_n),
        .bus_m1_n(m1_n),
        .pc_in(pc_wire),
        .pc_inc(pc_inc),
        .pc_load(pc_load),
        .pc_new(pc_new),
        .reg_src_sel(reg_src_sel),
        .reg_src_data(reg_src_data),
        .reg_wr_en(reg_wr_en),
        .reg_dst_sel(reg_dst_sel),
        .reg_wr_data(reg_wr_data),
        .pair_wr_en(pair_wr_en),
        .pair_sel(pair_sel),
        .pair_wr_data(pair_wr_data),
        .pair_is_af(pair_is_af),
        .ex_de_hl(ex_de_hl),
        .ex_af_af_alt(ex_af_af_alt),
        .exx(exx),
        .alu_op(alu_op),
        .alu_in_a(alu_in_a),
        .alu_in_b(alu_in_b),
        .alu_out_res(alu_out_res),
        .flags_wr_en(flags_wr_en),
        .probe_opcode(probe_opcode),
        .probe_bus_active(probe_bus_active),
        .halted(halted)
    );

endmodule
