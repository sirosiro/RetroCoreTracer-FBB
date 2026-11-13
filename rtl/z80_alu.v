// @intent:responsibility 8-bit / 16-bit 算術論理演算（ALU）およびフラグ（S, Z, Y, H, X, PV, N, C）の完全計算
// @intent:cleanroom 完全な自作 Verilog 実装（Pure-Intent Mode）

module z80_alu (
    input  wire [4:0] alu_op,      // 0:ADD, 1:ADC, 2:SUB, 3:SBC, 4:AND, 5:XOR, 6:OR, 7:CP, 8:INC, 9:DEC
                                   // 10:DAA, 11:CPL, 12:NEG, 13:CCF, 14:SCF, 15:RLCA, 16:RRCA, 17:RLA, 18:RRA
    input  wire [7:0] in_a,        // オペランド A (通常 A レジスタまたは r)
    input  wire [7:0] in_b,        // オペランド B
    input  wire [7:0] in_f,        // 直前のフラグレジスタ (キャリー入力用)
    output reg  [7:0] out_res,     // 演算結果
    output reg  [7:0] out_f        // 演算後のフラグレジスタ (S, Z, Y, H, X, PV, N, C)
);

    wire carry_in = in_f[0]; // C flag

    // 内部演算用 9-bit ワイヤ
    reg [8:0] sum9;
    reg half_carry;
    reg overflow;
    reg [7:0] res;

    wire half_carry_add = ({1'b0, in_a[3:0]} + {1'b0, in_b[3:0]}) >= 5'd16;
    wire half_carry_adc = ({1'b0, in_a[3:0]} + {1'b0, in_b[3:0]} + {4'd0, carry_in}) >= 5'd16;

    // パリティ計算関数 (偶数個の 1 で 1, 奇数個の 1 で 0)
    function parity8;
        input [7:0] d;
        begin
            parity8 = ~(d[0]^d[1]^d[2]^d[3]^d[4]^d[5]^d[6]^d[7]);
        end
    endfunction

    // DAA 演算用一時変数
    reg [7:0] daa_sum;
    reg daa_c;
    reg daa_h;
    reg [7:0] daa_corr;

    always @(*) begin
        sum9 = 9'h000;
        half_carry = 1'b0;
        overflow = 1'b0;
        res = 8'h00;
        out_f = in_f;
        daa_sum = 8'h00;
        daa_c = 1'b0;
        daa_h = 1'b0;
        daa_corr = 8'h00;

        case (alu_op)
            5'd0: begin // ADD A, s
                sum9 = {1'b0, in_a} + {1'b0, in_b};
                res  = sum9[7:0];
                half_carry = half_carry_add;
                overflow   = ((in_a[7] == in_b[7]) && (res[7] != in_a[7]));
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b0, sum9[8]};
            end

            5'd1: begin // ADC A, s
                sum9 = {1'b0, in_a} + {1'b0, in_b} + {8'h00, carry_in};
                res  = sum9[7:0];
                half_carry = half_carry_adc;
                overflow   = ((in_a[7] == in_b[7]) && (res[7] != in_a[7]));
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b0, sum9[8]};
            end

            5'd2: begin // SUB A, s
                sum9 = {1'b0, in_a} - {1'b0, in_b};
                res  = sum9[7:0];
                half_carry = (in_a[3:0] < in_b[3:0]);
                overflow   = ((in_a[7] != in_b[7]) && (res[7] != in_a[7]));
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b1, sum9[8]};
            end

            5'd3: begin // SBC A, s
                sum9 = {1'b0, in_a} - {1'b0, in_b} - {8'h00, carry_in};
                res  = sum9[7:0];
                half_carry = (in_a[3:0] < (in_b[3:0] + {3'b0, carry_in}));
                overflow   = ((in_a[7] != in_b[7]) && (res[7] != in_a[7]));
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b1, sum9[8]};
            end

            5'd4: begin // AND s
                res = in_a & in_b;
                out_f = {res[7], (res == 8'h00), res[5], 1'b1, res[3], parity8(res), 1'b0, 1'b0};
            end

            5'd5: begin // XOR s
                res = in_a ^ in_b;
                out_f = {res[7], (res == 8'h00), res[5], 1'b0, res[3], parity8(res), 1'b0, 1'b0};
            end

            5'd6: begin // OR s
                res = in_a | in_b;
                out_f = {res[7], (res == 8'h00), res[5], 1'b0, res[3], parity8(res), 1'b0, 1'b0};
            end

            5'd7: begin // CP s (Compare: A - in_b, but keep A unchanged)
                sum9 = {1'b0, in_a} - {1'b0, in_b};
                res  = in_a; // A stays unchanged
                half_carry = (in_a[3:0] < in_b[3:0]);
                overflow   = ((in_a[7] != in_b[7]) && (sum9[7] != in_a[7]));
                out_f = {sum9[7], (sum9[7:0] == 8'h00), in_b[5], half_carry, in_b[3], overflow, 1'b1, sum9[8]};
            end

            5'd8: begin // INC s
                res = in_a + 8'd1;
                half_carry = (in_a[3:0] == 4'hF);
                overflow   = (in_a == 8'h7F);
                // INC preserves Carry flag!
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b0, in_f[0]};
            end

            5'd9: begin // DEC s
                res = in_a - 8'd1;
                half_carry = (in_a[3:0] == 4'h0);
                overflow   = (in_a == 8'h80);
                // DEC preserves Carry flag!
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b1, in_f[0]};
            end

            5'd10: begin // DAA (Decimal Adjust Accumulator)
                daa_corr = 8'h00;
                daa_c = in_f[0];
                daa_h = 1'b0;
                if (!in_f[1]) begin // N == 0 (After addition)
                    if (in_f[0] || (in_a > 8'h99)) begin
                        daa_corr = daa_corr | 8'h60;
                        daa_c = 1'b1;
                    end
                    if (in_f[4] || (in_a[3:0] > 4'h9)) begin
                        daa_corr = daa_corr | 8'h06;
                    end
                    daa_sum = in_a + daa_corr;
                    daa_h = ((in_a[3:0] + daa_corr[3:0]) > 5'h0F);
                end else begin // N == 1 (After subtraction)
                    if (in_f[0] || (in_a > 8'h99)) begin
                        daa_corr = daa_corr | 8'h60;
                        daa_c = 1'b1;
                    end
                    if (in_f[4] || (in_a[3:0] > 4'h9)) begin
                        daa_corr = daa_corr | 8'h06;
                    end
                    daa_sum = in_a - daa_corr;
                    daa_h = in_f[4] && (in_a[3:0] < 4'h6);
                end
                res = daa_sum;
                out_f = {res[7], (res == 8'h00), res[5], daa_h, res[3], parity8(res), in_f[1], daa_c};
            end

            5'd11: begin // CPL (Complement A)
                res = ~in_a;
                // S, Z, PV, C unchanged, H=1, N=1
                out_f = {in_f[7], in_f[6], res[5], 1'b1, res[3], in_f[2], 1'b1, in_f[0]};
            end

            5'd12: begin // NEG (Negate A: 0 - A)
                sum9 = {1'b0, 8'h00} - {1'b0, in_a};
                res  = sum9[7:0];
                half_carry = (in_a[3:0] != 4'h0);
                overflow   = (in_a == 8'h80);
                out_f = {res[7], (res == 8'h00), res[5], half_carry, res[3], overflow, 1'b1, (in_a != 8'h00)};
            end

            5'd13: begin // CCF (Complement Carry Flag)
                res = in_a;
                // H <= previous C, N <= 0, C <= ~C
                out_f = {in_f[7], in_f[6], res[5], in_f[0], res[3], in_f[2], 1'b0, ~in_f[0]};
            end

            5'd14: begin // SCF (Set Carry Flag)
                res = in_a;
                // H <= 0, N <= 0, C <= 1
                out_f = {in_f[7], in_f[6], res[5], 1'b0, res[3], in_f[2], 1'b0, 1'b1};
            end

            5'd15: begin // RLCA (Rotate Left Circular Accumulator)
                res = {in_a[6:0], in_a[7]};
                out_f = {in_f[7], in_f[6], res[5], 1'b0, res[3], in_f[2], 1'b0, in_a[7]};
            end

            5'd16: begin // RRCA (Rotate Right Circular Accumulator)
                res = {in_a[0], in_a[7:1]};
                out_f = {in_f[7], in_f[6], res[5], 1'b0, res[3], in_f[2], 1'b0, in_a[0]};
            end

            5'd17: begin // RLA (Rotate Left through Carry Accumulator)
                res = {in_a[6:0], in_f[0]};
                out_f = {in_f[7], in_f[6], res[5], 1'b0, res[3], in_f[2], 1'b0, in_a[7]};
            end

            5'd18: begin // RRA (Rotate Right through Carry Accumulator)
                res = {in_f[0], in_a[7:1]};
                out_f = {in_f[7], in_f[6], res[5], 1'b0, res[3], in_f[2], 1'b0, in_a[0]};
            end

            default: begin
                res = in_a;
                out_f = in_f;
            end
        endcase

        out_res = res;
    end

endmodule
